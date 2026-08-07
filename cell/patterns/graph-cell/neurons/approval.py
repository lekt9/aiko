#!/usr/bin/env python3
def run(inputs, ctx):
    m = inputs.get("merged", {})
    return {"approved": {"merged": m, "approved_by": "human", "approved": True}}
