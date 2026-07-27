#!/usr/bin/env python3
"""fanout Neuron — spawns N deterministic children with narrowed delegations.

Pure policy neuron. Reads a fanout-request: { partition, items: [{key, ...}], max_fanout }.
For each item, spawns a child neuron with identity "fanout/<partition>/<key>", kind
"fanout-worker", and a narrowed grant scoped to the item's output prefix.

Every child id is deterministic from (partition, key, seq) so duplicate firings
produce identical spawns — the runtime dedupes by spawn identity (§26).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_ref, decision, run

REQUEST_SCHEMA = "fanout.request/v1"


def fire(stim):
    if stim["receptor_schema"] != REQUEST_SCHEMA:
        raise Reject("validation", f"fanout expects {REQUEST_SCHEMA}")
    _, request = artifact_ref(stim, REQUEST_SCHEMA)

    partition = request.get("partition", "default")
    items = request.get("items", [])
    max_fanout = int(request.get("max_fanout", 8))
    if len(items) > max_fanout:
        raise Reject("budget_exhausted",
                     f"fan-out {len(items)} exceeds max_fanout {max_fanout}")

    seq = int(request.get("seq", 0))
    effects = []
    for item in items:
        key = item.get("key", item.get("id", "unknown"))
        child_id = f"fanout/{partition}/{key}/{seq}"
        kind = item.get("kind", "fanout-worker")
        write_prefix = item.get("write_prefix", f"artifact/fanout/{key}/")
        effects.append({
            "kind": "spawn",
            "neuron": {
                "id": child_id,
                "kind": kind,
                "grant": {
                    "allow_write": True,
                    "write_prefix": write_prefix,
                    "budget": {
                        "max_effects": 1, "max_writes": 1,
                        "max_messages": 0, "max_spawns": 0,
                        "max_bytes": 4096, "max_depth": 1,
                    },
                },
            },
        })

    return decision(
        control={"kind": "terminate", "result": f"fan:{len(effects)}"},
        effects=effects,
        evidence=[{
            "claim": f"spawned {len(effects)} deterministic children",
            "sources": [r["id"] for r in stim["reads"]],
            "method": "fanout",
        }],
        stim=stim,
    )


if __name__ == "__main__":
    sys.exit(run(fire))
