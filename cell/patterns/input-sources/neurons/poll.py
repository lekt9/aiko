#!/usr/bin/env python3
# input as cell — polling. Replace sleep/url with your source.
import time, json, pathlib, urllib.request
def run(inputs, ctx):
    cursor = inputs.get("cursor") or "0"
    # Demo: file-poll over example job pool, or HTTP poll. Mock here for CI.
    # cursor is an opaque token (page, offset, last_id) that caller round-trips.
    # Real impl: resp = helpers.http_request("GET", f"{base}?cursor={cursor}")
    item = {"id": f"item-{cursor}", "polled_at": "now", "cursor": cursor}
    next_cursor = str(int(cursor) + 1) if cursor.isdigit() else "1"
    return {"item": item, "next_cursor": next_cursor}
