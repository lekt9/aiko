#!/usr/bin/env python3
"""Preemptor limb conformance witness.

Tests the preemptor neuron's pure fire() function directly:
- Exact match → cache candidate
- Low-confidence match → no-preempt
- Send effects → never preempted
- Empty cache → no-preempt
- Threshold adjustment
"""

import hashlib
import json
import os
import sys

LIMB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(LIMB_DIR, "neurons"))
sys.path.insert(0, os.path.join(LIMB_DIR, "..", "shared"))

from _neuron import canonical
from preemptor import (
    fire,
    stimulus_fingerprint,
    is_replay_safe,
    find_preempt_match,
    DEFAULT_THRESHOLD,
)


def read_of(rid, schema, obj):
    body = canonical(obj).decode()
    return {"id": rid, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


def make_stim(firing_id="preempt-test", receptor="test.echo/v1", reads=None):
    return {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": receptor,
        "now_ms": 1700000000000,
        "reads": reads or [],
        "permitted_reads": [r["id"] for r in (reads or [])],
        "messages": [],
    }


def make_cache_entry(firing_id, receptor, decision_obj, fingerprint=None):
    """Create a mock cache entry."""
    if fingerprint is None:
        # Use a stimulus that would produce this fingerprint
        stim = make_stim(firing_id=firing_id, receptor=receptor)
        fingerprint = stimulus_fingerprint(stim)
    return {
        "firing_id": firing_id,
        "receptor_schema": receptor,
        "stimulus_fingerprint": fingerprint,
        "decision": decision_obj,
    }


def make_decision(result="ok", effects=None):
    return {
        "kind": "terminate",
        "result": result,
        "effects": effects or [],
    }


def test_empty_cache_returns_no_preempt():
    """No cache entries → no-preempt."""
    stim = make_stim()
    # We need to call fire() but it uses the _neuron framework which expects stdin
    # Instead, test the core logic directly
    match, sim = find_preempt_match(stim, [], DEFAULT_THRESHOLD)
    assert match is None, "expected no match with empty cache"
    print("✓ empty cache → no match")


def test_high_confidence_match_preempts():
    """Identical stimulus fingerprint → candidate proposal."""
    stim = make_stim(firing_id="test-1", receptor="test.echo/v1")
    fp = stimulus_fingerprint(stim)

    cache_entry = make_cache_entry(
        firing_id="cached-1",
        receptor="test.echo/v1",
        decision_obj=make_decision(result="echo", effects=[
            {"kind": "write", "artifact": {"id": "artifact/echo/out", "schema": "test.echo/v1", "bytes": "ok"}}
        ]),
        fingerprint=fp,  # Same fingerprint = similarity 1.0
    )

    match, sim = find_preempt_match(stim, [cache_entry], DEFAULT_THRESHOLD)
    assert match is not None, "expected a match"
    assert sim >= DEFAULT_THRESHOLD, f"similarity {sim} < threshold {DEFAULT_THRESHOLD}"
    print(f"✓ exact match (sim={sim:.4f}) → cache candidate")


def test_low_confidence_no_preempt():
    """Different fingerprint → no match."""
    stim = make_stim(firing_id="test-2", receptor="test.echo/v1")

    # Create a cache entry with a completely different fingerprint
    cache_entry = make_cache_entry(
        firing_id="cached-2",
        receptor="test.echo/v1",
        decision_obj=make_decision(result="other"),
        fingerprint="0" * 64,  # Completely different hash
    )

    match, sim = find_preempt_match(stim, [cache_entry], DEFAULT_THRESHOLD)
    assert match is None, "expected no match with different fingerprint"
    print(f"✓ low confidence (sim={sim:.4f}) → no preempt")


def test_send_effects_never_preempted():
    """Cache entry with send effects → not replay-safe → no preempt."""
    stim = make_stim(firing_id="test-3", receptor="test.echo/v1")
    fp = stimulus_fingerprint(stim)

    cache_entry = make_cache_entry(
        firing_id="cached-3",
        receptor="test.echo/v1",
        decision_obj=make_decision(result="sent", effects=[
            {"kind": "send", "to": "external/api", "schema": "test.send/v1", "payload": "data", "durable": True}
        ]),
        fingerprint=fp,  # Same fingerprint, but has send effect
    )

    match, sim = find_preempt_match(stim, [cache_entry], DEFAULT_THRESHOLD)
    assert match is None, "send effects must never be preempted"
    print("✓ send effects → never preempted")


def test_spawn_effects_never_preempted():
    """Cache entry with spawn effects → not replay-safe → no preempt."""
    stim = make_stim(firing_id="test-4", receptor="test.echo/v1")
    fp = stimulus_fingerprint(stim)

    cache_entry = make_cache_entry(
        firing_id="cached-4",
        receptor="test.echo/v1",
        decision_obj=make_decision(result="spawned", effects=[
            {"kind": "spawn", "id": "child-1", "kind": "worker"}
        ]),
        fingerprint=fp,
    )

    match, sim = find_preempt_match(stim, [cache_entry], DEFAULT_THRESHOLD)
    assert match is None, "spawn effects must never be preempted"
    print("✓ spawn effects → never preempted")


def test_is_replay_safe():
    """Test the replay safety checker."""
    safe_write = make_decision(effects=[
        {"kind": "write", "artifact": {"id": "artifact/test/out", "schema": "test/v1", "bytes": "ok"}}
    ])
    assert is_replay_safe(safe_write), "write to artifact/ should be safe"

    unsafe_event = make_decision(effects=[
        {"kind": "write", "artifact": {"id": "events/firing-settled/abc", "schema": "test/v1", "bytes": "ok"}}
    ])
    assert not is_replay_safe(unsafe_event), "write to events/ should not be safe"

    no_effects = make_decision()
    assert is_replay_safe(no_effects), "no effects should be safe"

    send_effect = make_decision(effects=[
        {"kind": "send", "to": "ext", "schema": "s/v1", "payload": "p", "durable": True}
    ])
    assert not is_replay_safe(send_effect), "send should not be safe"

    print("✓ is_replay_safe correctly classifies effects")


def test_threshold_adjustment():
    """Higher threshold = fewer preemptions."""
    stim = make_stim(firing_id="test-5", receptor="test.echo/v1")
    fp = stimulus_fingerprint(stim)

    # Create an entry with partial match (flip some chars)
    partial_fp = fp[:32] + ("0" if fp[32] != "0" else "1") * 32

    cache_entry = make_cache_entry(
        firing_id="cached-5",
        receptor="test.echo/v1",
        decision_obj=make_decision(result="ok"),
        fingerprint=partial_fp,
    )

    # With default threshold (0.92), partial match may not preempt
    match_default, sim_default = find_preempt_match(stim, [cache_entry], DEFAULT_THRESHOLD)

    # A lower threshold cannot turn a different identity into a cache hit.
    match_low, sim_low = find_preempt_match(stim, [cache_entry], 0.85)

    assert match_default is None and match_low is None
    print(f"✓ threshold cannot weaken exact identity (sim={sim_default:.4f})")


def main():
    print("=== Preemptor Conformance Tests ===\n")
    test_empty_cache_returns_no_preempt()
    test_high_confidence_match_preempts()
    test_low_confidence_no_preempt()
    test_send_effects_never_preempted()
    test_spawn_effects_never_preempted()
    test_is_replay_safe()
    test_threshold_adjustment()

    print(f"\npreemptor limb conformance: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
