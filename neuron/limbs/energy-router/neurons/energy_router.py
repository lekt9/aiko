#!/usr/bin/env python3
"""energy-router Neuron — EBM-native lowest-energy recommendation + sub-EBM spawn.

Pure policy neuron (§2). Reads a RouteRequest (or pinned WorkItem + candidates)
and returns:
  - write of EnergyScore artifact
  - branch to chosen target, OR spawn of a narrow "energy-sub-ebm" when the
    winning candidate declares wants_sub_ebm.

This is the reference implementation of the structural energy scorer as a
first-class generative limb (§30). It can be published, admitted by digest,
attached on a public mesh node, and remotely stimulated.

Schemas (versioned, content-addressed):
  energy.candidate/v1
  energy.score/v1
  energy.package-offer/v1
  energy.usage/v1
  energy.settlement-claim/v1
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import (
    Reject,
    artifact_ref,
    artifact_refs,
    decision,
    digest,
    run,
)

# Versioned schemas for the public paid neuron commons
CANDIDATE_SCHEMA = "energy.candidate/v1"
SCORE_SCHEMA = "energy.score/v1"
OFFER_SCHEMA = "energy.package-offer/v1"
USAGE_SCHEMA = "energy.usage/v1"
SETTLEMENT_SCHEMA = "energy.settlement-claim/v1"

REQUEST_SCHEMA = "energy.route-request/v1"


def firing_energy(c):
    """Lower is better. Mirrors limbs/energy-router/energy.zig + scorer.py."""
    e = 0.0
    e += 0.0 if c.get("grounding_ok", False) else 3.0
    conf = int(c.get("evidence_conf_milli", 0))
    e += max(0.0, (1000 - conf) / 250.0)
    e += float(c.get("normalized_cost", 1.0)) * 2.0
    e += float(c.get("settlement_distance", 10.0))
    e += int(c.get("violations", 0)) * 2.5
    return round(e, 4)


def fire(stim):
    # Accept either a direct route-request or a pinned set of candidates.
    # Be defensive: the shared _neuron helpers expect 'reads' etc., but direct
    # calls or minimal stimuli may not have them.
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    req = None
    if stim.get("receptor_schema") == REQUEST_SCHEMA:
        try:
            _, req = artifact_ref(stim, REQUEST_SCHEMA, required=False)
        except Exception:
            req = None
    if req is None:
        try:
            for _ref, body in artifact_refs(stim, CANDIDATE_SCHEMA):
                if isinstance(body, list) and body:
                    req = {"candidates": body}
                    break
        except Exception:
            pass
    if not req or "candidates" not in req:
        # Last resort: compact | delimited payload (the prototype/demo path)
        if stim.get("messages"):
            payload = stim["messages"][-1].get("payload", "") if isinstance(stim["messages"][-1], dict) else ""
            cands = []
            for line in str(payload).splitlines():
                line = line.strip()
                if not line:
                    continue
                parts = line.split("|")
                if len(parts) < 6:
                    continue
                try:
                    cands.append({
                        "id": parts[0],
                        "grounding_ok": parts[1] == "1",
                        "evidence_conf_milli": int(parts[2]),
                        "normalized_cost": float(parts[3]),
                        "settlement_distance": float(parts[4]),
                        "violations": int(parts[5]),
                        "wants_sub_ebm": len(parts) > 6 and parts[6] == "1",
                    })
                except Exception:
                    continue
            if cands:
                req = {"candidates": cands}

    if not req or not req.get("candidates"):
        raise Reject("insufficient_evidence", "no candidates provided for energy routing")

    cands = req["candidates"]
    if not isinstance(cands, list) or len(cands) == 0:
        raise Reject("insufficient_evidence", "empty candidate list")

    # Score
    scored = []
    for c in cands:
        e = firing_energy(c)
        scored.append((e, c))
    scored.sort(key=lambda t: t[0])
    best_e, best = scored[0]

    # Evidence is grounded in the stimulus reads + deterministic math
    evidence = [{
        "claim": f"lowest energy route {best.get('id')} e={best_e}",
        "sources": ["stimulus"],
        "method": "firing_energy",
        "confidence_milli": 980,
    }]

    effects = []
    # Always emit the EnergyScore as a content-addressed write
    score_bytes = f"{best.get('id')}|{best_e}".encode()
    effects.append({
        "kind": "write",
        "artifact": {
            "id": f"energy/score/{best.get('id')}",
            "schema": SCORE_SCHEMA,
            "bytes": score_bytes.decode(),
        },
    })

    control = None
    if best.get("wants_sub_ebm"):
        # Spawn a narrow specialist that will continue_wait until resolved.
        # This is the "small breaking EBM" pattern from the architecture.
        spawn_id = f"energy-sub-ebm/{best.get('id')}"
        effects.append({
            "kind": "spawn",
            "spawn": {
                "id": spawn_id,
                "kind": "energy-sub-ebm",
            },
        })
        control = {"kind": "terminate", "result": "spawned-sub-ebm"}
    else:
        target = best.get("id")
        control = {"kind": "branch", "next": target}

    # Optional: if an offer was in the stimulus, we could emit a usage record here.
    # For the minimal first version we keep it to score + route/spawn.
    # A real paid commons flow would also write a UsageRecord and/or SettlementClaim.

    return decision(control, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
