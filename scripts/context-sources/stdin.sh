#!/usr/bin/env bash
# stdin source: accept envelope or body from stdin. Non-binding fallback —
# the chat / person / agent supplies context directly. Exit 0 + envelope
# JSON on stdout when stdin is non-empty; exit 1 silently when stdin is
# empty (no paste was provided).
set -e

TOPIC="${1:-${CONTEXT_TOPIC:-}}"
SLUG="${CONTEXT_SLUG:-topic}"

PAYLOAD=$(cat 2>/dev/null || true)
if [ -z "$PAYLOAD" ]; then
  exit 1
fi

CTX_TOPIC="$TOPIC" CTX_SLUG="$SLUG" CTX_PAYLOAD="$PAYLOAD" python3 <<'PY'
import json, os
topic   = os.environ.get("CTX_TOPIC", "")
slug    = os.environ.get("CTX_SLUG", "topic")
payload = os.environ.get("CTX_PAYLOAD", "")
try:
    env = json.loads(payload)
    if not isinstance(env, dict):
        raise ValueError("not a JSON object")
except (json.JSONDecodeError, ValueError):
    env = {"body": payload, "refs": []}
env.setdefault("topic", topic)
env.setdefault("slug", slug)
env["source"] = "stdin"
print(json.dumps(env))
PY
