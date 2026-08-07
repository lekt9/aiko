#!/usr/bin/env python3
def run(inputs, ctx):
    qualified = inputs.get("qualified", [])
    ranked = sorted(qualified)
    return {"roster": {"order_id": "ord-001", "assigned": ranked[:2]}}
