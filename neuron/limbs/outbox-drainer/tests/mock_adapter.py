#!/usr/bin/env python3
"""Mock channel adapter for outbox-drainer conformance.

Mirrors the real adapter contract (telegram-contracts adapter/send.sh):
  - owns its credential (env MOCK_ADAPTER_TOKEN); exits 4 when it is absent
    and NEVER prints it — the secret must not appear in any stimulus,
    decision, artifact, or log (§24)
  - reads the declared envelope on stdin: {idempotency_key, to, schema, payload}
  - exit 0 = acknowledged (provider_ref on stdout), 1 = permanent failure,
    2 = retryable failure, 75 = uncertain (maybe delivered, maybe not)
  - --verify KEY prints a FRESH provider observation for the reconciler

Delivery outcomes are driven by markers in the message payload text so each
conformance case is self-contained: "MOCK:ack" (default), "MOCK:retryable",
"MOCK:permanent", "MOCK:uncertain".
"""

import json
import os
import sys


def marker_of(envelope):
    try:
        payload = json.loads(envelope.get("payload", "{}"))
    except json.JSONDecodeError:
        payload = {}
    text = payload.get("text", "") if isinstance(payload, dict) else ""
    for marker in ("MOCK:retryable", "MOCK:permanent", "MOCK:uncertain", "MOCK:ack"):
        if marker in text:
            return marker
    return "MOCK:ack"


def main():
    token = os.environ.get("MOCK_ADAPTER_TOKEN")
    if not token:
        print("no credential in environment", file=sys.stderr)
        return 4

    argv = sys.argv[1:]
    if argv and argv[0] == "--verify":
        key = argv[1]
        outcome = os.environ.get("MOCK_VERIFY_OUTCOME", "ack")
        print(json.dumps({
            "key": key,
            "outcome": outcome,
            "provider_ref": f"mock/verify/{key[:12]}" if outcome == "ack" else None,
            "detail": f"fresh provider observation: {outcome}",
        }))
        return 0

    envelope = json.loads(sys.stdin.read())
    log_path = os.environ.get("MOCK_ADAPTER_LOG")
    if log_path:
        with open(log_path, "a") as fh:
            fh.write(json.dumps(envelope, sort_keys=True) + "\n")
    marker = marker_of(envelope)
    key = envelope["idempotency_key"]
    if marker == "MOCK:retryable":
        print("provider 503: try again later", file=sys.stderr)
        return 2
    if marker == "MOCK:permanent":
        print("provider 403: forbidden", file=sys.stderr)
        return 1
    if marker == "MOCK:uncertain":
        print("connection reset after write", file=sys.stderr)
        return 75
    print(json.dumps({"provider_ref": f"mock/msg/{key[:12]}", "detail": "delivered"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
