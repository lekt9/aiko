#!/usr/bin/env python3
def run(inputs, ctx):
    sess = inputs.get("session") or {}
    method = inputs.get("method","GET")
    url = inputs.get("url","")
    extra_headers = inputs.get("headers") or {}
    body = inputs.get("body")
    headers = {}
    headers.update(sess.get("headers") or {})
    headers.update(extra_headers)
    cookies = sess.get("cookies") or {}
    if cookies:
        headers["Cookie"] = "; ".join(f"{k}={v}" for k,v in cookies.items())
    base = (sess.get("base_url") or "").rstrip("/")
    if url.startswith("/"):
        url = base + url
    elif not url.startswith("http"):
        raise ValueError(f"request: url must be absolute or /-relative, got {url!r}")
    import helpers
    try:
        resp = helpers.http_request(method, url, headers=headers, body=body, timeout_ms=inputs.get("timeout_ms", 10000))
    except Exception as e:
        return {"response": {"status": 0, "url": url, "headers": {}, "body": {"error": str(e)}, "cookies": {}}}
    body_out = resp if not (isinstance(resp, dict) and "status" in resp) else resp
    return {"response": {"status": 200, "url": url, "headers": {}, "body": body_out, "cookies": {}}}
