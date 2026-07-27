#!/usr/bin/env python3
"""gap-analyzer Neuron — identifies missing capabilities from a capability map.

Pure policy neuron (§2). Reads a capability-map artifact and a gap-request
from the stimulus, compares the desired capabilities against what exists,
and produces a ranked `neuron.capability-gaps/v1` artifact with structural
energy scores. Lower energy = higher urgency.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import (
    Reject,
    artifact_ref,
    decision,
    run,
)

CAPABILITY_MAP_SCHEMA = "neuron.capability-map/v1"
GAP_REQUEST_SCHEMA = "neuron.gap-request/v1"
CAPABILITY_GAPS_SCHEMA = "neuron.capability-gaps/v1"


def gap_energy(status, partial_candidates):
    """Structural energy for a gap. Lower = more urgent.

    - present: 0 (no gap)
    - partial: 1.0 + penalty for weak match (few candidates = weaker match)
    - absent: 3.0 + penalty for no candidates at all
    """
    if status == "present":
        return 0.0
    if status == "partial":
        return 1.0 + max(0.0, (3 - len(partial_candidates)) * 0.5)
    return 3.0 + 2.0  # absent: base + no-match penalty


def suggest_action(status, kind, candidates):
    """Suggest remediation based on gap status."""
    if status == "present":
        return "none"
    if status == "partial":
        if kind == "package":
            return "upgrade_version"
        return "register_neuron"
    # absent
    if kind in ("neuron", "schema"):
        return "generate_limb"
    if kind == "package":
        return "admit_existing"
    return "generate_limb"


def check_neuron(desired, capability_map):
    """Check if a neuron identity exists."""
    prefix = desired.get("identity", "")
    if not prefix:
        return {"status": "absent", "energy": gap_energy("absent", []), "candidates": []}

    neurons = capability_map.get("neurons", [])
    matches = [n["identity"] for n in neurons if n["identity"].startswith(prefix)]

    min_version = desired.get("minimum_version")
    if matches:
        if min_version:
            version_matches = [
                n for n in neurons
                if n["identity"].startswith(prefix) and n.get("version", "0") >= min_version
            ]
            if version_matches:
                return {"status": "present", "energy": 0.0, "candidates": matches}
            return {"status": "partial", "energy": gap_energy("partial", matches), "candidates": matches}
        return {"status": "present", "energy": 0.0, "candidates": matches}
    return {"status": "absent", "energy": gap_energy("absent", []), "candidates": []}


def check_schema(desired, capability_map):
    """Check if a schema exists in artifacts or messages."""
    prefix = desired.get("schema", "")
    if not prefix:
        return {"status": "absent", "energy": gap_energy("absent", []), "candidates": []}

    artifact_schemas = [a["schema"] for a in capability_map.get("artifacts", [])]
    msg_schemas = [m["schema"] for m in capability_map.get("messages", [])]
    all_schemas = set(artifact_schemas + msg_schemas)

    matches = [s for s in all_schemas if s.startswith(prefix)]
    if matches:
        return {"status": "present", "energy": 0.0, "candidates": matches}
    # Check for close matches (same prefix up to /v)
    close = [s for s in all_schemas if s.rsplit("/", 1)[0] == prefix.rsplit("/", 1)[0]]
    if close:
        return {"status": "partial", "energy": gap_energy("partial", close), "candidates": close}
    return {"status": "absent", "energy": gap_energy("absent", []), "candidates": []}


def check_package(desired, capability_map):
    """Check if a package is admitted."""
    name = desired.get("package_name", "")
    if not name:
        return {"status": "absent", "energy": gap_energy("absent", []), "candidates": []}

    packages = capability_map.get("packages", [])
    matches = [p["name"] for p in packages if p["name"] == name and p.get("status") == "admitted"]
    if matches:
        return {"status": "present", "energy": 0.0, "candidates": matches}

    generated = [p["name"] for p in packages if p["name"] == name]
    if generated:
        return {"status": "partial", "energy": gap_energy("partial", generated), "candidates": generated}
    return {"status": "absent", "energy": gap_energy("absent", []), "candidates": []}


def fire(stim):
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    # Read gap-request (may be in reads or inline in messages)
    _, gap_req = artifact_ref(stim, GAP_REQUEST_SCHEMA, required=False)

    # Also try reading from a message payload
    if gap_req is None:
        for msg in stim.get("messages", []):
            try:
                if msg.get("schema") == GAP_REQUEST_SCHEMA:
                    gap_req = json.loads(msg.get("payload", "{}"))
                    break
            except Exception:
                continue

    if gap_req is None:
        raise Reject("dependency", "no gap-request found in reads or messages")

    desired = gap_req.get("desired", [])
    if not desired:
        raise Reject("validation", "gap-request has empty desired list")

    # Read capability map (from reads)
    map_artifact_id = gap_req.get("map_artifact_id")
    capability_map = None

    if map_artifact_id:
        for ref in stim["reads"]:
            if ref.get("id") == map_artifact_id and ref.get("schema") == CAPABILITY_MAP_SCHEMA:
                try:
                    capability_map = json.loads(ref["bytes"])
                except Exception:
                    raise Reject("poisoned_input", f"capability map {map_artifact_id} is not valid JSON")
                break
        if capability_map is None:
            raise Reject("dependency", f"capability map {map_artifact_id} not in reads")
    else:
        # Try to find any capability-map in reads
        for ref in stim["reads"]:
            if ref.get("schema") == CAPABILITY_MAP_SCHEMA:
                try:
                    capability_map = json.loads(ref["bytes"])
                except Exception:
                    continue
                break
        if capability_map is None:
            raise Reject("dependency", "no capability map found in reads; run inspector first")

    # Check each desired capability
    checkers = {
        "neuron": check_neuron,
        "schema": check_schema,
        "package": check_package,
    }

    gaps = []
    for d in desired:
        kind = d.get("kind", "unknown")
        checker = checkers.get(kind)
        if checker is None:
            gaps.append({
                "desired": d,
                "status": "absent",
                "energy": 5.0,
                "suggest_action": "generate_limb",
                "detail": f"Unknown desired kind: {kind}",
                "matching_candidates": [],
            })
            continue

        result = checker(d, capability_map)
        gaps.append({
            "desired": d,
            "status": result["status"],
            "energy": result["energy"],
            "suggest_action": suggest_action(result["status"], kind, result["candidates"]),
            "detail": detail_for(d, result),
            "matching_candidates": result["candidates"],
        })

    # Rank by energy (lowest = most urgent gap, but present=0 sorts first)
    gaps.sort(key=lambda g: (-1 if g["energy"] == 0 else 0, g["energy"]), reverse=False)
    # Actually: we want absent (high energy) first, then partial, then present
    gaps.sort(key=lambda g: (0 if g["status"] == "absent" else (1 if g["status"] == "partial" else 2), g["energy"]))

    present = sum(1 for g in gaps if g["status"] == "present")
    absent = sum(1 for g in gaps if g["status"] == "absent")
    partial = sum(1 for g in gaps if g["status"] == "partial")

    result = {
        "gaps": gaps,
        "total_desired": len(desired),
        "present": present,
        "absent": absent,
        "partial": partial,
    }

    gap_bytes = json.dumps(result, sort_keys=True, separators=(",", ":"))
    evidence = [{
        "claim": f"gap analysis: {present} present, {partial} partial, {absent} absent out of {len(desired)} desired",
        "sources": ["stimulus"],
        "method": "schema-prefix matching against capability map",
        "confidence_milli": 900,
    }]

    effects = [{
        "kind": "write",
        "artifact": {
            "id": "introspection/capability-gaps",
            "schema": CAPABILITY_GAPS_SCHEMA,
            "bytes": gap_bytes,
        },
    }]

    return decision({"kind": "terminate", "result": "gaps-analyzed"}, effects, evidence, stim)


def detail_for(desired, result):
    """Human-readable gap detail."""
    kind = desired.get("kind", "unknown")
    if result["status"] == "present":
        if kind == "neuron":
            return f"Neuron '{desired.get('identity', '?')}' is present"
        if kind == "schema":
            return f"Schema '{desired.get('schema', '?')}' exists"
        if kind == "package":
            return f"Package '{desired.get('package_name', '?')}' is admitted"
    if result["status"] == "partial":
        candidates = ", ".join(result["candidates"][:3])
        return f"Partial match for '{desired.get('identity') or desired.get('schema') or desired.get('package_name')}': found {candidates}"
    return f"Missing: {json.dumps(desired)}"


if __name__ == "__main__":
    sys.exit(run(fire))
