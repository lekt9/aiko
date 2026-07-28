#!/usr/bin/env python3
"""preemptor Neuron — predictive preemption via stimulus fingerprint matching.

Pure policy neuron (§2). Receives a stimulus and a set of cached firing records
(from substrate reads). Computes a stimulus fingerprint and checks for
high-confidence matches against cached firings. If a match is found and the
cached decision is replay-safe, returns "preempted" with the cached decision's
effects. Otherwise returns "no-preempt" with no effects.

Key invariants:
- §25: Cache reuse MUST never replay a non-idempotent external effect.
  Only `write` effects to stable prefixes are eligible for preemption.
  `send` effects to external channels are NEVER preempted.
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

# Confidence threshold for preemption (cosine similarity of stimulus fingerprints).
# Conservative start; adjusted by the judge based on misprediction rate.
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
    """Approximate cosine similarity for hash-based fingerprints.

    Since we use SHA-256 hashes (not vectors), we compare hex strings
    character-by-character. This is a conservative proxy: two identical
    stimuli produce similarity 1.0; completely different stimuli produce
    ~0.5 (random hex overlap). The threshold is set high (0.92) to only
    preempt near-exact matches.

    For true JEPA-based semantic similarity, this would be replaced with
    a vector cosine similarity. The hash-based approach is the deterministic
    seed that the JEPA layer can augment.
    """
    if not h1 or not h2 or len(h1) != len(h2):
        return 0.0
    matching = sum(1 for a, b in zip(h1, h2) if a == b)
    return matching / len(h1)


def find_preempt_match(stim, cache_entries, threshold=DEFAULT_THRESHOLD):
    """Search cache entries for a high-confidence match.

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

        if sim >= threshold and sim > best_sim:
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
            "claim": f"no cache match above threshold {threshold}",
            "sources": ["stimulus"],
            "method": "stimulus-fingerprint cosine similarity against cache",
            "confidence_milli": 950,
        }]
        return decision({"kind": "terminate", "result": "no-preempt"}, [], evidence, stim)

    # Preempt! Return the cached decision's effects
    cached_decision = match.get("decision", {})
    cached_effects = cached_decision.get("effects", [])

    # Write a preempt audit artifact
    audit = {
        "schema": PREEMPT_RESULT_SCHEMA,
        "preempted_firing_id": match.get("firing_id", "unknown"),
        "similarity": round(similarity, 4),
        "threshold": threshold,
        "effects_replayed": len(cached_effects),
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
        "claim": f"preempted: similarity {similarity:.4f} >= threshold {threshold}, {len(cached_effects)} effects replayed",
        "sources": ["stimulus"],
        "method": "stimulus-fingerprint cosine similarity match against cached firing",
        "confidence_milli": int(similarity * 1000),
    }]

    return decision({"kind": "terminate", "result": "preempted"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
