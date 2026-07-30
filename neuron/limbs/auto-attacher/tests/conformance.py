#!/usr/bin/env python3
"""Auto-attacher limb conformance witness.

Tests the attacher neuron's pure logic:
- Creates edge manifests for each receptor schema
- Edge manifests have required topology fields (§26)
- No receptors → no-receptors result
- Missing admission → dependency rejection
"""

import hashlib
import json
import os
import sys

LIMB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(LIMB_DIR, "neurons"))
sys.path.insert(0, os.path.join(LIMB_DIR, "..", "shared"))

from _neuron import canonical
from attacher import (
    extract_receptor_schemas,
    create_edge_manifest,
    fire,
    ADMISSION_SCHEMA,
    EDGE_MANIFEST_SCHEMA,
)


def read_of(rid, schema, obj):
    body = canonical(obj).decode()
    return {"id": rid, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


def make_manifest(package="test-limb", schemas=None, neurons=None):
    return {
        "schema": "typed-neuron.limb-manifest/v1",
        "package": package,
        "version": "0.1.0",
        "description": "Test limb",
        "neurons": neurons or [{"id": "test-neuron", "accepts": [], "emits": [], "argv": ["python3", "neurons/test.py"], "caps_request": {}}],
        "schemas": schemas or {},
    }


def make_admission(digest="abc123def456", manifest=None):
    if manifest is None:
        manifest = make_manifest()
    return {
        "schema": ADMISSION_SCHEMA,
        "digest": digest,
        "package": json.dumps(manifest, sort_keys=True, separators=(",", ":")),
    }


def make_stim(admission=None, firing_id="attach-test"):
    reads = []
    if admission:
        reads.append(read_of("admission-1", ADMISSION_SCHEMA, admission))
    return {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": "neuron.attach-request/v1",
        "now_ms": 1700000000000,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": [],
        "budget": {
            "max_effects": 32,
            "max_writes": 8,
            "max_messages": 16,
            "max_spawns": 8,
            "max_bytes": 1024 * 1024,
            "max_depth": 8,
        },
    }


def test_extract_receptor_schemas():
    """Test receptor schema extraction from manifest."""
    manifest = make_manifest(neurons=[{
        "id": "test-neuron",
        "accepts": ["test.echo-request/v1", "test.input/v1"],
        "emits": ["test.echo-result/v1", "test.output/v1"],
        "argv": ["python3", "neurons/test.py"],
        "caps_request": {},
    }])
    receptors = extract_receptor_schemas(manifest)
    assert ("test-neuron", "test.echo-request/v1") in receptors
    assert ("test-neuron", "test.input/v1") in receptors
    assert all(schema not in ("test.echo-result/v1", "test.output/v1") for _, schema in receptors)
    print(f"✓ extract_receptor_schemas: found {len(receptors)} receptors")


def test_create_edge_manifest():
    """Test edge manifest creation has required §26 fields."""
    edge = create_edge_manifest(
        admission_digest="abc123",
        neuron_id="test-neuron",
        receptor_schema="test.echo-request/v1",
        manifest_package="test-limb",
    )
    assert edge["schema"] == EDGE_MANIFEST_SCHEMA
    assert edge["source"] == "receptor/test.echo-request/v1"
    assert edge["destination"] == "neuron/limb/abc123/test-neuron"
    assert edge["predicate"] == "schema-match"
    assert edge["delivery_mode"] == "stimulus"
    assert "priority" in edge
    assert "budget" in edge
    assert "partition_key" in edge
    print("✓ create_edge_manifest: all §26 fields present")


def test_no_receptors():
    """Manifest with no request schemas → no-receptors."""
    manifest = make_manifest(schemas={
        "Output": "test.output/v1",
    })
    admission = make_admission(manifest=manifest)
    stim = make_stim(admission=admission)

    # Call fire directly — it uses the _neuron framework
    # We need to capture stdout
    import io
    old_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        rc = fire(stim)
        output = sys.stdout.getvalue()
    finally:
        sys.stdout = old_stdout

    decision_obj = json.loads(output)
    assert decision_obj["control"]["result"] == "no-receptors"
    assert len(decision_obj["effects"]) == 0
    print("✓ no receptors → no-receptors result")


def test_creates_edges_for_receptors():
    """Manifest with request schemas → edge manifests written."""
    manifest = make_manifest(
        package="test-echo",
        schemas={
            "Request": "test.echo-request/v1",
            "Result": "test.echo-result/v1",
        },
        neurons=[{
            "id": "echo-neuron",
            "accepts": ["test.echo-request/v1"],
            "emits": ["test.echo-result/v1"],
            "argv": ["python3", "neurons/echo.py"],
            "caps_request": {},
        }],
    )
    admission = make_admission(digest="deadbeef", manifest=manifest)
    stim = make_stim(admission=admission, firing_id="attach-1")

    import io
    old_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        rc = fire(stim)
        output = sys.stdout.getvalue()
    finally:
        sys.stdout = old_stdout

    decision_obj = json.loads(output)
    assert decision_obj["control"]["result"] == "attached-1-edges"
    assert len(decision_obj["effects"]) == 2  # 1 edge + 1 attach-result

    # Check the edge manifest
    edge_effect = decision_obj["effects"][0]
    assert edge_effect["kind"] == "write"
    assert edge_effect["artifact"]["schema"] == EDGE_MANIFEST_SCHEMA
    edge_id = edge_effect["artifact"]["id"]
    assert "deadbeef" in edge_id
    assert "test-echo-request-v1" in edge_id

    # Verify the edge content
    edge_data = json.loads(edge_effect["artifact"]["bytes"])
    assert edge_data["destination"] == "neuron/limb/deadbeef/echo-neuron"
    assert edge_data["source"] == "receptor/test.echo-request/v1"
    print("✓ creates edge manifests for each receptor schema")


def test_missing_admission_rejects():
    """No admission artifact → dependency rejection."""
    stim = make_stim(admission=None)

    from _neuron import Reject
    try:
        fire(stim)
        # If fire() doesn't raise, it should have output a rejection via decision()
        # This shouldn't happen for missing admission, but handle it
        assert False, "expected Reject to be raised"
    except Reject as exc:
        assert exc.failure == "dependency"
    except Exception as exc:
        assert False, f"expected Reject, got {type(exc).__name__}: {exc}"
    print("✓ missing admission → dependency rejection")


def main():
    print("=== Auto-Attacher Conformance Tests ===\n")
    test_extract_receptor_schemas()
    test_create_edge_manifest()
    test_no_receptors()
    test_creates_edges_for_receptors()
    test_missing_admission_rejects()

    print(f"\nauto-attacher limb conformance: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
