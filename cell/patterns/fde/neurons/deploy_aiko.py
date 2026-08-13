#!/usr/bin/env python3
"""deploy-aiko — put Aiko in the seat. Does not install a binary.

The attachment is the employee handoff: role + workflow digest + opaque
handle + least authority. Raw secrets in the handle are refused so a
miswired parent cannot smuggle an API key into the seat.
"""

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


def run(inputs, ctx):
    role = str(inputs.get("role") or "").strip()
    digest = str(inputs.get("digest") or "").strip()
    handle = inputs.get("handle") or {}
    if not role:
        raise ValueError("deploy-aiko: role is required")
    if not digest:
        raise ValueError("deploy-aiko: workflow digest is required")
    if not isinstance(handle, dict):
        raise ValueError("deploy-aiko: handle must be an object")
    keys = set()
    _walk_keys(handle, keys)
    hit = sorted(keys & FORBIDDEN)
    if hit:
        raise ValueError(
            f"deploy-aiko: refused raw secret key(s) {hit} — "
            "Aiko is seated with an account handle, not an API key"
        )
    hid = str(handle.get("id") or "").strip()
    if not hid.startswith("cred:"):
        raise ValueError("deploy-aiko: handle.id must be an opaque cred: handle")
    actions = handle.get("allowed_actions") or ["observe", "author", "attach"]
    attachment = {
        "agent": "aiko",
        "seat": "employee",
        "auth": "account-handle",
        "role": role,
        "workflow_digest": digest,
        "handle_id": hid,
        "tenant": handle.get("tenant"),
        "origin": handle.get("origin"),
        "account_id": handle.get("account_id"),
        "authority": list(actions),
    }
    return {"attachment": attachment}
