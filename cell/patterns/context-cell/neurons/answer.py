#!/usr/bin/env python3
def run(inputs, ctx):
    ctx_hits = inputs.get("ctx", [])
    tools = inputs.get("tools", [])
    q = inputs.get("query","")
    refs = ", ".join(h["doc"] for h in ctx_hits)
    return {"answer": f"Q: {q} | ctx: {refs} | tools: {tools}"}
