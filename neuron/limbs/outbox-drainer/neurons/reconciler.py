#!/usr/bin/env python3
"""reconciler Neuron — settle one delivery from provider evidence (G5, §30 limb).

Two modes, selected by the settle-request read:

  settle    — fold an attempt record + the adapter's ack observation into a
              delivery record: acknowledged / retryable / dead_letter /
              reconciliation_required. The ack read IS the evidence (§23).
  reconcile — a parked (reconciliation_required) delivery is settled only by
              FRESH provider evidence staged as a new read: acknowledged or
              dead_letter. No fresh evidence is a typed insufficient_evidence
              rejection — delivery is never assumed (§23, §27).

Every settlement terminates as settled:<key> with exactly one write effect.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_refs, artifact_ref, canonical, decision, digest, run

REQUEST_SCHEMA = "outbox.settle-request/v1"
ATTEMPT_SCHEMA = "outbox.delivery-attempt/v1"
ACK_SCHEMA = "outbox.ack/v1"
DELIVERY_SCHEMA = "outbox.delivery-record/v1"


def write_record(stim, key, status, attempts, provider_ref, detail, sources,
                 parked_by_ack=None):
    record = {
        "schema": DELIVERY_SCHEMA,
        "key": key,
        "status": status,
        "attempts": attempts,
        "provider_ref": provider_ref,
        "detail": detail,
        "settled_by": stim["firing_id"],
        "settled_at": stim.get("now_ms", 0),
    }
    if parked_by_ack is not None:
        record["parked_by_ack"] = parked_by_ack
    return decision(
        control={"kind": "terminate", "result": f"settled:{key}"},
        effects=[{
            "kind": "write",
            "artifact": {
                "id": f"artifact/outbox/delivery/{key}/{attempts}",
                "schema": DELIVERY_SCHEMA,
                "bytes": canonical(record).decode(),
                "digest": digest(record),
            },
        }],
        evidence=[{"claim": f"delivery {key} settles as {status}", "sources": sources, "method": "outbox-drainer"}],
        stim=stim,
    )


def fire(stim):
    if stim["receptor_schema"] != REQUEST_SCHEMA:
        raise Reject("validation", f"reconciler expects receptor {REQUEST_SCHEMA}")
    req_ref, request = artifact_ref(stim, REQUEST_SCHEMA)
    for field in ("mode", "key", "max_attempts"):
        if field not in request:
            raise Reject("poisoned_input", f"settle request missing field: {field}")
    mode = request["mode"]
    key = request["key"]
    max_attempts = int(request["max_attempts"])

    if mode == "settle":
        att_ref, attempt = artifact_ref(stim, ATTEMPT_SCHEMA)
        ack_ref, ack = artifact_ref(stim, ACK_SCHEMA)
        if attempt.get("key") != key or ack.get("key") != key:
            raise Reject("poisoned_input", "attempt/ack key does not match the request")
        outcome = ack.get("outcome")
        attempts = int(attempt.get("attempt", 0))
        sources = [req_ref["id"], att_ref["id"], ack_ref["id"]]
        if outcome == "ack":
            return write_record(stim, key, "acknowledged", attempts,
                                ack.get("provider_ref"), ack.get("detail", ""), sources)
        if outcome == "retryable":
            status = "dead_letter" if attempts >= max_attempts else "retryable"
            return write_record(stim, key, status, attempts, None,
                                ack.get("detail", ""), sources)
        if outcome == "permanent":
            return write_record(stim, key, "dead_letter", attempts, None,
                                ack.get("detail", ""), sources)
        if outcome == "uncertain":
            return write_record(stim, key, "reconciliation_required", attempts, None,
                                ack.get("detail", ""), sources, parked_by_ack=ack_ref["id"])
        raise Reject("poisoned_input", f"unknown ack outcome: {outcome}")

    if mode == "reconcile":
        del_ref, parked = artifact_ref(stim, DELIVERY_SCHEMA)
        if parked.get("key") != key or parked.get("status") != "reconciliation_required":
            raise Reject("validation", "reconcile requires a parked delivery record")
        # Fresh evidence only: a previously staged ack was already folded when
        # the message parked; the same read cannot settle it twice (§23).
        fresh = [(ref, ack) for ref, ack in artifact_refs(stim, ACK_SCHEMA)
                 if ack.get("key") == key and ref["id"] != parked.get("parked_by_ack")]
        if not fresh:
            raise Reject("insufficient_evidence",
                         f"no fresh provider evidence for parked delivery {key}")
        ack_ref, ack = fresh[-1]
        outcome = ack.get("outcome")
        sources = [req_ref["id"], del_ref["id"], ack_ref["id"]]
        attempts = int(parked.get("attempts", 0))
        if outcome == "ack":
            return write_record(stim, key, "acknowledged", attempts,
                                ack.get("provider_ref"), ack.get("detail", ""), sources)
        if outcome == "permanent":
            return write_record(stim, key, "dead_letter", attempts, None,
                                ack.get("detail", ""), sources)
        raise Reject("insufficient_evidence",
                     f"fresh evidence is still inconclusive for {key}; staying parked")

    raise Reject("validation", f"unknown reconcile mode: {mode}")


if __name__ == "__main__":
    sys.exit(run(fire))
