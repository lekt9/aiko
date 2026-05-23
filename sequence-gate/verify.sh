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
bash "$C" _mark "$S1" satisfied --proof-skip "shape-gate self-test" >/dev/null 2>&1
OUT=$(bash "$C" iterate "$ORG" 2>/dev/null)
case "$OUT" in
  *"current stage: $S2"*) echo "evidence: after stage 1, sequence advances to stage 2 ($S2)  OK" ;;
  *) echo "FAIL: sequence did not advance to S2"; echo "$OUT"; exit 1 ;;
esac

# Satisfy stage 2 — the sequence must now PASS.
bash "$C" _mark "$S2" satisfied --proof-skip "shape-gate self-test" >/dev/null 2>&1
OUT=$(bash "$C" iterate "$ORG" 2>/dev/null)
case "$OUT" in
  *"result: PASS"*) echo "evidence: every stage satisfied -> sequence PASS  OK" ;;
  *) echo "FAIL: sequence did not PASS after all stages satisfied"; echo "$OUT"; exit 1 ;;
esac

# --- Regression: supersession mid-sequence must not pin the walker on the fossil ---
# Contract 565691ba: a merged child is a fossil whose truth was carried by its
# winner; sequence must treat {satisfied, merged} as equally-resolved. Without
# this, supersession mid-organ silently deadlocks the next stage.
ORG2=$(bash "$C" declare "$N supersession-mid-seq regression organ" --action sequence 2>/dev/null \
        | awk '/^declared:/{print $2}')
A1=$(bash "$C" declare "$N stage A (will be superseded)" --parent "$ORG2" --action 'true' 2>/dev/null \
        | awk '/^declared:/{print $2}')
A2=$(bash "$C" declare "$N stage A-prime (winner)" --parent "$ORG2" --action 'true' 2>/dev/null \
        | awk '/^declared:/{print $2}')
B1=$(bash "$C" declare "$N stage B (must come next after A is fossilised)" --parent "$ORG2" --action 'true' 2>/dev/null \
        | awk '/^declared:/{print $2}')
[ -n "$ORG2" ] && [ -n "$A1" ] && [ -n "$A2" ] && [ -n "$B1" ] || { echo "FAIL: could not declare regression fixture"; exit 1; }

# Supersede A1 with A2 — A1 becomes a fossil (status=merged).
bash "$C" supersede "$A1" "$A2" --reason "regression evidence" >/dev/null 2>&1

# Sequence iterate must skip the merged A1 and name the first NON-resolved stage
# (A2, since it's the next declared child and not yet satisfied).
OUT=$(bash "$C" iterate "$ORG2" 2>/dev/null)
case "$OUT" in
  *"current stage: $A1"*)
    echo "FAIL: walker pinned on merged fossil $A1 — contract 565691ba regression"; echo "$OUT"; exit 1 ;;
  *"current stage: $A2"*|*"current stage: $B1"*)
    echo "evidence: walker advanced past merged fossil to first unresolved stage  OK" ;;
  *) echo "FAIL: unexpected iterate output after supersession"; echo "$OUT"; exit 1 ;;
esac

# Satisfy A2, then B1 — every stage is now in {satisfied, merged}; sequence must PASS.
bash "$C" _mark "$A2" satisfied --proof-skip "shape-gate self-test" >/dev/null 2>&1
bash "$C" _mark "$B1" satisfied --proof-skip "shape-gate self-test" >/dev/null 2>&1
OUT=$(bash "$C" iterate "$ORG2" 2>/dev/null)
case "$OUT" in
  *"result: PASS"*) echo "evidence: organ with one merged + two satisfied children PASSes  OK" ;;
  *) echo "FAIL: sequence did not PASS with all-resolved (merged-or-satisfied) children"; echo "$OUT"; exit 1 ;;
esac

echo "PASS: sequence is an ordered funnel — surfaces the next stage in order, passes when all satisfied (merged children count as resolved, per 565691ba)."
exit 0
