#!/usr/bin/env python3
def run(inputs, ctx):
    q = inputs.get("query","")
    return {"draft": {"worker": "hardware", "summary": f"hardware draft for {q[:40]}"}}
