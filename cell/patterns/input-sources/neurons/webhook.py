#!/usr/bin/env python3
# input as cell — webhook. A POST to /ingest/<cell> writes inputs/webhook.json and fires.
# No special type: the trigger is external, the cell just sees typed inputs.
def run(inputs, ctx):
    webhook = inputs.get("webhook") or {}
    # Validate + normalize, e.g. HMAC from headers already merged by primitives/request
    event = {
        "type": webhook.get("type") or webhook.get("event") or "unknown",
        "payload": webhook.get("payload") or webhook,
        "received_at": "now",
    }
    return {"event": event}
