#!/usr/bin/env python3
"""dispatcher Neuron — energy-minimizing dispatch to admitted limbs.

Pure policy neuron (§2). Receives a stimulus with a receptor schema and:
1. Reads all edge manifests from the topology (substrate reads)
2. Filters edges whose source matches the receptor schema
3. Scores each candidate limb using structural energy (firingEnergy)
4. Computes the model path energy (always >= 2.0)
5. Selects the lowest-energy candidate
6. If a limb wins: sends a message to route the stimulus to that limb
7. If the model wins: returns "dispatched-to-model" with no effects

Key invariants:
- §30.5: "Fire it through the ordinary Neuron interpreter." The dispatcher
  doesn't fire the limb directly — it sends a message that the topology
  routes to the limb.
- §25: The dispatcher's decision is itself a firing, recorded in the
  substrate. Future dispatches can be preempted.
- §2: Pure and stateless — all state comes from the stimulus and reads.
"""

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import (
    Reject,
    artifact_ref,
    artifact_refs,
    decision,
    run,
)

DISPATCH_REQUEST_SCHEMA = "neuron.dispatch-request/v1"
DISPATCH_DECISION_SCHEMA = "neuron.dispatch-decision/v1"
DISPATCH_LOG_SCHEMA = "neuron.dispatch-log/v1"
EDGE_MANIFEST_SCHEMA = "neuron.edge-manifest/v1"

# Model path always has energy >= 2.0 (no grounding + highest cost)
MODEL_PATH_GROUNDING = False
MODEL_PATH_CONFIDENCE_MILLI = 0
MODEL_PATH_COST = 1.0
MODEL_PATH_SETTLEMENT = 1.0


def firing_energy(grounding_ok, evidence_conf_milli, normalized_cost, settlement_distance, violations=0):
    """Structural energy of one firing candidate (0+ ; lower = better).

    Same formula as ../energy-router/scorer.py:
    - grounding: 0 if grounded, 3 if not
    - evidence: (1000 - conf_milli) / 250
    - cost: cost * 2
    - settlement: distance
    - violations: * 2.5
    """
    e = 0.0
    e += 0.0 if grounding_ok else 3.0
    e += max(0.0, (1000 - evidence_conf_milli) / 250.0)
    e += normalized_cost * 2.0
    e += settlement_distance
    e += violations * 2.5
    return round(e, 4)


def model_path_energy():
    """Energy of the model path fallback. Always >= 2.0."""
    return firing_energy(
        grounding_ok=MODEL_PATH_GROUNDING,
        evidence_conf_milli=MODEL_PATH_CONFIDENCE_MILLI,
        normalized_cost=MODEL_PATH_COST,
        settlement_distance=MODEL_PATH_SETTLEMENT,
    )


def score_limb_candidate(edge_manifest, receptor_schema):
    """Score an admitted limb candidate for this receptor.

    A matched limb has:
    - grounding = True (it has a typed receptor match)
    - evidence_conf = 900 (high confidence — the edge manifest is a typed contract)
    - cost = 0.1-0.5 (limbs are cheap; model is expensive)
    - settlement = 0.1 (limbs settle quickly)
    - violations = 0 (admitted limbs passed validation)
    """
    return firing_energy(
        grounding_ok=True,  # The limb has a typed receptor match
        evidence_conf_milli=900,
        normalized_cost=0.15,  # Limbs are much cheaper than model calls
        settlement_distance=0.1,  # Limbs settle in one firing
        violations=0,
    )


def find_matching_edges(stim, receptor_schema):
    """Find all edge manifests whose source matches the receptor schema."""
    expected_source = f"receptor/{receptor_schema}"
    matches = []

    for ref, body in artifact_refs(stim, EDGE_MANIFEST_SCHEMA):
        if not isinstance(body, dict):
            continue
        if body.get("source") == expected_source:
            matches.append(body)

    # Also check messages
    for msg in stim.get("messages", []):
        if msg.get("schema") != EDGE_MANIFEST_SCHEMA:
            continue
        try:
            body = json.loads(msg.get("payload", "{}"))
            if isinstance(body, dict) and body.get("source") == expected_source:
                matches.append(body)
        except Exception:
            continue

    return matches


