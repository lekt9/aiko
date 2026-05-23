#!/usr/bin/env bash
# check-graph-depth.sh — guard that `contract graph <id> --depth N` actually
# walks deeper than depth=1 for an organ with contract-ref children. The
# substrate claims a transitive viewer; this check binds the claim.
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
TMP=$(mktemp -d)
export CONTRACTS_STORE="$TMP/ledger.jsonl"
N="depthcheck_selftest_$$"

# Build a tiny organ: root -> child whose action is contract:<leaf> -> leaf.
LEAF=$(bash "$C" declare "$N depth leaf" --action agent-judges --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$LEAF" ] || { echo "FAIL: could not declare leaf"; rm -rf "$TMP"; exit 1; }
ROOT=$(bash "$C" declare "$N depth root" --action funnel --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ROOT" ] || { echo "FAIL: could not declare root"; rm -rf "$TMP"; exit 1; }
CHILD=$(bash "$C" declare "$N depth child (pointer)" --parent "$ROOT" --action "contract:$LEAF" 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$CHILD" ] || { echo "FAIL: could not declare ref-child"; rm -rf "$TMP"; exit 1; }

OUT1=$(bash "$C" graph "$ROOT" 2>&1)
OUT2=$(bash "$C" graph "$ROOT" --depth 2 2>&1)

# depth=1 should NOT mention the leaf's plan text; depth=2 SHOULD
if echo "$OUT1" | grep -q "depth leaf"; then
  echo "FAIL: depth=1 output already shows the transitive leaf — depth flag is a no-op"
  echo "$OUT1"
  rm -rf "$TMP"; exit 1
fi
if ! echo "$OUT2" | grep -q "depth leaf"; then
  echo "FAIL: depth=2 output does NOT show the transitive leaf via the contract-ref edge"
  echo "$OUT2"
  rm -rf "$TMP"; exit 1
fi
# depth=2 must also annotate the edge as a ref-target
if ! echo "$OUT2" | grep -q "ref-target"; then
  echo "FAIL: depth=2 output omits the 'ref-target' edge annotation"
  echo "$OUT2"
  rm -rf "$TMP"; exit 1
fi

rm -rf "$TMP"
echo "PASS: graph --depth N walks the DAG transitively via contract-ref edges."
exit 0
