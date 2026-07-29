#!/usr/bin/env python3
"""Introspection-trigger limb conformance witness.

Tests the trigger neuron's pure logic:
- Counts firings and resets on introspection
- Fires introspection at cadence
- Fires introspection on high energy
- Cadence stays within bounds
"""

import hashlib
import json
import os
import sys

LIMB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(LIMB_DIR, "neurons"))
sys.path.insert(0, os.path.join(LIMB_DIR, "..", "shared"))

from _neuron import canonical
from trigger import (
    fire,
    load_trigger_state,
    should_trigger,
    adapt_cadence,
    DEFAULT_CADENCE,
    MIN_CADENCE,
    MAX_CADENCE,
    FIRING_SETTLED_SCHEMA,
    TRIGGER_STATE_SCHEMA,
)


def read_of(rid, schema, obj):
    body = canonical(obj).decode()
    return {"id": rid, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


def make_stim(firing_id="trigger-test", energy=None, state=None):
    reads = []
    if state:
        reads.append(read_of("trigger-state", TRIGGER_STATE_SCHEMA, state))
    if energy is not None:
        reads.append(read_of("energy-1", "energy.score/v1", {"energy": energy}))
    return {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": FIRING_SETTLED_SCHEMA,
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


def make_state(count=0, cadence=DEFAULT_CADENCE, streak=0):
    return {
        "schema": TRIGGER_STATE_SCHEMA,
        "firings_since_introspection": count,
        "cadence": cadence,
        "no_proposal_streak": streak,
        "last_introspection_ms": 0,
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


def test_counts_firings():
    """Below cadence → counted, counter increments."""
    state = make_state(count=0, cadence=50)
    stim = make_stim(firing_id="count-1", state=state)
    result = run_fire(stim)
    assert result["control"]["result"] == "counted"

    # Check the state was updated
    state_effect = [e for e in result["effects"] if e["kind"] == "write"][0]
    new_state = json.loads(state_effect["artifact"]["bytes"])
    assert new_state["firings_since_introspection"] == 1
    print("✓ counts firings: 0 → 1")


def test_fires_at_cadence():
    """At cadence → triggered, sends introspection message."""
    state = make_state(count=49, cadence=50)
    stim = make_stim(firing_id="cadence-50", state=state)
    result = run_fire(stim)
    assert result["control"]["result"] == "triggered"

    # Should have a send effect to introspection
    send_effects = [e for e in result["effects"] if e["kind"] == "send"]
    assert len(send_effects) == 1
    assert send_effects[0]["message"]["to"] == "neuron/introspection/inspector"

    # State should reset
    write_effects = [e for e in result["effects"] if e["kind"] == "write"]
    new_state = json.loads(write_effects[0]["artifact"]["bytes"])
    assert new_state["firings_since_introspection"] == 0
    print("✓ fires at cadence: count=49+1=50 → triggered")


def test_fires_on_high_energy():
    """High energy → triggered early."""
    state = make_state(count=5, cadence=50)
    stim = make_stim(firing_id="energy-high", energy=0.85, state=state)
    result = run_fire(stim)
    assert result["control"]["result"] == "triggered"

    send_effects = [e for e in result["effects"] if e["kind"] == "send"]
    assert len(send_effects) == 1
    print("✓ fires on high energy: count=5, energy=0.85 → triggered")


def test_does_not_fire_below_threshold():
    """Low energy + below cadence → counted."""
    state = make_state(count=5, cadence=50)
    stim = make_stim(firing_id="energy-low", energy=0.3, state=state)
    result = run_fire(stim)
    assert result["control"]["result"] == "counted"
    print("✓ does not fire: count=5, energy=0.3 → counted")


def test_adapt_cadence_doubles_on_no_proposals():
    """3 consecutive no-proposal runs → cadence doubles."""
    cadence, streak = adapt_cadence(make_state(count=0, cadence=50, streak=2), 0)
    assert cadence == 100, f"expected 100, got {cadence}"
    assert streak == 3
    print("✓ cadence doubles: 50 → 100 after 3 no-proposal streak")


def test_adapt_cadence_halves_on_proposals():
    """Proposals generated → cadence halves."""
    cadence, streak = adapt_cadence(make_state(count=0, cadence=50, streak=0), 3)
    assert cadence == 25, f"expected 25, got {cadence}"
    assert streak == 0
    print("✓ cadence halves: 50 → 25 when proposals active")


def test_adapt_cadence_bounds():
    """Cadence never exceeds MAX or goes below MIN."""
    cadence, _ = adapt_cadence(make_state(count=0, cadence=200, streak=2), 0)
    assert cadence == MAX_CADENCE, f"expected {MAX_CADENCE}, got {cadence}"

    cadence, _ = adapt_cadence(make_state(count=0, cadence=10, streak=0), 1)
    assert cadence == MIN_CADENCE, f"expected {MIN_CADENCE}, got {cadence}"
    print(f"✓ cadence bounds: [{MIN_CADENCE}, {MAX_CADENCE}]")


def test_wrong_receptor_rejects():
    """Wrong receptor schema → validation rejection."""
    stim = make_stim()
    stim["receptor_schema"] = "wrong.schema/v1"
    from _neuron import Reject
    try:
        fire(stim)
        assert False, "expected Reject to be raised"
    except Reject as exc:
        assert exc.failure == "validation"
    except Exception as exc:
        assert False, f"expected Reject, got {type(exc).__name__}: {exc}"
    print("✓ wrong receptor → validation rejection")


def main():
    print("=== Introspection-Trigger Conformance Tests ===\n")
    test_counts_firings()
    test_fires_at_cadence()
    test_fires_on_high_energy()
    test_does_not_fire_below_threshold()
    test_adapt_cadence_doubles_on_no_proposals()
    test_adapt_cadence_halves_on_proposals()
    test_adapt_cadence_bounds()
    test_wrong_receptor_rejects()

    print(f"\nintrospection-trigger limb conformance: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
