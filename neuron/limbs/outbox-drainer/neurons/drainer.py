#!/usr/bin/env python3
"""drainer Neuron — pick eligible queued messages for one channel partition and
re-declare them as adapter-bound sends, paired with attempt records (G5, §30 limb).

Pure policy (§2): the queued-message projection and every prior attempt/delivery
record arrive as digest-pinned reads. For each eligible message the drainer
declares two effects:

    write  artifact/outbox/attempts/<key>/<n>   (outbox.delivery-attempt/v1)
    send   <original channel>                   (envelope with idempotency key)

It never touches an adapter, a secret, or a clock beyond the stimulus (§24).
Eligibility is folded from the record history, so a duplicate drain of an
already-terminal or in-flight message declares nothing (§21). An empty
eligible set settles as terminate "drained" — a valid settlement rule (§26).
"""

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_refs, artifact_ref, canonical, decision, digest, run

REQUEST_SCHEMA = "outbox.drain-request/v1"
PROJECTION_SCHEMA = "outbox.queued-messages/v1"
ATTEMPT_SCHEMA = "outbox.delivery-attempt/v1"
DELIVERY_SCHEMA = "outbox.delivery-record/v1"

TERMINAL = ("acknowledged", "dead_letter")
ELIGIBLE_AGAIN = ("retryable",)


def message_key(msg):
    """Stable message identity (§21): content over (firing_id, to, schema, payload)."""
    basis = "|".join((msg["firing_id"], msg["to"], msg["schema"], msg["payload"]))
    return hashlib.sha256(basis.encode()).hexdigest()


def fold_records(attempt_reads, delivery_reads):
    """Reduce the record history to per-key state: {key: {status, attempts}}."""
    state = {}
    for _ref, rec in attempt_reads:
        key = rec.get("key")
        if not key:
            raise Reject("poisoned_input", "attempt record missing key")
        entry = state.setdefault(key, {"status": "queued", "attempts": 0})
        entry["attempts"] = max(entry["attempts"], int(rec.get("attempt", 0)))
        if entry["status"] not in TERMINAL:
            entry["status"] = "attempting"
    for _ref, rec in delivery_reads:
        key = rec.get("key")
        status = rec.get("status")
        if not key or status not in TERMINAL + ELIGIBLE_AGAIN + ("reconciliation_required",):
            raise Reject("poisoned_input", f"delivery record malformed: {key}")
        entry = state.setdefault(key, {"status": "queued", "attempts": 0})
        entry["attempts"] = max(entry["attempts"], int(rec.get("attempts", 0)))
        if entry["status"] not in TERMINAL:
            entry["status"] = status
    return state


def fire(stim):
    if stim["receptor_schema"] != REQUEST_SCHEMA:
        raise Reject("validation", f"drainer expects receptor {REQUEST_SCHEMA}")
    req_ref, request = artifact_ref(stim, REQUEST_SCHEMA)
    proj_ref, projection = artifact_ref(stim, PROJECTION_SCHEMA)

    for field in ("partition", "max_batch", "max_attempts"):
        if field not in request:
            raise Reject("poisoned_input", f"drain request missing field: {field}")
    partition = request["partition"]
    max_batch = int(request["max_batch"])
    max_attempts = int(request["max_attempts"])
    if projection.get("partition") != partition:
        raise Reject("poisoned_input", "projection partition does not match the request")

    attempt_reads = artifact_refs(stim, ATTEMPT_SCHEMA)
    delivery_reads = artifact_refs(stim, DELIVERY_SCHEMA)
    state = fold_records(attempt_reads, delivery_reads)

    eligible = []
    seen = set()
    for msg in projection.get("messages", []):
        for field in ("key", "firing_id", "to", "schema", "payload"):
            if field not in msg:
                raise Reject("poisoned_input", f"queued message missing field: {field}")
        if msg["key"] != message_key(msg):
            raise Reject("poisoned_input", f"queued message key mismatch: {msg['key']}")
        if not msg["to"].startswith(partition):
            continue  # outside this drainer's partition: not ours to touch
        key = msg["key"]
        if key in seen:
            continue  # duplicate ingest of the same message (§21)
        seen.add(key)
        entry = state.get(key, {"status": "queued", "attempts": 0})
        if entry["status"] == "queued" or (
            entry["status"] in ELIGIBLE_AGAIN and entry["attempts"] < max_attempts
        ):
            eligible.append((key, entry["attempts"], msg))
    eligible.sort(key=lambda item: item[0])  # deterministic batch order (§25)
    batch = eligible[:max_batch]

    sources = [req_ref["id"], proj_ref["id"]]
    sources.extend(ref["id"] for ref, _rec in attempt_reads)
    sources.extend(ref["id"] for ref, _rec in delivery_reads)

    if not batch:
        return decision(
            control={"kind": "terminate", "result": "drained"},
            effects=[],
            evidence=[{
                "claim": f"no eligible queued messages for partition {partition}",
                "sources": sources,
                "method": "outbox-drainer",
            }],
            stim=stim,
        )

    effects = []
    for key, attempts, msg in batch:
        attempt = attempts + 1
        record = {
            "schema": ATTEMPT_SCHEMA,
            "key": key,
            "message": {
                "firing_id": msg["firing_id"],
                "to": msg["to"],
                "schema": msg["schema"],
                "payload": msg["payload"],
            },
            "attempt": attempt,
            "status": "attempting",
            "drained_by": stim["firing_id"],
            "drained_at": stim.get("now_ms", 0),
        }
        effects.append({
            "kind": "write",
            "artifact": {
                "id": f"artifact/outbox/attempts/{key}/{attempt}",
                "schema": ATTEMPT_SCHEMA,
                "bytes": canonical(record).decode(),
                "digest": digest(record),
            },
        })
        envelope = {
            "idempotency_key": key,
            "to": msg["to"],
            "schema": msg["schema"],
            "payload": msg["payload"],
        }
        effects.append({
            "kind": "send",
            "message": {
                "to": msg["to"],
                "schema": msg["schema"],
                "payload": json.dumps(envelope, sort_keys=True, separators=(",", ":")),
                "durable": True,
            },
        })

    return decision(
        control={"kind": "continue", "wait_for": partition},
        effects=effects,
        evidence=[{
            "claim": f"declared {len(batch)} adapter-bound sends for partition {partition}",
            "sources": sources,
            "method": "outbox-drainer",
        }],
        stim=stim,
    )


if __name__ == "__main__":
    sys.exit(run(fire))