def fire(stim):
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    # Get the receptor schema from the stimulus
    receptor_schema = stim.get("receptor_schema", "")
    if not receptor_schema:
        raise Reject("validation", "stimulus missing receptor_schema")

    # Find all admitted limbs matching this receptor
    candidates = find_matching_edges(stim, receptor_schema)

    if not candidates:
        # No matching limbs → dispatch to model
        log = {
            "schema": DISPATCH_LOG_SCHEMA,
            "receptor": receptor_schema,
            "decision": "model",
            "reason": "no matching limbs",
            "candidates_evaluated": 0,
            "model_energy": model_path_energy(),
        }
        log_bytes = json.dumps(log, sort_keys=True, separators=(",", ":"))

        effects = [{
            "kind": "write",
            "artifact": {
                "id": f"dispatch/{stim['firing_id']}",
                "schema": DISPATCH_LOG_SCHEMA,
                "bytes": log_bytes,
            },
        }]

        evidence = [{
            "claim": f"dispatched to model: no matching limbs for {receptor_schema}",
            "sources": ["stimulus"],
            "method": "edge-manifest topology scan",
            "confidence_milli": 1000,
        }]

        return decision({"kind": "terminate", "result": "dispatched-to-model"}, effects, evidence, stim)

    # Score each candidate
    scored = []
    for edge in candidates:
        energy = score_limb_candidate(edge, receptor_schema)
        scored.append((energy, edge))

    # Score the model path
    model_energy = model_path_energy()

    # Sort by energy (lowest = best)
    scored.sort(key=lambda x: x[0])
    best_limb_energy, best_limb = scored[0]

    # Write dispatch log
    log = {
        "schema": DISPATCH_LOG_SCHEMA,
        "receptor": receptor_schema,
        "decision": "limb" if best_limb_energy < model_energy else "model",
        "candidates_evaluated": len(scored),
        "best_limb_energy": best_limb_energy,
        "model_energy": model_energy,
        "best_limb_destination": best_limb.get("destination", ""),
        "best_limb_digest": best_limb.get("admission_digest", ""),
    }
    log_bytes = json.dumps(log, sort_keys=True, separators=(",", ":"))

    if best_limb_energy < model_energy:
        # Dispatch to the limb — send a message that the topology routes
        dispatch_msg = {
            "schema": DISPATCH_DECISION_SCHEMA,
            "receptor_schema": receptor_schema,
            "destination": best_limb.get("destination", ""),
            "admission_digest": best_limb.get("admission_digest", ""),
            "energy": best_limb_energy,
            "stimulus_firing_id": stim.get("firing_id", ""),
        }

        effects = [
            {
                "kind": "send",
                "message": {
                    "to": best_limb.get("destination", ""),
                    "schema": DISPATCH_DECISION_SCHEMA,
                    "payload": json.dumps(dispatch_msg, sort_keys=True, separators=(",", ":")),
                    "durable": True,
                },
            },
            {
                "kind": "write",
                "artifact": {
                    "id": f"dispatch/{stim['firing_id']}",
                    "schema": DISPATCH_LOG_SCHEMA,
                    "bytes": log_bytes,
                },
            },
        ]

        evidence = [{
            "claim": f"dispatched to limb {best_limb.get('destination', '')}: energy {best_limb_energy} < model {model_energy}",
            "sources": ["stimulus"],
            "method": "structural energy minimization over admitted limb candidates",
            "confidence_milli": 950,
        }]

        return decision({"kind": "terminate", "result": "dispatched-to-limb"}, effects, evidence, stim)
    else:
        # Model wins
        effects = [{
            "kind": "write",
            "artifact": {
                "id": f"dispatch/{stim['firing_id']}",
                "schema": DISPATCH_LOG_SCHEMA,
                "bytes": log_bytes,
            },
        }]

        evidence = [{
            "claim": f"dispatched to model: energy {model_energy} <= best limb {best_limb_energy}",
            "sources": ["stimulus"],
            "method": "structural energy minimization over admitted limb candidates",
            "confidence_milli": 950,
        }]

        return decision({"kind": "terminate", "result": "dispatched-to-model"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
