#!/usr/bin/env python3
"""deploy-workflow — write a seat Cell inert.

The authored Cell is a harness that seats Aiko (wires deploy-aiko). Role and
outcome are identity, pinned in metadata so a different outcome is a different
digest. They are never copied into a leaf that could print them as fake
acceptance. Bounded: one transform, written ahead of time.
"""
import hashlib
import json

SEAT_CELL = {
    "apiVersion": "cell/v0",
    "kind": "Cell",
    "metadata": {
        "name": "aiko-seat",
        "description": "harness that seats Aiko as the employee on this role",
    },
    "spec": {
        "membrane": {
            "inputs": {
                "role": {"schema": "string"},
                "handle": {"schema": "object"},
                "workflow_digest": {"schema": "string"},
            },
            "outputs": {"handoff": {"schema": "object"}},
            "caps": {},
        },
        "organelles": [
            {"name": "seat", "cell": "./deploy-aiko.cell.yaml"},
        ],
        "wiring": [
            {"from": "membrane.role", "to": "seat.role"},
            {"from": "membrane.handle", "to": "seat.handle"},
            {"from": "membrane.workflow_digest", "to": "seat.digest"},
            {"from": "seat.attachment", "to": "membrane.handoff"},
        ],
    },
}

YAML = """apiVersion: cell/v0
kind: Cell
metadata:
  name: aiko-seat
  description: harness that seats Aiko as the employee on this role
  role: {role}
  outcome: {outcome}
  handle_id: {handle_id}
spec:
  membrane:
    inputs:
      role: {{ schema: string }}
      handle: {{ schema: object }}
      workflow_digest: {{ schema: string }}
    outputs:
      handoff: {{ schema: object }}
    caps: {{}}
  organelles:
    - {{ name: seat, cell: ./deploy-aiko.cell.yaml }}
  wiring:
    - {{ from: membrane.role, to: seat.role }}
    - {{ from: membrane.handle, to: seat.handle }}
    - {{ from: membrane.workflow_digest, to: seat.digest }}
    - {{ from: seat.attachment, to: membrane.handoff }}
"""


def run(inputs, ctx):
    role = str(inputs.get("role") or "").strip()
    outcome = str(inputs.get("outcome") or "").strip()
    handle = inputs.get("handle") or {}
    if not role:
        raise ValueError("deploy-workflow: role is required")
    if not outcome:
        raise ValueError("deploy-workflow: outcome is required")
    if not isinstance(handle, dict) or not str(handle.get("id") or "").startswith("cred:"):
        raise ValueError("deploy-workflow: handle.id must be an opaque cred: handle")
    cell = json.loads(json.dumps(SEAT_CELL))
    cell["metadata"]["role"] = role
    cell["metadata"]["outcome"] = outcome
    cell["metadata"]["handle_id"] = handle["id"]
    canonical = json.dumps(cell, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    yaml_text = YAML.format(role=role, outcome=outcome, handle_id=handle["id"])
    ports = {
        "inputs": ["role", "handle", "workflow_digest"],
        "outputs": ["handoff"],
        "organelles": ["seat"],
        "seats": "deploy-aiko",
    }
    return {
        "cell": cell,
        "cell_yaml": yaml_text,
        "digest": digest,
        "ports": ports,
    }
