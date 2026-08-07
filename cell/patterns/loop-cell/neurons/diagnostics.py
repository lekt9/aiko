#!/usr/bin/env python3
def run(inputs, ctx):
    ticket = inputs.get("ticket", {})
    text = ticket.get("text","").lower()
    if "battery" in text:
        return {"diagnosis": {"kind": "battery", "fixable": True}}
    if "refund" in text:
        return {"diagnosis": {"kind": "billing", "fixable": False}}
    return {"diagnosis": {"kind": "general", "fixable": True}}
