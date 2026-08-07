#!/usr/bin/env python3
def run(inputs, ctx):
    a = inputs.get("a", {})
    b = inputs.get("b", {})
    return {"merged": {"drafts": [a, b], "merged_at": "now"}}
