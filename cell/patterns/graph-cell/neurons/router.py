#!/usr/bin/env python3
def run(inputs, ctx):
    q = inputs.get("query","").lower()
    if "refund" in q or "billing" in q:
        return {"branch": "billing"}
    if "battery" in q:
        return {"branch": "hardware"}
    return {"branch": "general"}
