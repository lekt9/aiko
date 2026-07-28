#!/usr/bin/env python3
"""attacher Neuron — auto-wires admitted limbs to matching receptor schemas.

Pure policy neuron (§2). Receives a stimulus containing:
- admission_digest: the digest of the newly admitted limb
- manifest: the admitted limb's neuron.json (from the admission artifact)

Extracts receptor schemas from the manifest and writes edge manifests
to topology/edges/<admitted_digest>/<receptor_schema>. Each edge routes
stimuli matching the receptor schema to the admitted limb's neuron.

Key invariants:
- §30.4: "A limb receives no ambient authority." The attacher only writes
  edge manifests — it does not grant caps. Caps were declared in caps_request
  and granted at admission time. The edge just routes stimuli.
- §26: "Topology is typed, versioned data." Edge manifests include source,
  destination, predicate, delivery_mode, priority, and budget.
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
    decision,
    run,
)

ADMISSION_SCHEMA = "neuron.limb-admission/v1"
EDGE_MANIFEST_SCHEMA = "neuron.edge-manifest/v1"
ATTACH_RESULT_SCHEMA = "neuron.attach-result/v1"

# Default priority for auto-attached limbs (below manual/high-priority edges)
DEFAULT_PRIORITY = 50
DEFAULT_MAX_FIRINGS = 100
DEFAULT_MAX_COST = 1000


def extract_receptor_schemas(manifest):
    """Extract receptor schemas from a limb manifest.

    The manifest's 'schemas' field maps schema names to versioned schema strings.
    Request schemas (ending in -request/v1 or similar) are the receptors
    that this limb can handle. We also include any schema that looks like
    a request/input schema.
    """
    schemas = manifest.get("schemas", {})
    if not isinstance(schemas, dict):
        return []

    receptors = []
    for name, schema_uri in schemas.items():
        if not isinstance(schema_uri, str):
            continue
        # Request schemas are receptors (e.g., "pipeline.stage-request/v1")
        name_lower = name.lower()
        schema_lower = schema_uri.lower()
        if any(kw in name_lower or kw in schema_lower for kw in ("request", "input", "trigger", "stimulus")):
            receptors.append(schema_uri)

    # Also check neurons for receptor_schema patterns in their argv
    # (some neurons declare their receptor in the code, not the manifest)
    # We can't read the code here, but the schemas field should cover it.

    return receptors


def create_edge_manifest(admission_digest, neuron_id, receptor_schema, manifest_package):
    """Create a typed edge manifest (§26).

    An edge names: source, destination, predicate, delivery_mode,
    partition_key, priority, and budget.
    """
    return {
        "schema": EDGE_MANIFEST_SCHEMA,
        "source": f"receptor/{receptor_schema}",
        "destination": f"limb/{admission_digest}/{neuron_id}",
        "predicate": "schema-match",
        "delivery_mode": "stimulus",
        "partition_key": receptor_schema,
        "priority": DEFAULT_PRIORITY,
        "budget": {
            "max_firings": DEFAULT_MAX_FIRINGS,
            "max_cost": DEFAULT_MAX_COST,
        },
        "admission_digest": admission_digest,
        "package": manifest_package,
    }


def fire(stim):
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    # Read the admission artifact from stimulus reads
    admission_ref, admission = artifact_ref(stim, ADMISSION_SCHEMA, required=False)

    if admission is None:
        # Try messages
        for msg in stim.get("messages", []):
            if msg.get("schema") == ADMISSION_SCHEMA:
                try:
                    admission = json.loads(msg.get("payload", "{}"))
                    break
                except Exception:
                    continue

    if admission is None:
        raise Reject("dependency", "no admission artifact found in reads or messages")

    # Extract the admission digest and manifest
    admission_digest = admission.get("digest", "")
    if not admission_digest:
        raise Reject("validation", "admission artifact missing digest")

    # The admission artifact's 'package' field contains the manifest JSON
    package_field = admission.get("package", "")
    if isinstance(package_field, str):
        try:
            manifest = json.loads(package_field)
        except Exception as exc:
            raise Reject("poisoned_input", f"admission package is not JSON: {exc}")
    elif isinstance(package_field, dict):
        manifest = package_field
    else:
        raise Reject("validation", "admission artifact missing package manifest")

    # Extract receptor schemas from the manifest
    receptors = extract_receptor_schemas(manifest)
    manifest_package = manifest.get("package", "unknown")

    if not receptors:
        evidence = [{
            "claim": f"no receptor schemas found in manifest for {manifest_package}",
            "sources": ["stimulus"],
            "method": "manifest schema inspection",
            "confidence_milli": 950,
        }]
        return decision({"kind": "terminate", "result": "no-receptors"}, [], evidence, stim)

    # Get neuron IDs from manifest
    neurons = manifest.get("neurons", [])
    if not neurons:
        raise Reject("validation", "manifest has no neurons")

    # Create edge manifests for each receptor × neuron combination
    # In practice, most limbs have one neuron that handles all receptors,
    # but we support multi-neuron limbs by attaching the first neuron to each receptor.
    primary_neuron = neurons[0].get("id", "default")

    effects = []
    edges_created = 0
    for receptor_schema in receptors:
        edge = create_edge_manifest(
            admission_digest=admission_digest,
            neuron_id=primary_neuron,
            receptor_schema=receptor_schema,
            manifest_package=manifest_package,
        )
        edge_bytes = json.dumps(edge, sort_keys=True, separators=(",", ":"))

        # Sanitize receptor schema for artifact ID
        safe_receptor = receptor_schema.replace("/", "-").replace(".", "-")
        edge_id = f"topology/edges/{admission_digest}/{safe_receptor}"

        effects.append({
            "kind": "write",
            "artifact": {
                "id": edge_id,
                "schema": EDGE_MANIFEST_SCHEMA,
                "bytes": edge_bytes,
            },
        })
        edges_created += 1

    # Write an attach result summary
    result = {
        "schema": ATTACH_RESULT_SCHEMA,
        "admission_digest": admission_digest,
        "package": manifest_package,
        "edges_created": edges_created,
        "receptors": receptors,
        "neuron_id": primary_neuron,
    }
    result_bytes = json.dumps(result, sort_keys=True, separators=(",", ":"))
    effects.append({
        "kind": "write",
        "artifact": {
            "id": f"topology/edges/{admission_digest}/attach-result",
            "schema": ATTACH_RESULT_SCHEMA,
            "bytes": result_bytes,
        },
    })

    evidence = [{
        "claim": f"created {edges_created} edge(s) for {manifest_package} (digest {admission_digest[:16]}...)",
        "sources": ["stimulus"],
        "method": "manifest schema extraction + edge manifest generation",
        "confidence_milli": 900,
    }]

    return decision(
        {"kind": "terminate", "result": f"attached-{edges_created}-edges"},
        effects,
        evidence,
        stim,
    )


if __name__ == "__main__":
    sys.exit(run(fire))
