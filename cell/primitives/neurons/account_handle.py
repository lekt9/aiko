#!/usr/bin/env python3
"""account-handle — employee account identity, not developer API keys.

Refuse any payload that carries a secret-shaped key. Emit only an opaque
handle and a session that cites that handle. The OS vault is a designed
gap; this primitive is the Cell membrane that makes the refusal mechanical.
"""
from urllib.parse import urlparse
import hashlib

FORBIDDEN = {
    "token", "api_key", "apikey", "api-key", "password", "passwd", "cookie",
    "cookies", "authorization", "secret", "bearer", "access_token",
    "refresh_token", "session_string", "private_key", "credentials",
    "client_secret", "sessionid",
}


def _walk_keys(value, found):
    if isinstance(value, dict):
        for key, child in value.items():
            found.add(str(key).strip().lower().replace(" ", "_"))
            _walk_keys(child, found)
    elif isinstance(value, list):
        for child in value:
            _walk_keys(child, found)


def refuse_secrets(payload, who):
    keys = set()
    _walk_keys(payload, keys)
    hit = sorted(keys & FORBIDDEN)
    if hit:
        raise ValueError(
            f"{who}: refused raw secret key(s) {hit} — "
            "account credentials are opaque handles, not API keys"
        )


def handle_id(tenant, origin, account_id):
    host = origin
    parsed = urlparse(origin if "://" in origin else "")
    if parsed.netloc:
        host = parsed.netloc
    identity = "\0".join((tenant, host, account_id)).encode("utf-8")
    return "cred:" + hashlib.sha256(identity).hexdigest()[:32]


def run(inputs, ctx):
    account = inputs.get("account") or {}
    if not isinstance(account, dict):
        raise ValueError("account-handle: account must be an object")
    refuse_secrets(account, "account-handle")
    tenant = str(account.get("tenant") or "").strip()
    origin = str(account.get("origin") or "").strip()
    account_id = str(account.get("account_id") or "").strip()
    if not tenant or not origin or not account_id:
        raise ValueError("account-handle: tenant, origin, and account_id are required")
    if account.get("id") is not None:
        raise ValueError("account-handle: caller-supplied credential ids are refused")
    hid = handle_id(tenant, origin, account_id)
    actions = account.get("allowed_actions") or ["observe", "author", "attach"]
    if not isinstance(actions, list) or not all(isinstance(a, str) for a in actions):
        raise ValueError("account-handle: allowed_actions must be a list of strings")
    handle = {
        "id": hid,
        "tenant": tenant,
        "origin": origin,
        "account_id": account_id,
        "allowed_actions": list(actions),
    }
    base = origin if origin.startswith("http") else "https://account.local"
    session = {
        "id": f"acct-{hid.split(':')[1][:8]}" if ":" in hid else f"acct-{hid[:8]}",
        "base_url": base.rstrip("/"),
        "headers": {"X-Aiko-Credential-Handle": hid},
        "cookies": {},
    }
    return {"handle": handle, "session": session}
