#!/usr/bin/env python3
def run(inputs, ctx):
    order = inputs.get("order", {"id": "ord-001", "items": []})
    candidates = ["alice", "bob", "carol"] if order.get("items") else []
    return {"qualified": candidates}
