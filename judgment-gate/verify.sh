#!/usr/bin/env bash
# verify.sh — proves the judgment shape: action 'agent-judges' produces a
# non-mechanical iterate result; satisfaction requires explicit _mark.
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
N="judgmentgate_selftest_$$"

ID=$(bash "$C" declare "$N judgment probe" --action agent-judges --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ID" ] || { echo "FAIL: could not declare judgment"; exit 1; }

O=$(bash "$C" iterate "$ID" 2>/dev/null)
# Judgment doesn't produce PASS/FAIL; it surfaces AGENT-JUDGES and the two-key prompt
echo "$O" | grep -qE "AGENT-JUDGES|agent-judges|KEY 2" || {
  echo "FAIL: judgment iterate did not surface agent-key prompt"; echo "$O"; exit 1
}
echo "evidence: judgment iterate  ->  KEY 2 prompt surfaced  OK"

# Pre-mark: status should still be pending/active (NOT auto-satisfied)
STATUS_BEFORE=$(bash "$C" status "$ID" 2>/dev/null | head -1)
echo "$STATUS_BEFORE" | grep -qE "\[pending\]|\[active\]" || {
  echo "FAIL: judgment auto-satisfied without _mark"; echo "$STATUS_BEFORE"; exit 1
}
echo "evidence: pre-_mark status  ->  not satisfied (no auto-resolve)  OK"

# Now mark
bash "$C" _mark "$ID" satisfied >/dev/null 2>&1
STATUS_AFTER=$(bash "$C" status "$ID" 2>/dev/null | head -1)
echo "$STATUS_AFTER" | grep -q "\[satisfied\]" || {
  echo "FAIL: judgment _mark did not satisfy"; echo "$STATUS_AFTER"; exit 1
}
echo "evidence: _mark satisfied  ->  status [satisfied]  OK"

echo "PASS: judgment — agent-judges yields KEY 2 prompt, never auto-resolves."
exit 0
