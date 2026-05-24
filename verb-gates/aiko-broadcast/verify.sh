#!/bin/bash
# aiko broadcast-update gate: with ≥1 active Σ6 session, writes to agent inbox
set -e
CID="gate-bc-$$"
~/.claude/skills/aiko/scripts/aiko perpetual --transport terminal --client-id "$CID" --no-drive >/dev/null 2>&1
sleep 1
TAG="gate-broadcast-test-$$"
OUT=$(~/.claude/skills/aiko/scripts/aiko broadcast-update "$TAG" --kind text 2>&1)
echo "$OUT" | grep -q "sessions:.*active" || { echo "FAIL: no sessions line"; exit 1; }
SESS=$(echo "$OUT" | grep -Eo "sessions:  [0-9]+" | grep -Eo "[0-9]+")
[ "$SESS" -lt 1 ] && { echo "FAIL: 0 active sessions despite fresh register"; exit 1; }
# verify row in agent inbox
grep -q "$TAG" ~/.contracts/inbox/agent/*.jsonl 2>/dev/null || { echo "FAIL: broadcast row not in agent inbox"; exit 1; }
echo "PASS: aiko broadcast wrote update row to agent inbox; $SESS active sessions"
