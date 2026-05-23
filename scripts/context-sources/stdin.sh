#!/usr/bin/env bash
# stdin source: accept envelope or body from stdin. Non-binding fallback —
# the chat / person / agent supplies context directly.
#
# Inputs:
#   $1                — topic (informational)
#   CONTEXT_TOPIC env — same as $1
#   CONTEXT_SLUG env  — slug derived by orchestrator
#   stdin             — either a JSON envelope {body,refs,...} OR raw text body
#
# Exits 0 + envelope JSON on stdout when stdin is non-empty.
# Exits 1 silently when stdin is empty (no paste was provided).
set -e

TOPIC="${1:-${CONTEXT_TOPIC:-}}"
SLUG="${CONTEXT_SLUG:-topic}"

PAYLOAD=$(cat 2>/dev/null || true)
if [ -z "$PAYLOAD" ]; then
  exit 1
fi

# Try to parse as JSON envelope; if that fails, wrap as {body: ...}
python3 - "$TOPIC" "$SLUG" <<'PY' <<<"$PAYLOAD" 2>/dev/null || python3 - "$TOPIC" "$SLUG" "$PAYLOAD" <<'PY2'
import json, sys
topic, slug = sys.argv[1], sys.argv[2]
raw = sys.stdin.read()
try:
    env = json.loads(raw)
    if not isinstance(env, dict):
        raise ValueError("not a JSON object")
except (json.JSONDecodeError, ValueError):
    env = {"body": raw, "refs": []}
env.setdefault("topic", topic)
env.setdefault("slug", slug)
env["source"] = "stdin"
print(json.dumps(env))
PY
PY2
exit 0
