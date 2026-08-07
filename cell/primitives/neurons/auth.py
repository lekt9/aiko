#!/usr/bin/env python3
import copy, hashlib
def run(inputs, ctx):
    sess = inputs.get("session") or {}
    creds = inputs.get("credentials") or {}
    out = copy.deepcopy(sess)
    headers = dict(out.get("headers") or {})
    cookies = dict(out.get("cookies") or {})
    if "token" in creds:
        headers["Authorization"] = f"Bearer {creds['token']}"
    elif "api_key" in creds:
        headers["X-API-Key"] = creds["api_key"]
    elif "username" in creds:
        token = hashlib.sha256(f"{creds['username']}:{creds.get('password','')}".encode()).hexdigest()[:16]
        cookies["session"] = token
    else:
        raise ValueError("auth: credentials need one of token | api_key | username+password")
    out["headers"] = headers
    out["cookies"] = cookies
    return {"session": out}
