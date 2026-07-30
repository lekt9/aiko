#!/usr/bin/env python3
"""limb-designer Neuron — generates a limb/v1 spec + manifest from a capability gap.

Pure policy neuron (§2). Reads a gap entry from the stimulus, generates:
1. A limb/v1 DSL spec (inert data, pending admission)
2. A typed-neuron.limb-manifest/v1 (inert data, pending admission)

The generated package is NOT admitted or attached — those are harness-level
operations (§30). This neuron only performs the "describe + write" phases.
"""

import hashlib
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


def raw_digest(data):
    """SHA-256 hex digest of raw bytes (not JSON-canonicalized)."""
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()

GAP_SCHEMA = "neuron.gap/v1"
LIMB_SPEC_SCHEMA = "neuron.limb-spec/v1"
LIMB_MANIFEST_SCHEMA = "neuron.limb-manifest/v1"


def generate_limb_spec(gap):
    """Generate a limb/v1 DSL spec from a capability gap."""
    kind = gap.get("kind", "")
    identity = gap.get("desired_identity") or gap.get("desired_package") or "generated-limb"
    schema = gap.get("desired_schema", "")

    # Sanitize names for the DSL
    safe_name = identity.replace("/", "-").replace(" ", "-").lower()
    safe_id = f"introspection/{safe_name}"
    safe_schema = schema or f"introspection.{safe_name}/v1"

    lines = [f"limb/v1 {safe_name}"]

    if kind == "neuron":
        # Generate a neuron that terminates with the desired identity as result
        lines.append(f"on {safe_schema} write introspection/{safe_name}/result introspection.result/v1 ok")
        lines.append(f"on * terminate {safe_name}-registered")
    elif kind == "schema":
        # Generate a schema-producing neuron
        lines.append(f"on introspection.generate-schema/v1 write introspection/{safe_name}/schema {safe_schema} {{\"registered\":true}}")
        lines.append(f"on * terminate schema-written")
    elif kind == "package":
        # Generate a package-routing neuron
        lines.append(f"on introspection.discover-package/v1 spawn introspection/{safe_name}-worker {safe_name}")
        lines.append(f"on * terminate {safe_name}-routed")
    else:
        # Generic handler
        lines.append(f"on {safe_schema} write introspection/{safe_name}/handled introspection.result/v1 handled")
        lines.append(f"on * terminate handled")

    return "\n".join(lines)


def generate_manifest(gap, spec_text):
    """Generate a typed-neuron.limb-manifest/v1 from a gap and spec."""
    kind = gap.get("kind", "")
    identity = gap.get("desired_identity") or gap.get("desired_package") or "generated-limb"
    safe_name = identity.replace("/", "-").replace(" ", "-").lower()
    spec_digest = raw_digest(spec_text)

    caps_request = {
        "allow_write": True,
        "write_prefix": f"introspection/{safe_name}/",
        "allow_send": False,
        "allow_spawn": kind == "package",
        "budget": {
            "max_effects": 2,
            "max_writes": 2,
            "max_messages": 0,
            "max_spawns": 1,
            "max_bytes": 65536,
            "max_depth": 1,
        },
    }

    return {
        "schema": "typed-neuron.limb-manifest/v1",
        "package": f"introspection/{safe_name}",
        "version": "0.1.0",
        "description": f"Generated limb for gap: {gap.get('detail', 'unknown gap')}",
        "neurons": [
            {
                "id": f"{safe_name}",
                "argv": ["echo", spec_text],
                "caps_request": caps_request,
            }
        ],
        "budgets": {
            "deadline_ms_per_firing": 5000,
        },
        "source_gap": gap,
        "spec_digest": spec_digest,
    }


def fire(stim):
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    # Read gap from reads
    gap = None
    for ref in stim["reads"]:
        if ref.get("schema") == GAP_SCHEMA:
            try:
                gap = json.loads(ref["bytes"])
            except Exception:
                continue
            break

    if gap is None:
        # Try messages
        for msg in stim.get("messages", []):
            try:
                if msg.get("schema") == GAP_SCHEMA:
                    gap = json.loads(msg.get("payload", "{}"))
                    break
            except Exception:
                continue

    if gap is None:
        raise Reject("dependency", "no gap entry found in reads or messages")

    status = gap.get("status", "absent")
    if status == "present":
        # Nothing to generate — capability already exists
        evidence = [{
            "claim": "no generation needed: capability is already present",
            "sources": ["stimulus"],
            "method": "gap status check",
            "confidence_milli": 1000,
        }]
        return decision({"kind": "terminate", "result": "no-gap"}, [], evidence, stim)

    if gap.get("suggest_action") not in ("generate_limb", "upgrade_version"):
        evidence = [{
            "claim": f"no limb generation needed: suggested action is {gap.get('suggest_action')}",
            "sources": ["stimulus"],
            "method": "gap action check",
            "confidence_milli": 950,
        }]
        return decision({"kind": "terminate", "result": "no-limb-needed"}, [], evidence, stim)

    # Generate
    spec_text = generate_limb_spec(gap)
    manifest = generate_manifest(gap, spec_text)

    spec_bytes = spec_text
    spec_hash = raw_digest(spec_text)
    manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    manifest_hash = raw_digest(manifest_bytes)

    # Build the limb-spec artifact
    limb_spec = {
        "spec": spec_text,
        "digest": spec_hash,
        "source_gap": gap,
    }
    limb_spec_bytes = json.dumps(limb_spec, sort_keys=True, separators=(",", ":"))

    # Build the limb-manifest artifact
    limb_manifest = {
        "manifest": manifest,
        "digest": manifest_hash,
        "source_spec_digest": spec_hash,
    }
    limb_manifest_bytes = json.dumps(limb_manifest, sort_keys=True, separators=(",", ":"))

    evidence = [{
        "claim": f"generated limb spec {spec_hash[:16]}... and manifest {manifest_hash[:16]}... for gap",
        "sources": ["stimulus"],
        "method": "limb/v1 DSL generation from capability gap template",
        "confidence_milli": 850,
    }]

    safe_name = (gap.get("desired_identity") or gap.get("desired_package") or "generated-limb").replace("/", "-").replace(" ", "-").lower()

    effects = [
        {
            "kind": "write",
            "artifact": {
                "id": f"introspection/{safe_name}/limb-spec",
                "schema": LIMB_SPEC_SCHEMA,
                "bytes": limb_spec_bytes,
            },
        },
        {
            "kind": "write",
            "artifact": {
                "id": f"introspection/{safe_name}/limb-manifest",
                "schema": LIMB_MANIFEST_SCHEMA,
                "bytes": limb_manifest_bytes,
            },
        },
    ]

    return decision({"kind": "terminate", "result": "limb-generated"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
