#!/usr/bin/env python3
"""registry-lookup Neuron — EBM-native discovery over a local + published index.

Reads a lookup request (WorkItem schema + optional filters) and a set of
PackageOffer + Candidate records (pinned). Returns the lowest-energy compatible
offers, augmented with energy scores.

This is the "search admitted and external registries" step made concrete
as a generative limb. It enables cold-start reuse of published paid neurons
over the public mesh.

It never grants authority — it only returns read data (offers + digests).
The caller still has to admit by digest locally.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_refs, artifact_ref, decision, run

LOOKUP_SCHEMA = "energy.registry-lookup/v1"
OFFER_SCHEMA = "energy.package-offer/v1"
CANDIDATE_SCHEMA = "energy.candidate/v1"


def firing_energy(c):
    e = 0.0
    e += 0.0 if c.get("grounding_ok", False) else 3.0
    conf = int(c.get("evidence_conf_milli", 0))
    e += max(0.0, (1000 - conf) / 250.0)
    e += float(c.get("normalized_cost", 1.0)) * 2.0
    e += float(c.get("settlement_distance", 10.0))
    e += int(c.get("violations", 0)) * 2.5
    return round(e, 4)


def fire(stim):
    if stim.get("receptor_schema") != LOOKUP_SCHEMA:
        # be tolerant for demo
        pass

    _, request = artifact_ref(stim, LOOKUP_SCHEMA, required=False)
    if request is None:
        # allow a minimal request in messages for demo
        req = {"input_schema": "energy.route-request/v1"}
        if stim.get("messages"):
            req["input_schema"] = stim["messages"][-1].get("payload", req["input_schema"])
    else:
        req = request

    input_schema = req.get("input_schema", "*")

    offers = []
    for _ref, offer in artifact_refs(stim, OFFER_SCHEMA):
        if offer.get("output_schema") == input_schema or input_schema == "*":
            offers.append(offer)

    # Also accept raw candidates that already carry package_digest + price
    cands = []
    for _ref, cand in artifact_refs(stim, CANDIDATE_SCHEMA):
        if isinstance(cand, list):
            cands.extend(cand)
        elif isinstance(cand, dict):
            cands.append(cand)

    # Score offers that have embedded candidate data or map to candidates
    results = []
    for o in offers:
        c = {
            "id": o.get("package_digest", o.get("name", "unknown")),
            "grounding_ok": True,
            "evidence_conf_milli": o.get("witness_conf_milli", 800),
            "normalized_cost": o.get("normalized_cost_hint", 0.2),
            "settlement_distance": o.get("settlement_distance_hint", 0.5),
            "violations": 0,
            "package_digest": o.get("package_digest"),
            "price_milli": o.get("price_milli", 0),
        }
        e = firing_energy(c)
        results.append({
            "energy": e,
            "offer": o,
            "candidate": c,
        })

    # Also score loose candidates
    for c in cands:
        e = firing_energy(c)
        results.append({
            "energy": e,
            "candidate": c,
        })

    results.sort(key=lambda r: r["energy"])

    evidence = [{
        "claim": f"found {len(results)} energy-ranked compatible packages",
        "sources": ["stimulus"],
        "method": "registry-lookup + firing_energy",
        "confidence_milli": 850,
    }]

    # Return a compact result as a write (the caller can read it in next step)
    import json as _json
    result_bytes = _json.dumps({"results": results[:8]}, sort_keys=True)
    effects = [{
        "kind": "write",
        "artifact": {
            "id": "energy/registry-lookup-result",
            "schema": "energy.registry-result/v1",
            "bytes": result_bytes,
        },
    }]

    control = {"kind": "terminate", "result": "lookup-complete"}
    return decision(control, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
