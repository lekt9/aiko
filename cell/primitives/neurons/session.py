#!/usr/bin/env python3
import hashlib
def run(inputs, ctx):
    base = inputs.get("base_url","").rstrip("/")
    if not base.startswith("http"):
        raise ValueError(f"session: base_url must be http(s), got {base!r}")
    sid = hashlib.sha256(base.encode()).hexdigest()[:8]
    headers = inputs.get("headers") or {}
    return {"session": {"id": f"sess-{sid}", "base_url": base, "headers": dict(headers), "cookies": {}}}
