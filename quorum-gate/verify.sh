#!/usr/bin/env bash
# verify.sh — proves quorum:K is the integrate-and-fire neuron: it fires at
# K satisfied children, strictly between funnel (K=N) and funnel-first (K=1).
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
N="quorumgate_selftest_$$"

ORG=$(bash "$C" declare "$N quorum organ probe" --action quorum:2 2>/dev/null \
        | awk '/^declared:/{print $2}')
[ -n "$ORG" ] || { echo "FAIL: could not declare the quorum:2 organ"; exit 1; }
C1=$(bash "$C" declare "$N quorum child 1" --parent "$ORG" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
C2=$(bash "$C" declare "$N quorum child 2" --parent "$ORG" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
C3=$(bash "$C" declare "$N quorum child 3" --parent "$ORG" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$C1" ] && [ -n "$C2" ] && [ -n "$C3" ] || { echo "FAIL: could not declare 3 children"; exit 1; }
echo "evidence: quorum:2 organ $ORG with 3 children"

O=$(bash "$C" iterate "$ORG" 2>/dev/null)
case "$O" in
  *"result: FAIL — 0/3 satisfied (threshold 2)"*) echo "evidence: 0/3 -> FAIL  OK" ;;
  *) echo "FAIL: quorum 0/3 wrong"; echo "$O"; exit 1 ;;
esac

bash "$C" _mark "$C1" satisfied --proof-skip "shape-gate self-test" >/dev/null 2>&1
O=$(bash "$C" iterate "$ORG" 2>/dev/null)
case "$O" in
  *"result: FAIL — 1/3 satisfied (threshold 2)"*) echo "evidence: 1/3 -> FAIL (below threshold)  OK" ;;
  *) echo "FAIL: quorum 1/3 wrong"; echo "$O"; exit 1 ;;
esac

bash "$C" _mark "$C2" satisfied --proof-skip "shape-gate self-test" >/dev/null 2>&1
O=$(bash "$C" iterate "$ORG" 2>/dev/null)
case "$O" in
  *"result: PASS — 2/3 satisfied (threshold 2)"*) echo "evidence: 2/3 -> PASS — fires before all children  OK" ;;
  *) echo "FAIL: quorum 2/3 wrong"; echo "$O"; exit 1 ;;
esac

echo "PASS: quorum:K is the integrate-and-fire neuron — fires at K, between funnel and funnel-first."
exit 0
