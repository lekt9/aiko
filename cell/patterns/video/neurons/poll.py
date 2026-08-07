#!/usr/bin/env python3
import time, pathlib, sys, os
# Reuse fal-status primitive as a python import for polling loop
# Bitter lesson: raw loop, model already knows it
sys.path.insert(0, str(pathlib.Path(__file__).parents[3] / "primitives/neurons"))
import fal_status as _status
def run(inputs, ctx):
    rid = inputs.get("request_id","")
    model = inputs.get("model")
    if rid.startswith("mock-"):
        return {"video_url": "https://example.com/mock.mp4", "status": "completed"}
    max_iters = 20
    for i in range(max_iters):
        out = _status.run({"request_id": rid, "model": model} if model else {"request_id": rid}, ctx)
        s = (out.get("status") or "").upper()
        if s in ("COMPLETED","COMPLETED ","COMPLETE","SUCCESS"):
            return {"video_url": out.get("video_url",""), "status": "completed"}
        if s in ("FAILED","ERROR"):
            raise RuntimeError(f"fal poll failed: {out}")
        time.sleep(5 if i<3 else 10)
    raise TimeoutError(f"poll exhausted {max_iters} iters for {rid}")
