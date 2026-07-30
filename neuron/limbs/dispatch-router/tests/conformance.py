#!/usr/bin/env python3
"""Dispatch-router limb conformance witness.

Tests the dispatcher neuron's pure logic:
- Selects matching limb over model
- Falls through to model when no limb matches
- Selects lowest energy candidate
- Decision is recorded in substrate
- Model path energy always >= 2.0
"""

import hashlib
import json
import os
import sys

LIMB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(LIMB_DIR, "neurons"))
sys.path.insert(0, os.path.join(LIMB_DIR, "..", "shared"))

from _neuron import canonical
from dispatcher import (
    fire,
    firing_energy,
    model_path_energy,
    score_limb_candidate,
    find_matching_edges,
    EDGE_MANIFEST_SCHEMA,
    DISPATCH_LOG_SCHEMA,
)


def read_of(rid, schema, obj):
    body = canonical(obj).decode()
    return {"id": rid, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


def make_edge(source_schema, dest="neuron/limb/abc123/neuron-1", digest="abc123"):
    return {
        "schema": EDGE_MANIFEST_SCHEMA,
        "source": f"receptor/{source_schema}",
        "destination": dest,
        "predicate": "schema-match",
        "delivery_mode": "stimulus",
        "partition_key": source_schema,
        "priority": 50,
        "budget": {"max_firings": 100, "max_cost": 1000},
        "admission_digest": digest,
        "package": "test-limb",
    }


def make_stim(firing_id="dispatch-test", receptor="test.echo/v1", edges=None):
    reads = []
    if edges:
        for i, edge in enumerate(edges):
            reads.append(read_of(f"edge-{i}", EDGE_MANIFEST_SCHEMA, edge))
    return {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": receptor,
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


def run_fire(stim):
    """Call fire() and capture the decision JSON."""
    import io
    old_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        fire(stim)
        output = sys.stdout.getvalue()
    finally:
        sys.stdout = old_stdout
    return json.loads(output)


def test_model_path_energy():
    """Model path energy is always >= 2.0."""
    e = model_path_energy()
    assert e >= 2.0, f"model path energy {e} < 2.0"
    print(f"✓ model path energy = {e} >= 2.0")


def test_limb_energy_lower_than_model():
    """A matched limb has lower energy than the model path."""
    limb_e = score_limb_candidate(make_edge("test.echo/v1"), "test.echo/v1")
    model_e = model_path_energy()
    assert limb_e < model_e, f"limb {limb_e} >= model {model_e}"
    print(f"✓ limb energy {limb_e} < model {model_e}")


def test_no_matching_limb_dispatches_to_model():
    """No edge manifests → dispatched-to-model."""
    stim = make_stim(receptor="test.unknown/v1", edges=[])
    result = run_fire(stim)
    assert result["control"]["result"] == "dispatched-to-model"

    # Should have a dispatch log
    write_effects = [e for e in result["effects"] if e["kind"] == "write"]
    assert len(write_effects) == 1
    log = json.loads(write_effects[0]["artifact"]["bytes"])
    assert log["decision"] == "model"
    assert log["candidates_evaluated"] == 0
    print("✓ no matching limb → dispatched-to-model")


def test_matching_limb_dispatches_to_limb():
    """Edge manifest matches receptor → dispatched-to-limb."""
    edge = make_edge("test.echo/v1")
    stim = make_stim(receptor="test.echo/v1", edges=[edge])
    result = run_fire(stim)
    assert result["control"]["result"] == "dispatched-to-limb"

    # Should have a send effect to the limb
    send_effects = [e for e in result["effects"] if e["kind"] == "send"]
    assert len(send_effects) == 1
    assert send_effects[0]["message"]["to"] == "neuron/limb/abc123/neuron-1"
    print("✓ matching limb → dispatched-to-limb")


def test_selects_lowest_energy():
    """Multiple limbs → lowest energy wins (first in sorted order)."""
    # Both have the same energy (same score_limb_candidate), so the first one wins
    edge1 = make_edge("test.echo/v1", dest="neuron/limb/digest1/neuron-1", digest="digest1")
    edge2 = make_edge("test.echo/v1", dest="neuron/limb/digest2/neuron-2", digest="digest2")
    stim = make_stim(receptor="test.echo/v1", edges=[edge1, edge2])
    result = run_fire(stim)
    assert result["control"]["result"] == "dispatched-to-limb"

    # Should dispatch to the first (lowest energy, since both are equal)
    send_effects = [e for e in result["effects"] if e["kind"] == "send"]
    assert len(send_effects) == 1

    # Check dispatch log shows both candidates evaluated
    write_effects = [e for e in result["effects"] if e["kind"] == "write"]
    log = json.loads(write_effects[0]["artifact"]["bytes"])
    assert log["candidates_evaluated"] == 2
    print("✓ multiple limbs → lowest energy selected (2 candidates evaluated)")


def test_dispatch_decision_recorded():
    """Dispatch decision is recorded as a substrate artifact."""
    edge = make_edge("test.echo/v1")
    stim = make_stim(firing_id="dispatch-record-test", receptor="test.echo/v1", edges=[edge])
    result = run_fire(stim)

    write_effects = [e for e in result["effects"] if e["kind"] == "write"]
    assert len(write_effects) == 1
    assert write_effects[0]["artifact"]["id"] == "dispatch/dispatch-record-test"
    assert write_effects[0]["artifact"]["schema"] == DISPATCH_LOG_SCHEMA

    log = json.loads(write_effects[0]["artifact"]["bytes"])
    assert "decision" in log
    assert "best_limb_energy" in log
    assert "model_energy" in log
    print("✓ dispatch decision recorded in substrate")


def test_wrong_receptor_no_match():
    """Edge for different receptor → dispatched-to-model."""
    edge = make_edge("other.schema/v1")
    stim = make_stim(receptor="test.echo/v1", edges=[edge])
    result = run_fire(stim)
    assert result["control"]["result"] == "dispatched-to-model"
    print("✓ wrong receptor edge → dispatched-to-model")


def main():
    print("=== Dispatch-Router Conformance Tests ===\n")
    test_model_path_energy()
    test_limb_energy_lower_than_model()
    test_no_matching_limb_dispatches_to_model()
    test_matching_limb_dispatches_to_limb()
    test_selects_lowest_energy()
    test_dispatch_decision_recorded()
    test_wrong_receptor_no_match()

    print(f"\ndispatch-router limb conformance: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
