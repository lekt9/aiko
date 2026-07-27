#!/usr/bin/env python3
"""inspector Neuron — reads substrate artifacts and produces a typed capability map.

Pure policy neuron (§2). Reads all staged artifact reads from the stimulus
and produces a `neuron.capability-map/v1` artifact describing the system's
current capabilities, state, and topology.

This is the "observe" phase of self-awareness: a neuron that can answer
"what am I capable of?" by reading its own substrate.
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

CAPABILITY_MAP_SCHEMA = "neuron.capability-map/v1"
INSPECT_REQUEST_SCHEMA = "neuron.inspect-request/v1"

# Meta-Agent schemas we know how to interpret
KNOWN_NEURON_SCHEMAS = {
    "typed-neuron.agent-snapshot/v1",
    "typed-neuron.snapshot-pointer/v1",
    "typed-neuron.intent/v1",
    "typed-neuron.work-envelope/v1",
    "typed-neuron.context-manifest/v1",
    "typed-neuron.plan/v1",
    "typed-neuron.proposal/v1",
    "typed-neuron.work-complete/v1",
    "typed-neuron.failure/v1",
    "typed-neuron.retry/v1",
    "typed-neuron.capability-gap/v1",
    "typed-neuron.skill/v1",
    "typed-neuron.agent-skill-manifest/v1",
    "typed-neuron.result/v1",
    "typed-neuron.memory-index/v1",
    "typed-neuron.audit/v1",
    "typed-neuron.frontier/v1",
    "neuron.capability-map/v1",
    "neuron.capability-gaps/v1",
    "neuron.limb-spec/v1",
    "neuron.limb-manifest/v1",
    "energy.candidate/v1",
    "energy.score/v1",
    "energy.package-offer/v1",
    "energy.usage/v1",
    "energy.settlement-claim/v1",
    "outbox.drain-request/v1",
    "outbox.queued-messages/v1",
    "outbox.delivery-attempt/v1",
    "outbox.delivery-record/v1",
    "outbox.ack/v1",
    "outbox.settle-request/v1",
}


def classify_artifact(artifact_id, schema):
    """Classify an artifact into a kind hint based on its schema."""
    if schema in ("typed-neuron.skill/v1", "typed-neuron.agent-skill-manifest/v1"):
        return "limb-package"
    if schema == "typed-neuron.snapshot-pointer/v1":
        return "pointer"
    if schema == "typed-neuron.agent-snapshot/v1":
        return "snapshot"
    if schema == "typed-neuron.audit/v1":
        return "audit"
    if schema == "typed-neuron.memory-index/v1":
        return "memory"
    if schema == "typed-neuron.proposal/v1":
        return "proposal"
    if schema == "energy.score/v1":
        return "energy-score"
    if schema == "neuron.capability-map/v1":
        return "capability-map"
    if schema == "neuron.capability-gaps/v1":
        return "gap-analysis"
    if schema == "neuron.limb-spec/v1":
        return "generated-limb"
    if schema == "neuron.limb-manifest/v1":
        return "generated-manifest"
    return None


def neuron_kind_from_id(neuron_id):
    """Guess neuron implementation kind from its identity."""
    if neuron_id.startswith("meta/"):
        return "fixed"
    if neuron_id.startswith("energy-"):
        return "script"
    if neuron_id.startswith("outbox-"):
        return "script"
    if neuron_id.startswith("mesh/"):
        return "proxy"
    if neuron_id.startswith("introspection/"):
        return "script"
    return "unknown"


def fire(stim):
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    # Parse optional inspect-request for filters
    req = None
    try:
        _, req = artifact_ref(stim, INSPECT_REQUEST_SCHEMA, required=False)
    except Exception:
        req = None

    identity_filter = None
    schema_filter = None
    include_metrics = True
    include_topology = True
    include_packages = True
    if req and isinstance(req, dict):
        identity_filter = req.get("identity_prefix")
        schema_filter = req.get("schema_prefix")
        include_metrics = req.get("include_metrics", True)
        include_topology = req.get("include_topology", True)
        include_packages = req.get("include_packages", True)

    now_ms = stim.get("now_ms", 0)

    # Collect all reads, grouped by schema
    schema_artifacts = {}  # schema -> [(id, bytes, digest)]
    for ref in stim["reads"]:
        sid = ref.get("id", "unknown")
        schema = ref.get("schema", "unknown")
        if schema_filter and not schema.startswith(schema_filter):
            continue
        if schema not in schema_artifacts:
            schema_artifacts[schema] = []
        schema_artifacts[schema].append((sid, ref.get("bytes", ""), ref.get("digest", "")))

    # Build artifact summary
    artifacts = []
    for schema, entries in sorted(schema_artifacts.items()):
        ids = [e[0] for e in entries[:32]]  # cap at 32
        artifacts.append({
            "schema": schema,
            "count": len(entries),
            "ids": ids,
        })

    # Extract neuron identities from artifacts that encode them
    # (e.g., agent-snapshot fronters, limb manifests)
    neurons = []
    seen_neurons = set()
    for schema, entries in schema_artifacts.items():
        for sid, raw, _digest in entries:
            try:
                body = __import__("json").loads(raw)
            except Exception:
                continue
            if schema == "typed-neuron.agent-skill-manifest/v1" and isinstance(body, dict):
                neuron_id = body.get("name") or sid
            elif schema == "typed-neuron.skill/v1" and isinstance(raw, str):
                # limb/v1 spec: extract name from header
                lines = raw.strip().split("\n")
                if lines and lines[0].startswith("limb/v1"):
                    neuron_id = "generated/" + lines[0].split(" ", 1)[-1].strip()
            else:
                continue
            if neuron_id not in seen_neurons:
                if identity_filter and not neuron_id.startswith(identity_filter):
                    continue
                seen_neurons.add(neuron_id)
                neurons.append({
                    "identity": neuron_id,
                    "version": body.get("version", "1.0.0") if isinstance(body, dict) else "1.0.0",
                    "kind": neuron_kind_from_id(neuron_id),
                })

    # Message summary from the stimulus messages
    message_schemas = {}
    for msg in stim["messages"]:
        schema = msg.get("schema", "unknown")
        if schema not in message_schemas:
            message_schemas[schema] = {"schema": schema, "count": 0, "statuses": {}}
        message_schemas[schema]["count"] += 1
    messages = sorted(message_schemas.values(), key=lambda m: m["schema"])

    # Metrics: minimal from what we can observe (reads + messages)
    metrics = {
        "artifact_schemas": len(schema_artifacts),
        "artifact_ids": sum(len(v) for v in schema_artifacts.values()),
        "message_schemas": len(message_schemas),
        "message_count": len(stim["messages"]),
        "neuron_identities": len(neurons),
    }

    # Packages: from skill artifacts
    packages = []
    for schema, entries in schema_artifacts.items():
        if schema == "typed-neuron.skill/v1":
            for sid, raw, _digest in entries:
                try:
                    spec_digest = digest(raw.encode() if isinstance(raw, str) else raw)
                    name = "generated-limb"
                    lines = raw.strip().split("\n")
                    if lines and lines[0].startswith("limb/v1"):
                        name = "generated/" + lines[0].split(" ", 1)[-1].strip()
                    packages.append({
                        "name": name,
                        "version": "1.0.0",
                        "status": "generated",
                        "digest": spec_digest,
                    })
                except Exception:
                    continue

    # Topology summary
    topology = {"registered": len(neurons), "waits": [], "joins": []}

    # Build the map
    capability_map = {
        "inspected_at_ms": now_ms,
        "neurons": neurons,
        "artifacts": artifacts,
        "messages": messages,
        "metrics": metrics,
        "packages": packages,
        "topology": topology,
    }

    map_bytes = __import__("json").dumps(capability_map, sort_keys=True, separators=(",", ":"))
    evidence = [{
        "claim": f"capability map with {len(artifacts)} artifact schemas, {len(neurons)} neurons, {len(packages)} packages",
        "sources": ["stimulus"],
        "method": "substrate-read inspection",
        "confidence_milli": 950,
    }]

    effects = [{
        "kind": "write",
        "artifact": {
            "id": "introspection/capability-map",
            "schema": CAPABILITY_MAP_SCHEMA,
            "bytes": map_bytes,
        },
    }]

    return decision({"kind": "terminate", "result": "map-generated"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
