#!/usr/bin/env python3
"""preemptor Neuron — cache-candidate proposal via stimulus identity.

Pure policy neuron (§2). Receives a stimulus and a set of cached firing records
(from substrate reads). Computes a stimulus fingerprint and checks for
exact replay-safe matches against cached firings. A match is only a proposal:
the canonical Zig cache must independently recompute the complete identity,
revalidate current policy and reachability, and decide whether to reuse it.

Key invariants:
- §25: This limb never replays cached effects. It emits an inert candidate
  record; only the canonical runtime may reuse a committed Decision.
- §30: The preemptor is a limb, not a kernel feature. It proposes preemption;
  the runtime still validates the decision before committing.
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
    artifact_refs,
    decision,
    run,
)

PREEMPT_REQUEST_SCHEMA = "neuron.preempt-request/v1"
PREEMPT_CACHE_SCHEMA = "neuron.preempt-cache/v1"
PREEMPT_RESULT_SCHEMA = "neuron.preempt-result/v1"

# Kept in the request schema for compatibility. Cache eligibility itself is
# exact; learned similarity may rank candidates but can never establish reuse.
DEFAULT_THRESHOLD = 0.92
MIN_THRESHOLD = 0.85
MAX_THRESHOLD = 0.98


def raw_digest(data):
    """SHA-256 hex digest of raw bytes."""
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def stimulus_fingerprint(stim):
    """Compute a deterministic fingerprint of the stimulus for matching.

    The fingerprint captures: receptor_schema + canonical reads + caps fingerprint.
    Two stimuli with the same fingerprint will produce the same decision
    (assuming determinism, which we verify via replay).
    """
    parts = [stim.get("receptor_schema", "")]
    for ref in sorted(stim.get("reads", []), key=lambda r: r.get("id", "")):
        parts.append(ref.get("schema", ""))
        parts.append(ref.get("digest", ""))
    # Include caps fingerprint if present
    caps = stim.get("caps_fingerprint", "")
    if caps:
        parts.append(caps)
    return raw_digest("\n".join(parts))


def is_replay_safe(decision_obj):
    """Check if a cached decision is safe to replay (§25).

    Only write effects to stable prefixes are eligible.
    Send effects are NEVER preempted (external side effects).
    Spawn effects are NEVER preempted (child processes may have side effects).
    """
    effects = decision_obj.get("effects", [])
    if not effects:
        return True  # No effects = safe to replay
    for fx in effects:
        kind = fx.get("kind", "")
        if kind == "send":
            return False  # Never preempt external sends
        if kind == "spawn":
            return False  # Never preempt spawns
        if kind == "write":
            # Only preempt writes to stable prefixes (not temporary/event prefixes)
            artifact = fx.get("artifact", {})
            aid = artifact.get("id", "")
            # Block preemption of event/ephemeral prefixes
            if aid.startswith("events/") or aid.startswith("tmp/"):
                return False
        else:
            return False  # Unknown effect type = not safe
    return True


def cosine_similarity_hash(h1, h2):
    """Return exact content-identity agreement, never hash-shape similarity."""
    return 1.0 if h1 and h1 == h2 else 0.0


def find_preempt_match(stim, cache_entries, threshold=DEFAULT_THRESHOLD):
    """Search cache entries for an exact replay-safe candidate.

    Returns (cache_entry, similarity) if found, or (None, 0.0) if no match.
    """
    fp = stimulus_fingerprint(stim)
    best_match = None
    best_sim = 0.0

    for entry in cache_entries:
        cached_fp = entry.get("stimulus_fingerprint", "")
        if not cached_fp:
            continue

        sim = cosine_similarity_hash(fp, cached_fp)

        # Must be replay-safe
        cached_decision = entry.get("decision", {})
        if not is_replay_safe(cached_decision):
            continue

        # Must have matching receptor schema
        if entry.get("receptor_schema", "") != stim.get("receptor_schema", ""):
            continue

        if sim == 1.0 and sim >= threshold and sim > best_sim:
            best_match = entry
            best_sim = sim

    return best_match, best_sim


def fire(stim):
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    # Read preempt request (optional — if not present, we use the stimulus directly)
    request_ref, request = artifact_ref(stim, PREEMPT_REQUEST_SCHEMA, required=False)

    # Read all cache entries from substrate reads
    cache_entries = []
    for ref, body in artifact_refs(stim, PREEMPT_CACHE_SCHEMA):
        if isinstance(body, list):
            cache_entries.extend(body)
        elif isinstance(body, dict):
            cache_entries.append(body)

    # Also check messages for cache entries
    for msg in stim.get("messages", []):
        if msg.get("schema") == PREEMPT_CACHE_SCHEMA:
            try:
                payload = json.loads(msg.get("payload", "{}"))
                if isinstance(payload, list):
                    cache_entries.extend(payload)
                elif isinstance(payload, dict):
                    cache_entries.append(payload)
            except Exception:
                continue

    if not cache_entries:
        evidence = [{
            "claim": "no cache entries available for preemption check",
            "sources": ["stimulus"],
            "method": "cache-availability check",
            "confidence_milli": 1000,
        }]
        return decision({"kind": "terminate", "result": "no-preempt"}, [], evidence, stim)

    # Get threshold from request or use default
    threshold = DEFAULT_THRESHOLD
    if request and "threshold" in request:
        threshold = max(MIN_THRESHOLD, min(MAX_THRESHOLD, float(request["threshold"])))

    # Find a match
    match, similarity = find_preempt_match(stim, cache_entries, threshold)

    if match is None:
        evidence = [{
            "claim": "no exact replay-safe cache candidate",
            "sources": ["stimulus"],
            "method": "exact stimulus-fingerprint identity check",
            "confidence_milli": 950,
        }]
        return decision({"kind": "terminate", "result": "no-preempt"}, [], evidence, stim)

    # Proposal only. The canonical runtime owns reuse and effect safety.
    cached_decision = match.get("decision", {})
    cached_effects = cached_decision.get("effects", [])

    # Write a preempt audit artifact
    audit = {
        "schema": PREEMPT_RESULT_SCHEMA,
        "candidate_firing_id": match.get("firing_id", "unknown"),
        "similarity": round(similarity, 4),
        "threshold": threshold,
        "effects_replayed": 0,
        "cached_effects": len(cached_effects),
        "requires_canonical_revalidation": True,
    }
    audit_bytes = json.dumps(audit, sort_keys=True, separators=(",", ":"))

    effects = [{
        "kind": "write",
        "artifact": {
            "id": f"preempt/{stim['firing_id']}",
            "schema": PREEMPT_RESULT_SCHEMA,
            "bytes": audit_bytes,
        },
    }]

    evidence = [{
        "claim": f"proposed exact cache candidate {match.get('firing_id', 'unknown')}; zero effects replayed",
        "sources": ["stimulus"],
        "method": "exact identity proposal for canonical runtime revalidation",
        "confidence_milli": int(similarity * 1000),
    }]

    return decision({"kind": "terminate", "result": "cache-candidate"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
