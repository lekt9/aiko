#!/usr/bin/env python3
"""Full self-building limb loop integration test (§30 architectural falsifier).

Proves the closed loop end-to-end:
1. Preemptor: exact safe match → candidate, send → no candidate
2. Auto-attacher: admission → edge manifests created for each receptor
3. Introspection-trigger: counts firings, triggers at cadence, triggers on high energy
4. Dispatch-router: matching limb beats model, no match → model wins

This is a fast policy-unit composition test. It intentionally does not prove
runtime wiring; tests/self-constructing-agent-gate.sh is the binding witness
and exercises the Zig runtime plus durable substrate.

If any of the four work items is missing, the test fails at a specific step.
"""

import hashlib
import json
import os
import sys
import tempfile

NEURON_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

# Add all limb paths
for limb in ("preemptor", "auto-attacher", "introspection-trigger", "dispatch-router"):
    sys.path.insert(0, os.path.join(NEURON_ROOT, "limbs", limb, "neurons"))
sys.path.insert(0, os.path.join(NEURON_ROOT, "limbs", "shared"))

from _neuron import canonical


def raw_digest(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def read_of(rid, schema, obj):
    body = canonical(obj).decode()
    return {"id": rid, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


DEFAULT_BUDGET = {
    "max_effects": 32, "max_writes": 8, "max_messages": 16,
    "max_spawns": 8, "max_bytes": 1024 * 1024, "max_depth": 8,
}


def make_stim(firing_id, receptor, reads=None, messages=None):
    reads = reads or []
    return {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": receptor,
        "now_ms": 1700000000000,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": messages or [],
        "budget": dict(DEFAULT_BUDGET),
    }


def run_fire(limb_module, stim):
    """Call a limb's fire() and capture the decision JSON from stdout."""
    import io
    old_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        limb_module.fire(stim)
        output = sys.stdout.getvalue()
    finally:
        sys.stdout = old_stdout
    return json.loads(output)


# ─── Simulated substrate ──────────────────────────────────────────────────

class SimulatedSubstrate:
    """Minimal in-memory substrate that tracks artifacts and firings."""

    def __init__(self):
        self.artifacts = {}  # id → {schema, bytes, digest}
        self.firings = {}    # firing_id → {status, decision_digest}
        self.edges = []      # edge manifests

    def write_artifact(self, aid, schema, data):
        body = canonical(data).decode() if isinstance(data, (dict, list)) else str(data)
        self.artifacts[aid] = {
            "id": aid,
            "schema": schema,
            "bytes": body,
            "digest": raw_digest(body),
        }
        return self.artifacts[aid]

    def get_artifact(self, aid):
        return self.artifacts.get(aid)

    def get_artifacts_by_schema(self, schema):
        return [a for a in self.artifacts.values() if a["schema"] == schema]

    def commit_firing(self, firing_id, decision, effects):
        self.firings[firing_id] = {
            "status": "committed",
            "decision": decision,
            "effects": effects,
            "decision_digest": raw_digest(canonical(decision).decode()),
        }


# ─── Test steps ────────────────────────────────────────────────────────────

def step_1_preemptor_high_confidence(substrate):
    """Preemptor: identical stimulus fingerprint → preempted."""
    from preemptor import fire, stimulus_fingerprint, PREEMPT_CACHE_SCHEMA

    # Create a cached firing — the stimulus has NO cache reads (just the receptor)
    cached_stim = make_stim("cached-echo-1", "test.echo/v1")
    cached_fp = stimulus_fingerprint(cached_stim)
    cached_decision = {
        "kind": "terminate",
        "result": "echo-back",
        "effects": [
            {"kind": "write", "artifact": {"id": "artifact/echo/out", "schema": "test.echo/v1", "bytes": "hello"}}
        ],
    }

    cache_entry = {
        "firing_id": "cached-echo-1",
        "receptor_schema": "test.echo/v1",
        "stimulus_fingerprint": cached_fp,
        "decision": cached_decision,
    }
    substrate.write_artifact("preempt/cache-1", PREEMPT_CACHE_SCHEMA, cache_entry)

    # Fire the preemptor with an identical stimulus (same reads = same fingerprint)
    # Pass the cache entry via messages so it doesn't change the fingerprint
    new_stim = make_stim("new-echo-1", "test.echo/v1",
                         messages=[{"to": "", "schema": PREEMPT_CACHE_SCHEMA,
                                    "payload": json.dumps(cache_entry), "durable": True}])

    result = run_fire(sys.modules["preemptor"], new_stim)
    assert result["control"]["result"] == "cache-candidate", f"expected cache-candidate, got {result['control']['result']}"
    audit = json.loads(result["effects"][0]["artifact"]["bytes"])
    assert audit["effects_replayed"] == 0
    assert audit["requires_canonical_revalidation"] is True
    print("  ✓ step 1: preemptor proposes an exact candidate and replays zero effects")


def step_2_preemptor_send_never_preempted(substrate):
    """Preemptor: send effects → never preempted."""
    from preemptor import fire, stimulus_fingerprint, PREEMPT_CACHE_SCHEMA

    cached_stim = make_stim("cached-send-1", "test.send/v1")
    cached_fp = stimulus_fingerprint(cached_stim)
    cached_decision = {
        "kind": "terminate",
        "result": "sent",
        "effects": [
            {"kind": "send", "to": "external/api", "schema": "test.send/v1", "payload": "data", "durable": True}
        ],
    }

    cache_entry = {
        "firing_id": "cached-send-1",
        "receptor_schema": "test.send/v1",
        "stimulus_fingerprint": cached_fp,
        "decision": cached_decision,
    }

    new_stim = make_stim("new-send-1", "test.send/v1",
                         messages=[{"to": "", "schema": PREEMPT_CACHE_SCHEMA,
                                    "payload": json.dumps(cache_entry), "durable": True}])

    result = run_fire(sys.modules["preemptor"], new_stim)
    assert result["control"]["result"] == "no-preempt", f"send effects must never be preempted, got {result['control']['result']}"
    print("  ✓ step 2: preemptor returns 'no-preempt' for send effects")


def step_3_auto_attacher_creates_edges(substrate):
    """Auto-attacher: admission → edge manifests for each receptor."""
    from attacher import fire, ADMISSION_SCHEMA, EDGE_MANIFEST_SCHEMA
    from _neuron import Reject

    manifest = {
        "schema": "typed-neuron.limb-manifest/v1",
        "package": "test-echo-limb",
        "version": "0.1.0",
        "neurons": [{
            "id": "echo-neuron",
            "accepts": ["test.echo-request/v1"],
            "emits": ["test.echo-result/v1"],
            "argv": ["python3", "neurons/echo.py"],
            "caps_request": {},
        }],
        "schemas": {
            "Request": "test.echo-request/v1",
            "Result": "test.echo-result/v1",
        },
    }

    admission = {
        "schema": ADMISSION_SCHEMA,
        "digest": "deadbeef12345678",
        "package": json.dumps(manifest, sort_keys=True, separators=(",", ":")),
    }

    stim = make_stim("attach-1", "neuron.attach-request/v1",
                     reads=[read_of("admission-1", ADMISSION_SCHEMA, admission)])

    result = run_fire(sys.modules["attacher"], stim)
    assert result["control"]["result"] == "attached-1-edges", f"expected attached-1-edges, got {result['control']['result']}"

    # Extract the edge manifest from effects
    edge_effects = [e for e in result["effects"] if e["kind"] == "write"
                    and e["artifact"]["schema"] == EDGE_MANIFEST_SCHEMA]
    assert len(edge_effects) == 1, f"expected 1 edge, got {len(edge_effects)}"

    edge_data = json.loads(edge_effects[0]["artifact"]["bytes"])
    substrate.edges.append(edge_data)
    print(f"  ✓ step 3: auto-attacher created 1 edge → {edge_data['destination']}")


def step_4_dispatch_router_selects_limb(substrate):
    """Dispatch-router: matching limb → dispatched-to-limb (energy beats model)."""
    from dispatcher import fire, EDGE_MANIFEST_SCHEMA, DISPATCH_LOG_SCHEMA

    # Build stimulus with the edge manifest from step 3 as a read
    edge_read = read_of("edge-1", EDGE_MANIFEST_SCHEMA, substrate.edges[0])
    stim = make_stim("dispatch-1", "test.echo-request/v1", reads=[edge_read])

    result = run_fire(sys.modules["dispatcher"], stim)
    assert result["control"]["result"] == "dispatched-to-limb", f"expected dispatched-to-limb, got {result['control']['result']}"

    # Verify it sent to the limb, not the model
    send_effects = [e for e in result["effects"] if e["kind"] == "send"]
    assert len(send_effects) == 1
    assert "neuron/limb/" in send_effects[0]["message"]["to"]
    print(f"  ✓ step 4: dispatch-router selected limb over model (→ {send_effects[0]['message']['to']})")


def step_5_dispatch_router_no_match_falls_through(substrate):
    """Dispatch-router: no matching limb → dispatched-to-model."""
    from dispatcher import fire

    stim = make_stim("dispatch-2", "test.unknown-request/v1", reads=[])

    result = run_fire(sys.modules["dispatcher"], stim)
    assert result["control"]["result"] == "dispatched-to-model", f"expected dispatched-to-model, got {result['control']['result']}"
    print("  ✓ step 5: dispatch-router falls through to model for unknown receptor")


def step_6_introspection_trigger_counts(substrate):
    """Introspection-trigger: below cadence → counted."""
    from trigger import fire, FIRING_SETTLED_SCHEMA, TRIGGER_STATE_SCHEMA

    state = {"schema": TRIGGER_STATE_SCHEMA, "firings_since_introspection": 0,
             "cadence": 50, "no_proposal_streak": 0, "last_introspection_ms": 0}
    stim = make_stim("settled-1", FIRING_SETTLED_SCHEMA,
                     reads=[read_of("trigger-state", TRIGGER_STATE_SCHEMA, state)])

    result = run_fire(sys.modules["trigger"], stim)
    assert result["control"]["result"] == "counted", f"expected counted, got {result['control']['result']}"

    # Verify counter incremented
    write_effects = [e for e in result["effects"] if e["kind"] == "write"]
    new_state = json.loads(write_effects[0]["artifact"]["bytes"])
    assert new_state["firings_since_introspection"] == 1
    print("  ✓ step 6: introspection-trigger counted (1/50)")


def step_7_introspection_trigger_fires_at_cadence(substrate):
    """Introspection-trigger: at cadence → triggered, sends to introspection."""
    from trigger import fire, FIRING_SETTLED_SCHEMA, TRIGGER_STATE_SCHEMA

    state = {"schema": TRIGGER_STATE_SCHEMA, "firings_since_introspection": 49,
             "cadence": 50, "no_proposal_streak": 0, "last_introspection_ms": 0}
    stim = make_stim("settled-50", FIRING_SETTLED_SCHEMA,
                     reads=[read_of("trigger-state-50", TRIGGER_STATE_SCHEMA, state)])

    result = run_fire(sys.modules["trigger"], stim)
    assert result["control"]["result"] == "triggered", f"expected triggered, got {result['control']['result']}"

    # Verify it sent a message to introspection
    send_effects = [e for e in result["effects"] if e["kind"] == "send"]
    assert len(send_effects) == 1
    assert send_effects[0]["message"]["to"] == "neuron/introspection/inspector"
    print("  ✓ step 7: introspection-trigger fired at cadence 50 → sent to inspector")


def step_8_introspection_trigger_high_energy(substrate):
    """Introspection-trigger: high energy → triggered early."""
    from trigger import fire, FIRING_SETTLED_SCHEMA, TRIGGER_STATE_SCHEMA

    state = {"schema": TRIGGER_STATE_SCHEMA, "firings_since_introspection": 5,
             "cadence": 50, "no_proposal_streak": 0, "last_introspection_ms": 0}
    energy_read = read_of("energy-1", "energy.score/v1", {"energy": 0.85})
    state_read = read_of("trigger-state-5", TRIGGER_STATE_SCHEMA, state)
    stim = make_stim("settled-energy", FIRING_SETTLED_SCHEMA,
                     reads=[state_read, energy_read])

    result = run_fire(sys.modules["trigger"], stim)
    assert result["control"]["result"] == "triggered", f"expected triggered on high energy, got {result['control']['result']}"
    print("  ✓ step 8: introspection-trigger fired on high energy (0.85)")


def main():
    print("=== Self-Building Limb Policy Composition Test ===")
    print("(fast unit witness; the runtime gate is binding)\n")

    substrate = SimulatedSubstrate()

    print("Step 1 — Preemptor: exact safe match → cache candidate")
    step_1_preemptor_high_confidence(substrate)

    print("Step 2 — Preemptor: send effects → never preempted")
    step_2_preemptor_send_never_preempted(substrate)

    print("Step 3 — Auto-attacher: admission → edge manifests created")
    step_3_auto_attacher_creates_edges(substrate)

    print("Step 4 — Dispatch-router: matching limb beats model")
    step_4_dispatch_router_selects_limb(substrate)

    print("Step 5 — Dispatch-router: unknown receptor → model fallback")
    step_5_dispatch_router_no_match_falls_through(substrate)

    print("Step 6 — Introspection-trigger: counts firings (1/50)")
    step_6_introspection_trigger_counts(substrate)

    print("Step 7 — Introspection-trigger: fires at cadence (50/50)")
    step_7_introspection_trigger_fires_at_cadence(substrate)

    print("Step 8 — Introspection-trigger: fires on high energy")
    step_8_introspection_trigger_high_energy(substrate)

    print(f"\n{'=' * 60}")
    print("SELF-BUILDING LIMB POLICY COMPOSITION: PASS")
    print(f"{'=' * 60}")
    print("""
Policy composition verified:
  • Preemptor: proposed exact candidate with zero replay, refused send effects
  • Auto-attacher: created edge manifest from admission artifact
  • Dispatch-router: selected limb (energy 0.8) over model (energy 10.0)
  • Dispatch-router: fell through to model on unknown receptor
  • Introspection-trigger: counted 1/50, triggered at 50/50, triggered on energy 0.85

All four pure policies compose in the expected shape:
  stimulus → preempt? → route to limb → fire → settle → count → 
  at cadence → introspect → generate → admit → auto-attach →
  next turn: preempt or route to new limb
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
