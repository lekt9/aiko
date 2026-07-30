#!/usr/bin/env python3
"""trigger Neuron — reactive introspection trigger on firing-count cadence.

Pure policy neuron (§2). Receives a firing-settled event stimulus and:
1. Reads the trigger state (counter of firings since last introspection)
2. Increments the counter
3. If counter >= CADENCE or energy exceeded threshold:
   - Sends a message to neuron/introspection/inspector
   - Resets counter
   - Returns "triggered"
4. Otherwise returns "counted" with updated counter

Key invariants:
- §8: "An incoming event becomes a stimulus that causes one or more Neurons
  to fire." The trigger fires on the firing-settled event.
- §26: "Loops MUST expose a monotonic progress measure or bounded attempts."
  The counter is the progress measure. The cadence is the bound.
- §2: Pure and stateless — all state comes from the stimulus and reads.
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

FIRING_SETTLED_SCHEMA = "neuron.firing-settled/v1"
TRIGGER_STATE_SCHEMA = "neuron.introspection-trigger-state/v1"
TRIGGER_FIRE_SCHEMA = "neuron.introspection-trigger-fire/v1"

# Default cadence: fire introspection every 50 committed firings
DEFAULT_CADENCE = 50
MIN_CADENCE = 10
MAX_CADENCE = 200

# Energy threshold: if any receptor's last energy score exceeded this, trigger early
DEFAULT_ENERGY_THRESHOLD = 0.7

# Cadence adaptation: if no proposals for 3 consecutive runs, double cadence (max MAX_CADENCE)
# If proposals are being generated, halve cadence (min MIN_CADENCE)
NO_PROPOSAL_STREAK_LIMIT = 3


def load_trigger_state(stim):
    """Read the trigger state from substrate reads, or return default."""
    ref, body = artifact_ref(stim, TRIGGER_STATE_SCHEMA, required=False)
    if body is not None:
        return ref, body
    # Default state
    return None, {
        "schema": TRIGGER_STATE_SCHEMA,
        "firings_since_introspection": 0,
        "cadence": DEFAULT_CADENCE,
        "no_proposal_streak": 0,
        "last_introspection_ms": 0,
    }


def should_trigger(state, energy_score=None):
    """Decide whether to trigger introspection now."""
    count = state.get("firings_since_introspection", 0) + 1  # +1 for this firing
    cadence = state.get("cadence", DEFAULT_CADENCE)

    if count >= cadence:
        return True

    if energy_score is not None and energy_score >= DEFAULT_ENERGY_THRESHOLD:
        return True

    return False


def adapt_cadence(state, proposals_generated):
    """Adapt the cadence based on introspection results.

    If no proposals for 3 consecutive runs → double cadence (system is stable)
    If proposals are being generated → halve cadence (system is evolving)
    """
    cadence = state.get("cadence", DEFAULT_CADENCE)
    streak = state.get("no_proposal_streak", 0)

    if proposals_generated == 0:
        streak += 1
        if streak >= NO_PROPOSAL_STREAK_LIMIT:
            cadence = min(cadence * 2, MAX_CADENCE)
    else:
        streak = 0
        cadence = max(cadence // 2, MIN_CADENCE)

    return cadence, streak


def fire(stim):
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    # Only fire on firing-settled events
    receptor = stim.get("receptor_schema", "")
    if receptor != FIRING_SETTLED_SCHEMA:
        raise Reject("validation", f"trigger expects {FIRING_SETTLED_SCHEMA}, got {receptor}")

    # Load trigger state
    state_ref, state = load_trigger_state(stim)

    # Check for energy score in the firing-settled event
    # The event payload may contain the last energy score
    energy_score = None
    for ref in stim.get("reads", []):
        if ref.get("schema") == "energy.score/v1":
            try:
                score_data = json.loads(ref.get("bytes", "{}"))
                energy_score = float(score_data.get("energy", 1.0))
            except Exception:
                continue

    # Also check messages
    for msg in stim.get("messages", []):
        if msg.get("schema") == "energy.score/v1":
            try:
                score_data = json.loads(msg.get("payload", "{}"))
                energy_score = float(score_data.get("energy", 1.0))
            except Exception:
                continue

    # Check if we should trigger
    if should_trigger(state, energy_score):
        # Send a message to the introspection inspector
        introspection_msg = {
            "schema": TRIGGER_FIRE_SCHEMA,
            "trigger": "cadence" if energy_score is None else "energy",
            "firings_since_last": state.get("firings_since_introspection", 0) + 1,
            "energy_score": energy_score,
            "triggered_at_ms": stim.get("now_ms", 0),
        }

        # Reset state
        new_state = {
            "schema": TRIGGER_STATE_SCHEMA,
            "firings_since_introspection": 0,
            "cadence": state.get("cadence", DEFAULT_CADENCE),
            "no_proposal_streak": state.get("no_proposal_streak", 0),
            "last_introspection_ms": stim.get("now_ms", 0),
        }
        state_bytes = json.dumps(new_state, sort_keys=True, separators=(",", ":"))

        state_artifact = {
            "id": "introspection-trigger/state",
            "schema": TRIGGER_STATE_SCHEMA,
            "bytes": state_bytes,
        }
        if state_ref is not None:
            state_artifact["expected_prior"] = state_ref["digest"]
        effects = [
            {
                "kind": "send",
                "message": {
                    "to": "neuron/introspection/inspector",
                    "schema": TRIGGER_FIRE_SCHEMA,
                    "payload": json.dumps(introspection_msg, sort_keys=True, separators=(",", ":")),
                    "durable": True,
                },
            },
            {
                "kind": "write",
                "artifact": state_artifact,
            },
        ]

        trigger_reason = "cadence" if energy_score is None else f"energy={energy_score:.3f}"
        evidence = [{
            "claim": f"triggered introspection: {trigger_reason}, count={state.get('firings_since_introspection', 0) + 1}",
            "sources": ["stimulus"] if state_ref is None else ["stimulus", state_ref["id"]],
            "method": "firing-count cadence + energy threshold check",
            "confidence_milli": 1000,
        }]

        return decision({"kind": "terminate", "result": "triggered"}, effects, evidence, stim)
    else:
        # Just increment the counter
        new_state = {
            "schema": TRIGGER_STATE_SCHEMA,
            "firings_since_introspection": state.get("firings_since_introspection", 0) + 1,
            "cadence": state.get("cadence", DEFAULT_CADENCE),
            "no_proposal_streak": state.get("no_proposal_streak", 0),
            "last_introspection_ms": state.get("last_introspection_ms", 0),
        }
        state_bytes = json.dumps(new_state, sort_keys=True, separators=(",", ":"))

        state_artifact = {
            "id": "introspection-trigger/state",
            "schema": TRIGGER_STATE_SCHEMA,
            "bytes": state_bytes,
        }
        if state_ref is not None:
            state_artifact["expected_prior"] = state_ref["digest"]
        effects = [{
            "kind": "write",
            "artifact": state_artifact,
        }]

        evidence = [{
            "claim": f"counted firing: {new_state['firings_since_introspection']}/{new_state['cadence']}",
            "sources": ["stimulus"] if state_ref is None else ["stimulus", state_ref["id"]],
            "method": "firing-count increment",
            "confidence_milli": 1000,
        }]

        return decision({"kind": "terminate", "result": "counted"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
