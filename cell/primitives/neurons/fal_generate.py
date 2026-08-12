#!/usr/bin/env python3
# fal-generate — prompt + model + params -> request_id + status
# Thin: model already knows fal API, so this is just the primitive.
# Uses helpers.render_template-style raw HTTP: no wrapper.
import hashlib, os, json, pathlib, urllib.request, urllib.error

def run(inputs, ctx):
    prompt = inputs.get("prompt", "")
    model = inputs.get("model", "fal-ai/veo3")  # default bifrost
    params = inputs.get("params") or {}
    api_key = os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY") or ""
    if not api_key:
        # Fail-open for offline harness tests: return mock request_id so DAG still fires
        # Real runs require FAL_KEY set; check will show missing key in caps/output.
        return {"request_id": "mock-req-" + hashlib.sha256(prompt.encode()).hexdigest()[:8], "status": "mock", "response": {"mock": True, "reason": "FAL_KEY not set — wire a real key in env"}, "model": model}
    # Build body: prompt goes into params-specific shape
    body = {"prompt": prompt}
    body.update(params)
    # Respect model param
    url = f"https://queue.fal.run/{model}"
    headers = {"Authorization": f"Key {api_key}", "Content-Type": "application/json"}
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            j = json.loads(raw) if raw else {}
            rid = j.get("request_id") or j.get("requestId") or j.get("id") or ""
            return {"request_id": rid or j.get("request_id",""), "status": j.get("status","queued"), "response": j, "model": model}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()[:1000]
        raise RuntimeError(f"fal-generate {model} -> {e.code} {e.reason}: {body_text}") from e
