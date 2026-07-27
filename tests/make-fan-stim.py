#!/usr/bin/env python3
"""Generate a fanout stimulus for the telemetry-advisor witness."""
import hashlib, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "limbs", "shared"))
from _neuron import canonical

now = int(time.time() * 1000)
items = [
    {"key": "add-task", "kind": "fanout-worker", "write_prefix": "artifact/fanout/add-task/"},
    {"key": "patch-item", "kind": "fanout-worker", "write_prefix": "artifact/fanout/patch-item/"},
]
request = {"items": items, "max_fanout": 8, "partition": "tasks", "seq": 0}
reads = [{"id": "fan-req", "schema": "fanout.request/v1",
          "bytes": canonical(request).decode(),
          "digest": hashlib.sha256(canonical(request)).hexdigest()}]
stim = {"schema": "neuron.stimulus/v1", "firing_id": "telemetry-1",
        "receptor_schema": "fanout.request/v1", "now_ms": now,
        "reads": reads, "permitted_reads": ["fan-req"], "messages": []}
with open(sys.argv[1], "w") as f:
    json.dump(stim, f)
