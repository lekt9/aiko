#!/usr/bin/env python3
def run(inputs, ctx):
    q = inputs.get("query","")
    return {"draft": {"worker": "billing", "summary": f"billing draft for {q[:40]}"}}
