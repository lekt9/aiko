#!/bin/bash
# Σ9 thread-chain hook gate:
#   1) declare A in thread T (CLAUDE_CODE_SESSION_ID set)
#   2) declare B in thread T
#   3) the declare hook auto-corroborates A↔B as Hebbian synapse —
#      assert the corroboration row exists
set -e
TMP="$(mktemp -d)"
export CONTRACTS_STORE="$TMP/store.jsonl"
export CLAUDE_CODE_SESSION_ID="sigma9-gate-$$"
C=~/.claude/skills/contract/scripts/contract
A=$($C declare "sigma9 first" --action "true" --no-drive 2>/dev/null | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
B=$($C declare "sigma9 second" --action "true" --no-drive 2>/dev/null | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
# corroborate is async — wait briefly
sleep 2
# verify a corroborated row links A and B
LINKED=$(grep "corroborated" "$CONTRACTS_STORE" 2>/dev/null | grep "$A" | grep "$B" | wc -l | tr -d ' ')
if [ "$LINKED" -lt 1 ]; then
  echo "FAIL: no corroborated row links $A ↔ $B in same thread"
  echo "store: $CONTRACTS_STORE"
  cat "$CONTRACTS_STORE"
  exit 1
fi
# verify thread-chain log was written
LOG="$HOME/.contracts/inbox/sigma9-chain/$(date -u +%Y-%m-%d).jsonl"
[ -f "$LOG" ] && grep -q "$A" "$LOG" && grep -q "$B" "$LOG" || {
  echo "WARN: thread-chain log $LOG missing or stale (corroborate fired anyway)"
}
echo "PASS: Σ9 auto-corroborated $A ↔ $B in same thread"
