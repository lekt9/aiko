#!/usr/bin/env python3
def run(inputs, ctx):
    ticket = inputs.get("ticket", {})
    text = ticket.get("text","").lower()
    if "refund" in text:
        label = "billing"
    elif "battery" in text or "diagnostic" in text:
        label = "hardware"
    else:
        label = "general"
    return {"label": label}
