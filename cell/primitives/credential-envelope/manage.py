#!/usr/bin/env python3
"""Cell boundary for public credential lifecycle operations (never secret input)."""
from __future__ import annotations
import hashlib
import importlib.util
import json
import pathlib
import sys
_spec = importlib.util.spec_from_file_location("aiko_credential_vault", pathlib.Path(__file__).with_name("vault.py"))
_vault = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _vault
_spec.loader.exec_module(_vault)
CredentialEnvelope, OSCredentialVault, VaultRefusal = (_vault.CredentialEnvelope, _vault.OSCredentialVault, _vault.VaultRefusal)

FORBIDDEN = {"secret", "password", "token", "api_key", "apikey", "cookie",
             "authorization", "credentials", "session_string", "secret_b64"}

def _keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield str(key).strip().lower().replace("-", "_")
            yield from _keys(child)
    elif isinstance(value, list):
        for child in value: yield from _keys(child)

def run(inputs, ctx):
    inputs = inputs.get("request") or {}
    if not isinstance(inputs, dict):
        raise VaultRefusal("credential-envelope request must be an object")
    hit = sorted(set(_keys(inputs)) & FORBIDDEN)
    if hit:
        raise VaultRefusal(f"credential-envelope refused raw secret key(s): {hit}")
    op = str(inputs.get("operation") or "").strip()
    handle = str(inputs.get("handle") or "").strip()
    envelope = CredentialEnvelope(OSCredentialVault())
    if op == "inventory":
        result = envelope.inventory(tenant=inputs.get("tenant"))
    elif op == "mfa-handoff":
        result = envelope.mfa_handoff(handle)
    elif op == "revoke":
        result = envelope.revoke(handle)
    elif op == "logout":
        result = envelope.logout(handle)
    else:
        raise VaultRefusal("unsupported public operation; provisioning and rotation require the native secret boundary")
    evidence = {"kind": "os-credential-vault", "operation": op,
                "result_digest": hashlib.sha256(json.dumps(result, sort_keys=True,
                separators=(",", ":")).encode()).hexdigest(), "secret_retained": False}
    return {"result": result, "evidence": evidence}
