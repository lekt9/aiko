#!/bin/bash
# Φ4-binding gate: aiko declare produces a contract row that fires the SAME
# hooks as `contract declare` — Σ9 thread-chain on declare, Ω4 auto-parent on
# mark, plan-fulfillment proof binding, the nine shapes. Asserts the
# shape inheritance is mechanical, not aspirational.
set -e
TMP="$(mktemp -d)"
export CONTRACTS_STORE="$TMP/store.jsonl"
export CLAUDE_CODE_SESSION_ID="aiko-shape-gate-$$"
AIKO=~/.claude/skills/aiko/scripts/aiko
CLI=~/.claude/skills/contract/scripts/contract

# 1) aiko declare writes a contract row that is discoverable by `contract get`
OUT_A=$($AIKO declare "aiko-shape A" --no-drive 2>&1)
ID_A=$(echo "$OUT_A" | grep -Eo 'aiko_[a-f0-9]{8}' | head -1)
[ -n "$ID_A" ] || { echo "FAIL: aiko declare didn't return aiko_ id"; echo "$OUT_A"; exit 1; }

# verify it's in the ledger as a declared row
grep -q "\"id\": \"$ID_A\"" "$CONTRACTS_STORE" || {
  echo "FAIL: aiko declare didn't append a declared row for $ID_A"
  cat "$CONTRACTS_STORE"
  exit 1
}

# 2) Σ9 fires for aiko: a SECOND aiko declare in the same thread corroborates with the first
OUT_B=$($AIKO declare "aiko-shape B" --no-drive 2>&1)
ID_B=$(echo "$OUT_B" | grep -Eo 'aiko_[a-f0-9]{8}' | head -1)
sleep 2
LINKED=$(grep "corroborated" "$CONTRACTS_STORE" 2>/dev/null | grep "$ID_A" | grep "$ID_B" | wc -l | tr -d ' ')
if [ "$LINKED" -lt 1 ]; then
  echo "FAIL: Σ9 thread-chain didn't auto-corroborate aiko $ID_A ↔ $ID_B"
  exit 1
fi

# 3) Ω4 fires for aiko: spawn a child, mark child, parent gets iterated
OUT_CHILD=$($AIKO spawn "$ID_A" "aiko-shape child" --action "true" 2>&1)
ID_C=$(echo "$OUT_CHILD" | grep -Eo 'aiko_[a-f0-9]{8}' | head -1)
[ -n "$ID_C" ] || { echo "FAIL: aiko spawn didn't return child id"; echo "$OUT_CHILD"; exit 1; }
$CLI iterate "$ID_C" >/dev/null 2>&1
count_parent_iterates() {
  grep "\"id\": \"$ID_A\"" "$CONTRACTS_STORE" 2>/dev/null | grep -c "\"event\": \"iterated\"" || true
}
WAVES_BEFORE=$(count_parent_iterates); WAVES_BEFORE="${WAVES_BEFORE:-0}"
$CLI _mark "$ID_C" satisfied --proof "aiko same-shape gate child" >/dev/null 2>&1
sleep 2
WAVES_AFTER=$(count_parent_iterates); WAVES_AFTER="${WAVES_AFTER:-0}"
if [ "$WAVES_AFTER" -le "$WAVES_BEFORE" ]; then
  echo "FAIL: Ω4 didn't auto-iterate aiko parent $ID_A after child $ID_C marked (waves $WAVES_BEFORE → $WAVES_AFTER)"
  exit 1
fi

# 4) plan-fulfillment proof binding: bare _mark on an aiko row is refused (exit 2)
OUT_BARE=$($CLI _mark "$ID_B" satisfied 2>&1) && RC=0 || RC=$?
if [ "$RC" != "2" ]; then
  echo "FAIL: aiko cell $ID_B accepted bare _mark (RC=$RC); proof-binding doesn't fire on aiko rows"
  echo "$OUT_BARE"
  exit 1
fi

# 5) dashboard surfaces the aiko cells
DASH_OUT=$(~/.claude/skills/aiko/scripts/aiko dashboard --once 2>&1)
echo "$DASH_OUT" | grep -q "$ID_A" || { echo "FAIL: dashboard didn't surface aiko $ID_A"; exit 1; }

echo "PASS: aiko inherits /contract shape — Σ9 corroborated, Ω4 fired, proof-binding refused bare mark, dashboard rendered $ID_A"
