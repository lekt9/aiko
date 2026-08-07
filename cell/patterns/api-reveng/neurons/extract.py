#!/usr/bin/env python3
def run(inputs, ctx):
    resp = inputs.get("response", {})
    body = resp.get("body")
    if isinstance(body, dict) and "error" in body:
        return {"data": {"error": body["error"]}}
    return {"data": body if isinstance(body, dict) else {"raw": body}}
