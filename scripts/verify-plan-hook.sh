#!/usr/bin/env bash
# Verify: contract-plan hook injects on strong task match, silent on trivial
set -euo pipefail
HOOK="$HOME/.claude/hooks/contract-plan.sh"

# task with strong skill match → must produce output
OUT=$(printf '{"prompt":"deploy unbrowse frontend to cloudflare pages with bun build"}' | bash "$HOOK")
if [ -z "$OUT" ]; then
    echo "FAIL: task prompt produced no output" >&2; exit 1
fi

# trivial message → must be silent
EMPTY=$(printf '{"prompt":"ok"}' | bash "$HOOK")
if [ -n "$EMPTY" ]; then
    echo "FAIL: trivial prompt produced output: $EMPTY" >&2; exit 1
fi

echo "PASS: hook injects on strong task match, silent on trivial"
