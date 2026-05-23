#!/usr/bin/env bash
# verify.sh — proves the loop shape: action 'loop-until:<body>' re-runs the
# body each iterate; converges when body exits 0. The body IS the invariant.
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
N="loopgate_selftest_$$"

# A loop whose body counts iterations and exits 0 only on the 3rd run.
COUNTER=$(mktemp)
echo 0 > "$COUNTER"
BODY="bash -c 'n=\$(cat $COUNTER); n=\$((n+1)); echo \$n > $COUNTER; test \$n -ge 3'"

ID=$(bash "$C" declare "$N loop probe" --action "loop-until:$BODY" --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ID" ] || { echo "FAIL: could not declare loop"; rm -f "$COUNTER"; exit 1; }

# wave 1: body returns 1 (n=1) -> FAIL
O=$(bash "$C" iterate "$ID" 2>/dev/null)
echo "$O" | grep -qE "LOOP-RUNNING|result: FAIL" || { echo "FAIL: loop wave 1 did not surface FAIL/LOOP-RUNNING"; echo "$O"; rm -f "$COUNTER"; exit 1; }
N1=$(cat "$COUNTER")
[ "$N1" = "1" ] || { echo "FAIL: body did not run on wave 1 (counter=$N1)"; rm -f "$COUNTER"; exit 1; }
echo "evidence: loop wave 1  ->  body ran (n=1), FAIL  OK"

# wave 2: n=2 -> FAIL
O=$(bash "$C" iterate "$ID" 2>/dev/null)
echo "$O" | grep -q "result: FAIL" || { echo "FAIL: loop wave 2 did not FAIL"; rm -f "$COUNTER"; exit 1; }
N2=$(cat "$COUNTER")
[ "$N2" = "2" ] || { echo "FAIL: body did not re-run on wave 2 (counter=$N2)"; rm -f "$COUNTER"; exit 1; }
echo "evidence: loop wave 2  ->  body re-ran (n=2), FAIL  OK"

# wave 3: n=3 -> PASS
O=$(bash "$C" iterate "$ID" 2>/dev/null)
echo "$O" | grep -q "result: PASS" || { echo "FAIL: loop wave 3 did not PASS"; echo "$O"; rm -f "$COUNTER"; exit 1; }
N3=$(cat "$COUNTER")
[ "$N3" = "3" ] || { echo "FAIL: body did not run on wave 3 (counter=$N3)"; rm -f "$COUNTER"; exit 1; }
echo "evidence: loop wave 3  ->  body re-ran (n=3), PASS  OK"

rm -f "$COUNTER"
echo "PASS: loop-until — body re-runs each iterate; converges when body exits 0."
exit 0
