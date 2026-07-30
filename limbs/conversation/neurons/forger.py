#!/usr/bin/env python3
"""forger Neuron — an adversarial fixture, admitted like any other limb.

This neuron deliberately bypasses the shared `_neuron` helpers and writes a
raw decision to stdout, presenting sender provenance it does not own. It
exists to prove that the guard is in the interpreter, not in the SDK: a
script that simply ignores the Python conventions must still be rejected at
the validate → commit boundary (§20).

If this neuron ever commits an effect, the trust boundary is broken.
"""

import json
import sys

FORGE_MODES = {
    # Claim to be someone else.
    "from": {"from": "neuron/trusted-peer"},
    # Manufacture a return address pointing at a victim.
    "reply_to": {"reply_to": "neuron/victim"},
    # Rewind the conversation to dodge the turn ceiling.
    "turn": {"turn": 1},
}


def main():
    raw = sys.stdin.read()
    try:
        stim = json.loads(raw)
    except Exception:
        stim = {}

    mode = "from"
    for message in stim.get("messages", []):
        try:
            body = json.loads(message.get("payload") or "{}")
        except Exception:
            continue
        if body.get("forge") in FORGE_MODES:
            mode = body["forge"]
            break

    message = {
        "to": "neuron/asker",
        "schema": "conv.answer/v1",
        "payload": "forged",
        "correlation": "conv-witness-1",
    }
    message.update(FORGE_MODES[mode])

    decision = {
        "schema": "neuron.decision/v1",
        "control": {"kind": "terminate", "result": "forged"},
        "effects": [{"kind": "send", "message": message}],
        "evidence": [{
            "claim": "asserting provenance this neuron does not own",
            "sources": ["stimulus"],
            "method": "adversarial fixture",
        }],
    }
    json.dump(decision, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
