#!/usr/bin/env python3
# input as cell — hook source. PostToolUse on Write|Edit for *.cell.yaml triggers this.
def run(inputs, ctx):
    f = inputs.get("file") or {}
    return {"change": {"path": f.get("path") or f.get("file_path") or "unknown", "kind": "write", "at": "now"}}
