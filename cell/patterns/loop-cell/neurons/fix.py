#!/usr/bin/env python3
def run(inputs, ctx):
    diag = inputs.get("diagnosis", {})
    if diag.get("kind") == "battery" and diag.get("fixable"):
        return {"verdict": "resolved", "result": {"action": "battery_replacement_ordered"}}
    if diag.get("kind") == "billing":
        return {"verdict": "needs_human", "result": {"action": "refund_denied_policy"}}
    return {"verdict": "resolved", "result": {"action": "auto_reply"}}
