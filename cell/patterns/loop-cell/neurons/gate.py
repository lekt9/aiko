#!/usr/bin/env python3
def run(inputs, ctx):
    capacity = inputs.get("capacity", {})
    verdict = inputs.get("verdict", "needs_human")
    pct = capacity.get("available_pct", 100)
    if verdict == "needs_human" and pct < 80:
        return {"verdict": "escalated"}
    if verdict == "needs_human":
        return {"verdict": "queued"}
    return {"verdict": verdict}
