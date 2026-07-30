#!/usr/bin/env python3
"""promoter Neuron — observes firing patterns and proposes hot candidates for limb promotion.

Pure policy neuron (§2). Reads:
- A capability map (from inspector) — what already exists
- Firing records (from substrate reads) — what's been firing

Identifies "hot" patterns: neurons that fire repeatedly on a receptor schema,
succeed consistently, and produce stable effect shapes. For each hot pattern,
generates a `neuron.promote-proposal/v1` artifact with a limb/v1 spec and
evidence backing. The proposal is inert — the harness must independently
admit before the limb becomes executable (§30).

This closes the mechanical gap: useful firings are automatically observed,
ranked, and proposed for promotion. The admission gate remains the safety
boundary.
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

CAPABILITY_MAP_SCHEMA = "neuron.capability-map/v1"
PROMOTE_PROPOSAL_SCHEMA = "neuron.promote-proposal/v1"

# Patterns become "hot" when they exceed these thresholds
MIN_FIRINGS_FOR_PROMOTION = 3
MIN_SUCCESS_RATE = 0.8
MIN_CACHE_HIT_RATE = 0.3  # At least some replay evidence


def raw_digest(data):
    """SHA-256 hex digest of raw bytes."""
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def generate_limb_spec(identity, receptor_pattern, effects_summary):
    """Generate a limb/v1 DSL spec for a firing pattern."""
    safe_name = identity.replace("/", "-").replace(" ", "-").lower()
    lines = [f"limb/v1 {safe_name}"]

    for fx in effects_summary:
        kind = fx["kind"]
        schema = fx.get("schema", "unknown/v1")
        if kind == "write":
            # Generate a write rule — the artifact id and bytes are templates
            lines.append(
                f"on {receptor_pattern} write introspective/{safe_name}/result {schema} ok"
            )
        elif kind == "send":
            lines.append(
                f"on {receptor_pattern} send channel/{safe_name} {schema} ok"
            )
        elif kind == "spawn":
            lines.append(
                f"on {receptor_pattern} spawn {safe_name}-worker {safe_name}"
            )

    # Default catch-all
    if not effects_summary:
        lines.append(f"on {receptor_pattern} terminate handled")
    lines.append(f"on * terminate no-match")

    return "\n".join(lines)


def promotion_confidence(committed, total, cache_hits, effect_consistency):
    """Score 0..1 for promotion worthiness."""
    if total < MIN_FIRINGS_FOR_PROMOTION:
        return 0.0

    success_rate = committed / max(total, 1)
    if success_rate < MIN_SUCCESS_RATE:
        return 0.0

    # Weight: success rate (40%), frequency (20%), cache hits (20%), consistency (20%)
    freq_score = min(1.0, total / 10.0)  # Caps at 10 firings
    cache_score = min(1.0, cache_hits / max(total, 1) / MIN_CACHE_HIT_RATE)
    consistency_score = effect_consistency

    return (
        0.4 * success_rate
        + 0.2 * freq_score
        + 0.2 * cache_score
        + 0.2 * consistency_score
    )


def suggest_action(confidence):
    if confidence >= 0.7:
        return "promote"
    if confidence >= 0.4:
        return "observe_more"
    return "do_not_promote"


def fire(stim):
    stim.setdefault("reads", [])
    stim.setdefault("messages", [])

    now_ms = stim.get("now_ms", 0)

    # Try to find a capability map in reads
    capability_map = None
    for ref in stim["reads"]:
        if ref.get("schema") == CAPABILITY_MAP_SCHEMA:
            try:
                capability_map = json.loads(ref["bytes"])
            except Exception:
                continue
            break

    # Collect firing records from reads. Firing records have schemas like
    # "neuron.firing-record/v1" — or we can derive patterns from artifact
    # "produced_by" fields and cached firings in the substrate reads.
    #
    # In practice, the harness stages firing records as reads with schemas
    # we can inspect. For now, we use the capability map's existing data
    # plus any explicit firing-record reads.

    firing_records = []
    for ref in stim["reads"]:
        schema = ref.get("schema", "")
        if schema in ("neuron.firing-record/v1", "neuron.firing-summary/v1"):
            try:
                record = json.loads(ref["bytes"])
                if isinstance(record, list):
                    firing_records.extend(record)
                else:
                    firing_records.append(record)
            except Exception:
                continue

    # Also extract from capability map metadata
    known_neurons = {}
    if capability_map:
        for neuron in capability_map.get("neurons", []):
            identity = neuron.get("identity", "")
            if identity:
                known_neurons[identity] = neuron

        # Artifact schema counts give us effect shape data
        for artifact in capability_map.get("artifacts", []):
            for aid in artifact.get("ids", []):
                # Artifact IDs encode producer info: e.g., "agents/reference/work/a"
                # was produced by "meta/executor-a"
                parts = aid.split("/")
                if len(parts) >= 2:
                    producer_hint = "/".join(parts[:-1])

    # Build pattern summaries from the evidence we have
    proposals = []

    # For each known neuron, check if it's a promotion candidate
    for identity, neuron_info in known_neurons.items():
        # Exclude meta/system neurons — they're infrastructure
        if identity.startswith("meta/bootstrap") or identity.startswith("meta/settler"):
            continue

        # Look for firing records for this neuron
        identity_firings = [r for r in firing_records if r.get("identity") == identity]

        # Also derive from capability map: if artifacts exist with this neuron's
        # identity prefix, count them as "fired"
        artifact_count = 0
        if capability_map:
            for artifact in capability_map.get("artifacts", []):
                for aid in artifact.get("ids", []):
                    if identity in aid or aid.startswith(f"agents/reference/{identity.split('/')[-1]}"):
                        artifact_count += 1

        # If we have explicit firing records, use them
        if identity_firings:
            committed = sum(1 for r in identity_firings if r.get("status") == "committed")
            rejected = sum(1 for r in identity_firings if r.get("status") == "rejected")
            failed = sum(1 for r in identity_firings if r.get("status") == "failed")
            total = len(identity_firings)
            cache_hits = sum(1 for r in identity_firings if r.get("replayed", False))

            # Determine receptor pattern from first record
            receptor = identity_firings[0].get("receptor_schema", "unknown/v1")

            # Typical effects from committed firings
            effect_kinds = {}
            for r in identity_firings:
                if r.get("status") != "committed":
                    continue
                for fx in r.get("effects_summary", []):
                    key = (fx.get("kind", ""), fx.get("schema", ""))
                    effect_kinds[key] = effect_kinds.get(key, 0) + 1

            total_effects = max(sum(effect_kinds.values()), 1)
            effects_summary = [
                {
                    "kind": k[0],
                    "schema": k[1],
                    "frequency": v / total_effects,
                }
                for k, v in sorted(effect_kinds.items(), key=lambda x: -x[1])
            ]

            # Effect consistency: how uniform are the effects across firings?
            # More uniform = higher consistency = better candidate for limb
            committed_count = max(committed, 1)
            effect_consistency = min(
                1.0,
                committed_count / max(len(effect_kinds), 1),
            ) if effect_kinds else 0.5

            success_rate = committed / max(total, 1)
        elif artifact_count >= MIN_FIRINGS_FOR_PROMOTION:
            # Derive from artifacts
            committed = artifact_count
            rejected = 0
            failed = 0
            total = artifact_count
            cache_hits = 0
            receptor = f"typed-neuron.{identity.split('/')[-1]}/v1" if "/" in identity else "unknown/v1"
            effects_summary = [{"kind": "write", "schema": "unknown/v1", "frequency": 1.0}]
            effect_consistency = 0.7
            success_rate = 1.0
        else:
            continue

        conf = promotion_confidence(committed, total, cache_hits, effect_consistency)
        action = suggest_action(conf)

        # Only generate proposals for promote or observe_more
        if action == "do_not_promote":
            continue

        limb_spec = ""
        limb_digest = ""
        if action == "promote":
            limb_spec = generate_limb_spec(identity, receptor, effects_summary)
            limb_digest = raw_digest(limb_spec)

        # Derive minimal caps from observed effects
        needs_write = any(fx["kind"] == "write" for fx in effects_summary)
        needs_send = any(fx["kind"] == "send" for fx in effects_summary)
        needs_spawn = any(fx["kind"] == "spawn" for fx in effects_summary)

        proposal = {
            "neuron_identity": identity,
            "neuron_version": neuron_info.get("version", "1.0.0"),
            "receptor_pattern": receptor,
            "evidence": {
                "total_firings": total,
                "committed": committed,
                "rejected": rejected,
                "failed": failed,
                "success_rate": round(success_rate, 3),
                "cache_hits": cache_hits,
                "typical_effects": effects_summary,
                "typical_reads": [],
            },
            "requested_caps": {
                "allow_write": needs_write,
                "write_prefix": f"introspective/{identity.replace('/', '-')}/",
                "allow_send": needs_send,
                "send_prefix": f"channel/{identity.replace('/', '-')}/",
                "allow_spawn": needs_spawn,
                "max_effects": min(8, total),
                "max_writes": 2 if needs_write else 0,
                "max_messages": 2 if needs_send else 0,
                "max_spawns": 1 if needs_spawn else 0,
                "max_bytes": 65536,
                "max_depth": 1,
            },
            "generated_limb_spec": limb_spec,
            "generated_limb_digest": limb_digest,
            "confidence": round(conf, 3),
            "suggest_action": action,
            "generated_at_ms": now_ms,
        }
        proposals.append(proposal)

    # Sort by confidence descending
    proposals.sort(key=lambda p: -p["confidence"])

    if not proposals:
        evidence = [{
            "claim": "no firing patterns met promotion thresholds",
            "sources": ["stimulus"],
            "method": "pattern-frequency analysis against capability map",
            "confidence_milli": 950,
        }]
        return decision({"kind": "terminate", "result": "no-candidates"}, [], evidence, stim)

    # Produce one proposal artifact per candidate (up to budget)
    effects = []
    for i, proposal in enumerate(proposals[:3]):  # Cap at 3 proposals per firing
        identity = proposal["neuron_identity"].replace("/", "-").replace(" ", "-").lower()
        proposal_bytes = json.dumps(proposal, sort_keys=True, separators=(",", ":"))
        effects.append({
            "kind": "write",
            "artifact": {
                "id": f"introspection/promote-proposal/{identity}",
                "schema": PROMOTE_PROPOSAL_SCHEMA,
                "bytes": proposal_bytes,
            },
        })

    promote_count = sum(1 for p in proposals if p["suggest_action"] == "promote")
    evidence = [{
        "claim": f"promotion analysis: {promote_count} promote, {len(proposals) - promote_count} observe-more out of {len(proposals)} candidates",
        "sources": ["stimulus"],
        "method": "firing-pattern frequency + success-rate + effect-consistency scoring",
        "confidence_milli": 850,
    }]

    return decision({"kind": "terminate", "result": f"{len(effects)}-proposals"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
