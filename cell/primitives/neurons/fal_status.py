#!/usr/bin/env python3
import os, json, urllib.request, urllib.error
def run(inputs, ctx):
    rid = inputs.get("request_id", "")
    model = inputs.get("model", "fal-ai/veo3")
    if rid.startswith("mock-"):
        return {"status": "completed", "video_url": "https://example.com/mock.mp4", "response": {"mock": True}}
    api_key = os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY") or ""
    if not api_key:
        raise RuntimeError("FAL_KEY not set for poll")
    # Queue status
    url = f"https://queue.fal.run/{model}/requests/{rid}/status"
    headers = {"Authorization": f"Key {api_key}"}
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            j = json.loads(resp.read().decode() or "{}")
            status = j.get("status","unknown")
            video_url = ""
            # fal returns video url in response or logs
            if isinstance(j.get("response"), dict):
                video_url = j["response"].get("video",{}).get("url","") or j["response"].get("url","") or ""
            if not video_url:
                # Try result endpoint
                if status == "COMPLETED":
                    rurl = f"https://queue.fal.run/{model}/requests/{rid}"
                    r2 = urllib.request.Request(rurl, headers=headers, method="GET")
                    with urllib.request.urlopen(r2, timeout=15) as resp2:
                        j2 = json.loads(resp2.read().decode() or "{}")
                        video_url = j2.get("video",{}).get("url","") or j2.get("url","") or j2.get("response",{}).get("video",{}).get("url","") or ""
                        j = j2
            return {"status": status, "video_url": video_url, "response": j}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"fal-status -> {e.code} {e.reason}: {e.read().decode()[:600]}") from e
