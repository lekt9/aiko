#!/usr/bin/env python3
def run(inputs, ctx):
    q = inputs.get("query","").lower()
    if "refund" in q:
        allowed = ["refund_tool","send_message"]
    elif "battery" in q:
        allowed = ["diagnostics_tool","send_message"]
    else:
        allowed = ["send_message"]
    return {"allowed_tools": allowed}
