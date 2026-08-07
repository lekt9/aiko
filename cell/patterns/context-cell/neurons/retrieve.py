#!/usr/bin/env python3
def run(inputs, ctx):
    q = inputs.get("query","").lower()
    hits = []
    if "battery" in q: hits.append({"doc":"Battery diagnostics KB #42","score":0.9})
    if "refund" in q: hits.append({"doc":"Refund policy KB #7","score":0.96})
    if not hits: hits.append({"doc":"General support KB","score":0.5})
    hits = sorted(hits, key=lambda h: h["score"], reverse=True)[:2]
    return {"hits": hits}
