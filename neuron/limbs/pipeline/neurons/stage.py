#!/usr/bin/env python3
"""stage Neuron — processes one pass of pipeline items within an in-flight budget.

Pure policy neuron. Reads a stage request with items and an in-flight budget.
For each item that hasn't been processed yet (no progress artifact), writes a
progress record and dequeues it. Items at different stages proceed independently.
Items beyond the in-flight budget stay queued for the next firing.

Deterministic: same stimulus → same progress writes → duplicate coordinator works.
"""

import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_ref, decision, run

REQUEST_SCHEMA = "pipeline.stage-request/v1"


def fire(stim):
    if stim.get("receptor_schema") != REQUEST_SCHEMA:
        raise Reject("validation", f"stage expects {REQUEST_SCHEMA}")
    _, request = artifact_ref(stim, REQUEST_SCHEMA)

    stage_name = request.get("stage", "default")
    items = request.get("items", [])
    budget = int(request.get("in_flight_budget", 4))
    if budget < 1:
        raise Reject("budget_exhausted", f"in_flight_budget {budget} < 1")

    effects = []
    processed = 0
    for item in items:
        if processed >= budget:
            break
        key = item.get("key", item.get("id", "unknown"))
        # Write a progress artifact deterministically keyed to (stage, key).
        record = {
            "schema": "pipeline.progress/v1",
            "stage": stage_name,
            "key": key,
            "item": item,
        }
        import json as _json
        effects.append({
            "kind": "write",
            "artifact": {
                "id": f"artifact/pipeline/{stage_name}/{key}",
                "schema": "pipeline.progress/v1",
                "bytes": _json.dumps(record, sort_keys=True),
            },
        })
        processed += 1

    result = f"stage:{stage_name}:{processed}"
    if processed == 0:
        result = f"stage:{stage_name}:drained"

    return decision(
        control={"kind": "terminate", "result": result},
        effects=effects,
        evidence=[{
            "claim": f"processed {processed} items in stage {stage_name}",
            "sources": [r["id"] for r in stim.get("reads", [])],
            "method": "pipeline-stage",
        }],
        stim=stim,
    )


if __name__ == "__main__":
    sys.exit(run(fire))
