#!/usr/bin/env python3
"""responder Neuron — answers any peer that asks, with no address book.

The point of this neuron is what it does NOT have: no send capability, no
configured peer list, no knowledge of who might call it. Its manifest requests
`allow_send: false`. It can still answer, because the request it received
carries its own attested return address (`reply_to`) and conversation identity
(`correlation`), both stamped by the interpreter at the asker's commit
boundary. Reply authority is conferred by possession of the request.

Pure policy (§2): it returns a declarative `send` effect. The harness commit
boundary is the only linearization point (§20).
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, decision, inbound, reply, run

ASK_SCHEMA = "conv.ask/v1"
ANSWER_SCHEMA = "conv.answer/v1"


def answer_for(question):
    """The trivial 'work' this responder performs; the exchange is the point."""
    return json.dumps({"question": question, "answer": len(question)}, sort_keys=True, separators=(",", ":"))


def fire(stim):
    asks = inbound(stim, schema=ASK_SCHEMA)
    if not asks:
        raise Reject("dependency", f"no inbound {ASK_SCHEMA} to answer")
    request = asks[0]

    try:
        body = json.loads(request.get("payload") or "{}")
    except Exception as exc:
        raise Reject("poisoned_input", f"request payload is not JSON: {exc}")
    question = body.get("question")
    if not isinstance(question, str) or not question:
        raise Reject("validation", "request carries no question")

    # `reply` reads the return path off the message itself. Handing it a
    # message that invited no answer is a typed rejection, not a silent
    # one-way send.
    effects = [reply(request, ANSWER_SCHEMA, answer_for(question))]

    evidence = [{
        "claim": f"answered {request.get('from')} on conversation {request.get('correlation')}",
        "sources": ["stimulus"],
        "method": "reply on the request's attested return path",
        "confidence_milli": 1000,
    }]
    return decision({"kind": "terminate", "result": "answered"}, effects, evidence, stim)


if __name__ == "__main__":
    sys.exit(run(fire))
