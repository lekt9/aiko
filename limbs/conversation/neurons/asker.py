#!/usr/bin/env python3
"""asker Neuron — opens a conversation and settles on the answer.

One stateless neuron covering both halves of an exchange, distinguished only
by what arrives in its stimulus:

  - no answer present  -> emit a correlated request and `continue`, parking on
    `reply/<correlation>`; the pump holds unrelated traffic while parked, so
    another conversation cannot consume the park;
  - the answer present -> `terminate`, writing what was heard as an artifact.

The neuron stays pure and stateless (§2). The conversation's state lives in
the durable message envelope and the park predicate, not in this process.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, await_reply, canonical, decision, inbound, request, run

ASK_SCHEMA = "conv.ask/v1"
ANSWER_SCHEMA = "conv.answer/v1"
SETTLED_SCHEMA = "conv.settled/v1"
START_SCHEMA = "conv.start/v1"


def conversation_of(stim):
    """The exchange this firing belongs to: named by the operator's start
    message, or carried forward by the answer being delivered."""
    for msg in stim.get("messages", []):
        if msg.get("correlation"):
            return msg["correlation"]
    for msg in inbound(stim, schema=START_SCHEMA):
        try:
            body = json.loads(msg.get("payload") or "{}")
        except Exception as exc:
            raise Reject("poisoned_input", f"start payload is not JSON: {exc}")
        if body.get("correlation"):
            return body["correlation"]
    raise Reject("validation", "no conversation to open or continue")


def fire(stim):
    correlation = conversation_of(stim)

    answers = inbound(stim, schema=ANSWER_SCHEMA, correlation=correlation)
    if answers:
        heard = answers[0]
        settled = canonical({
            "schema": SETTLED_SCHEMA,
            "correlation": correlation,
            "answered_by": heard.get("from"),
            "turn": heard.get("turn", 0),
            "answer": heard.get("payload"),
        }).decode()
        effects = [{
            "kind": "write",
            "artifact": {
                "id": f"artifact/conversation/{correlation}/settled",
                "schema": SETTLED_SCHEMA,
                "bytes": settled,
            },
        }]
        evidence = [{
            "claim": f"settled conversation {correlation} on the answer from {heard.get('from')}",
            "sources": ["stimulus"],
            "method": "await-reply resume",
            "confidence_milli": 1000,
        }]
        return decision({"kind": "terminate", "result": "heard"}, effects, evidence, stim)

    peer = None
    for msg in inbound(stim, schema=START_SCHEMA):
        try:
            peer = json.loads(msg.get("payload") or "{}").get("peer")
        except Exception:
            peer = None
        if peer:
            break
    if not peer:
        raise Reject("validation", "start message names no peer to ask")

    question = json.dumps({"question": "how long is this?"}, sort_keys=True, separators=(",", ":"))
    effects = [request(peer, ASK_SCHEMA, question, correlation)]
    evidence = [{
        "claim": f"asked {peer} and parked on conversation {correlation}",
        "sources": ["stimulus"],
        "method": "correlated request",
        "confidence_milli": 1000,
    }]
    return decision(await_reply(correlation), effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
