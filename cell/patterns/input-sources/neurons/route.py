#!/usr/bin/env python3
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
def run(inputs, ctx):
    source = (inputs.get("source") or "poll").lower()
    payload = inputs.get("payload") or {}
    if source == "poll":
        import poll as m
        out = m.run({"cursor": payload.get("cursor","0")}, ctx)
        return {"item": out["item"], "manifest": {"source": "poll", "digest": out["next_cursor"]}}
    elif source == "webhook":
        import webhook as m
        out = m.run({"webhook": payload.get("webhook") or payload}, ctx)
        return {"item": out["event"], "manifest": {"source": "webhook", "digest": str(out["event"].get("type"))}}
    elif source == "hook":
        import hook as m
        out = m.run({"file": payload.get("file") or payload}, ctx)
        return {"item": out["change"], "manifest": {"source": "hook", "digest": out["change"].get("path")}}
    elif source == "cas":
        import cas_read as m
        out = m.run({"key": payload.get("key","")}, ctx)
        return {"item": out["data"], "manifest": {"source": "cas", "digest": payload.get("key")}}
    else:
        raise ValueError(f"unknown source {source!r} — use poll|webhook|hook|cas")
