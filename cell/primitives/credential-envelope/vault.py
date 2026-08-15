#!/usr/bin/env python3
"""Opaque credential capabilities over an operating-system credential store.

The secret and the inventory are both vault records.  There is deliberately no
file backend: inability to reach the OS store is a refusal, not permission to
write credentials beside workflow state.  ``SyntheticVault`` exists solely to
produce hermetic evidence; production construction always chooses
``OSCredentialVault``.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Protocol
from urllib.parse import urlparse

HANDLE_RE = re.compile(r"^cred:[0-9a-f]{32}$")
SERVICE = "org.aiko.credential-envelope.v1"
INDEX = "__inventory__"


class VaultRefusal(RuntimeError):
    """A closed boundary: the requested authority was not proven."""


class Vault(Protocol):
    def read(self, account: str) -> bytes | None: ...
    def write(self, account: str, value: bytes) -> None: ...
    def delete(self, account: str) -> None: ...


class OSCredentialVault:
    """Keychain (macOS) / Secret Service (Linux), with no fallback."""

    def __init__(self, service: str = SERVICE):
        self.service = service
        system = platform.system()
        if system == "Darwin" and shutil.which("security"):
            self.kind = "keychain"
        elif system == "Linux" and shutil.which("secret-tool"):
            self.kind = "secret-service"
        else:
            raise VaultRefusal("OS credential vault unavailable; plaintext fallback is forbidden")

    def _run(self, argv: list[str], *, stdin: bytes | None = None, missing_ok: bool = False) -> bytes | None:
        try:
            proc = subprocess.run(argv, input=stdin, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, check=False)
        except OSError as exc:
            raise VaultRefusal(f"OS credential vault invocation failed: {exc}") from exc
        if proc.returncode:
            if missing_ok:
                return None
            # Never reflect stderr: native tools sometimes include credential material.
            raise VaultRefusal(f"OS credential vault refused operation (exit {proc.returncode})")
        return proc.stdout

    def read(self, account: str) -> bytes | None:
        if self.kind == "keychain":
            out = self._run(["security", "find-generic-password", "-s", self.service,
                             "-a", account, "-w"], missing_ok=True)
        else:
            out = self._run(["secret-tool", "lookup", "service", self.service,
                             "account", account], missing_ok=True)
        return None if out is None or not out.strip() else out.rstrip(b"\n")

    def write(self, account: str, value: bytes) -> None:
        if not value:
            raise VaultRefusal("empty credential record refused")
        if self.kind == "keychain":
            # security has no secret-fd option.  argv exposure is bounded to the native
            # destination process; Cell inputs, stdout, files and evidence never see it.
            self._run(["security", "add-generic-password", "-U", "-s", self.service,
                       "-a", account, "-w", value.decode("utf-8")])
        else:
            self._run(["secret-tool", "store", "--label=Aiko credential envelope",
                       "service", self.service, "account", account], stdin=value)

    def delete(self, account: str) -> None:
        if self.kind == "keychain":
            self._run(["security", "delete-generic-password", "-s", self.service,
                       "-a", account], missing_ok=True)
        else:
            self._run(["secret-tool", "clear", "service", self.service,
                       "account", account], missing_ok=True)


class SyntheticVault:
    """In-memory vault used only by gates; it is never selected by production code."""
    synthetic_evidence_only = True

    def __init__(self):
        self._records: dict[str, bytes] = {}

    def read(self, account: str) -> bytes | None:
        value = self._records.get(account)
        return None if value is None else bytes(value)

    def write(self, account: str, value: bytes) -> None:
        self._records[account] = bytes(value)

    def delete(self, account: str) -> None:
        self._records.pop(account, None)


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _scope(tenant: str, origin: str, account_id: str) -> dict[str, str]:
    tenant, origin, account_id = (str(x).strip() for x in (tenant, origin, account_id))
    parsed = urlparse(origin)
    if not tenant or not account_id or parsed.scheme not in ("https", "http") or not parsed.netloc:
        raise VaultRefusal("tenant, absolute http(s) origin, and account_id are required")
    return {"tenant": tenant, "origin": f"{parsed.scheme}://{parsed.netloc}", "account_id": account_id}


class CredentialEnvelope:
    def __init__(self, vault: Vault, *, now: Callable[[], int] | None = None,
                 id_factory: Callable[[], str] | None = None):
        self.vault = vault
        self.now = now or (lambda: int(time.time()))
        self.id_factory = id_factory or (lambda: "cred:" + secrets.token_hex(16))

    def _load_index(self) -> list[str]:
        raw = self.vault.read(INDEX)
        if raw is None:
            return []
        try:
            value = json.loads(raw)
        except Exception as exc:
            raise VaultRefusal("credential inventory is corrupt") from exc
        if not isinstance(value, list) or not all(HANDLE_RE.fullmatch(x or "") for x in value):
            raise VaultRefusal("credential inventory is corrupt")
        return sorted(set(value))

    def _save_index(self, handles: Iterable[str]) -> None:
        self.vault.write(INDEX, _canonical(sorted(set(handles))))

    def _record(self, handle: str) -> dict:
        if not HANDLE_RE.fullmatch(str(handle)):
            raise VaultRefusal("malformed opaque credential handle")
        raw = self.vault.read(handle)
        if raw is None:
            raise VaultRefusal("unknown or logged-out credential handle")
        try:
            rec = json.loads(raw)
        except Exception as exc:
            raise VaultRefusal("credential record is corrupt") from exc
        if rec.get("handle") != handle or "secret_b64" not in rec:
            raise VaultRefusal("credential record is corrupt")
        return rec

    def _put(self, rec: dict) -> None:
        self.vault.write(rec["handle"], _canonical(rec))

    @staticmethod
    def _public(rec: dict) -> dict:
        # An allow-list prevents a newly-added secret field leaking into evidence.
        return {k: rec[k] for k in ("handle", "tenant", "origin", "account_id",
                                    "allowed_actions", "expires_at", "mfa", "status",
                                    "generation", "created_at", "rotated_at") if k in rec}

    def enroll(self, *, tenant: str, origin: str, account_id: str, secret: bytes,
               allowed_actions: Iterable[str], expires_at: int, mfa: str = "satisfied") -> dict:
        scope = _scope(tenant, origin, account_id)
        actions = sorted(set(str(x).strip() for x in allowed_actions if str(x).strip()))
        now = self.now()
        if not secret or not actions:
            raise VaultRefusal("non-empty credential and allowed_actions are required")
        if int(expires_at) <= now:
            raise VaultRefusal("expired credential refused")
        if mfa not in ("required", "satisfied"):
            raise VaultRefusal("MFA state must be required or satisfied")
        handle = self.id_factory()
        if not HANDLE_RE.fullmatch(handle) or self.vault.read(handle) is not None:
            raise VaultRefusal("vault did not issue a fresh opaque handle")
        rec = {"handle": handle, **scope, "allowed_actions": actions,
               "expires_at": int(expires_at), "mfa": mfa, "status": "active",
               "generation": 1, "created_at": now,
               "secret_b64": base64.b64encode(bytes(secret)).decode("ascii")}
        self._put(rec)
        index = self._load_index()
        index.append(handle)
        self._save_index(index)
        return self._public(rec)

    def inventory(self, *, tenant: str | None = None) -> list[dict]:
        result = []
        for handle in self._load_index():
            rec = self._record(handle)
            if tenant is None or rec.get("tenant") == tenant:
                result.append(self._public(rec))
        return result

    def authorize(self, handle: str, *, tenant: str, origin: str, account_id: str,
                  action: str) -> bytes:
        requested = _scope(tenant, origin, account_id)
        rec = self._record(handle)
        if rec.get("status") != "active":
            raise VaultRefusal("credential is revoked")
        if any(rec.get(k) != requested[k] for k in requested):
            raise VaultRefusal("credential scope mismatch")
        if action not in rec.get("allowed_actions", []):
            raise VaultRefusal("credential action is outside least authority")
        if int(rec.get("expires_at", 0)) <= self.now():
            raise VaultRefusal("credential expired; authorization remains pending")
        if rec.get("mfa") != "satisfied":
            raise VaultRefusal("MFA handoff required; authorization remains pending")
        try:
            return base64.b64decode(rec["secret_b64"], validate=True)
        except Exception as exc:
            raise VaultRefusal("credential record is corrupt") from exc

    def mfa_handoff(self, handle: str) -> dict:
        rec = self._record(handle)
        if rec.get("status") != "active":
            raise VaultRefusal("credential is revoked")
        # This is a handoff request, never a fabricated MFA completion.
        rec["mfa"] = "required"
        self._put(rec)
        nonce = hashlib.sha256((handle + ":" + str(rec["generation"])).encode()).hexdigest()[:16]
        return {"handle": handle, "state": "pending", "challenge": "mfa:" + nonce}

    def complete_mfa(self, handle: str, *, approved: bool) -> dict:
        rec = self._record(handle)
        if not approved or rec.get("mfa") != "required" or rec.get("status") != "active":
            raise VaultRefusal("MFA approval not proven")
        rec["mfa"] = "satisfied"
        self._put(rec)
        return self._public(rec)

    def revoke(self, handle: str) -> dict:
        rec = self._record(handle)
        rec["status"] = "revoked"
        self._put(rec)
        return self._public(rec)

    def rotate(self, handle: str, *, secret: bytes, expires_at: int,
               allowed_actions: Iterable[str] | None = None) -> dict:
        rec = self._record(handle)
        if rec.get("status") != "active" or not secret or int(expires_at) <= self.now():
            raise VaultRefusal("rotation refused for revoked, empty, or expired credential")
        old = set(rec.get("allowed_actions", []))
        new = old if allowed_actions is None else set(allowed_actions)
        if not new or not new.issubset(old):
            raise VaultRefusal("rotation may narrow but never widen handle authority")
        rec.update(secret_b64=base64.b64encode(bytes(secret)).decode("ascii"),
                   expires_at=int(expires_at), allowed_actions=sorted(new),
                   generation=int(rec.get("generation", 0)) + 1,
                   rotated_at=self.now(), mfa="required")
        self._put(rec)
        return self._public(rec)

    def logout(self, handle: str) -> dict:
        rec = self._record(handle)
        public = self._public(rec)
        self.vault.delete(handle)
        self._save_index(h for h in self._load_index() if h != handle)
        return {"handle": public["handle"], "status": "logged-out"}
