#!/usr/bin/env bash
# verify.sh — proves the `sequence` shape is an ordered funnel: it surfaces
# the next unsatisfied stage in declared order, and passes only when every
# stage is satisfied.
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
N="seqgate_selftest_$$"

ORG=$(bash "$C" declare "$N sequence organ probe" --action sequence 2>/dev/null \
        | awk '/^declared:/{print $2}')
[ -n "$ORG" ] || { echo "FAIL: could not declare the sequence organ"; exit 1; }
S1=$(bash "$C" declare "$N stage one light" --parent "$ORG" --action agent-judges 2>/dev/null \
        | awk '/^declared:/{print $2}')
S2=$(bash "$C" declare "$N stage two firmament" --parent "$ORG" --action agent-judges 2>/dev/null \
        | awk '/^declared:/{print $2}')
[ -n "$S1" ] && [ -n "$S2" ] || { echo "FAIL: could not declare the stages"; exit 1; }
echo "evidence: sequence organ $ORG with ordered stages $S1, $S2"

# Before any stage is done, the sequence must point at stage 1.
OUT=$(bash "$C" iterate "$ORG" 2>/dev/null)
case "$OUT" in
  *"current stage: $S1"*) echo "evidence: sequence points at stage 1 ($S1) first  OK" ;;
  *) echo "FAIL: sequence did not name S1 as the current stage"; echo "$OUT"; exit 1 ;;
esac

# Satisfy stage 1 — the sequence must advance to stage 2.
bash "$C" _mark "$S1" satisfied >/dev/null 2>&1
OUT=$(bash "$C" iterate "$ORG" 2>/dev/null)
case "$OUT" in
  *"current stage: $S2"*) echo "evidence: after stage 1, sequence advances to stage 2 ($S2)  OK" ;;
  *) echo "FAIL: sequence did not advance to S2"; echo "$OUT"; exit 1 ;;
esac

# Satisfy stage 2 — the sequence must now PASS.
bash "$C" _mark "$S2" satisfied >/dev/null 2>&1
OUT=$(bash "$C" iterate "$ORG" 2>/dev/null)
case "$OUT" in
  *"result: PASS"*) echo "evidence: every stage satisfied -> sequence PASS  OK" ;;
  *) echo "FAIL: sequence did not PASS after all stages satisfied"; echo "$OUT"; exit 1 ;;
esac

echo "PASS: sequence is an ordered funnel — surfaces the next stage in order, passes when all satisfied."
exit 0
