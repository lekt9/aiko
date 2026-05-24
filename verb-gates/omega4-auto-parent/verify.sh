#!/bin/bash
# Ω4 auto-iterate-parent hook gate:
#   1) declare R (funnel) + L (cell, action=true) with --parent
#   2) iterate L, _mark satisfied
#   3) the mark hook fires auto-iterate-parent.sh which calls
#      `contract iterate R` programmatically — assert R got iterated
set -e
TMP="$(mktemp -d)"
export CONTRACTS_STORE="$TMP/store.jsonl"
C=~/.claude/skills/contract/scripts/contract
ROOT=$($C declare "auto-parent gate root" --action funnel --no-drive 2>/dev/null | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
LEAF=$($C declare "auto-parent leaf" --action "true" --parent "$ROOT" 2>/dev/null | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
$C iterate "$LEAF" >/dev/null 2>&1
# capture pre-mark wave count on parent
WAVES_BEFORE=$(grep -c "\"id\":\"$ROOT\".*\"event\":\"iterated\"" "$CONTRACTS_STORE" 2>/dev/null || echo 0)
$C _mark "$LEAF" satisfied --proof "ω4 hook gate" >/dev/null 2>&1
# the hook fires async — wait briefly then check
sleep 2
WAVES_AFTER=$(grep -c "\"id\":\"$ROOT\".*\"event\":\"iterated\"" "$CONTRACTS_STORE" 2>/dev/null || echo 0)
if [ "$WAVES_AFTER" -le "$WAVES_BEFORE" ]; then
  echo "FAIL: parent $ROOT was not auto-iterated by Ω4 hook (waves before=$WAVES_BEFORE after=$WAVES_AFTER)"
  echo "store: $CONTRACTS_STORE"
  exit 1
fi
echo "PASS: Ω4 auto-iterated parent $ROOT (waves $WAVES_BEFORE → $WAVES_AFTER)"
