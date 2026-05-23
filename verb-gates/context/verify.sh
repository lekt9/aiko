#!/usr/bin/env bash
# verb-gates/context/verify.sh — binds the `contract context <id>` verb.
#
# Phases:
#   1. Unknown id → exit 2.
#   2. Known leaf → JSON envelope with id, plan, status, action, cwd,
#      parent_chain, origin_chain, last_iterations fields.
#   3. Child of a parent → parent_chain non-empty and ordered from
#      immediate parent upward.
#   4. After ≥3 iterates → last_iterations contains those rows in order
#      with action_exit / wave / ts.
#   5. --max-iterations N → last_iterations capped at N.
set -e

TMPDIR_=$(mktemp -d)
trap 'rm -rf "$TMPDIR_"' EXIT
export CONTRACTS_STORE="$TMPDIR_/contracts.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

# Phase 1: unknown id refused
if "$CLI" context cafebabe 2>/dev/null; then
  echo "FAIL(1): unknown id should have exited non-zero"; exit 1
fi
echo "PASS(1): unknown id refused"

# Phase 2: known leaf — basic envelope
PARENT_OUT=$("$CLI" declare "context probe parent" --action funnel --no-drive 2>&1)
PARENT=$(printf '%s' "$PARENT_OUT" | grep -oE '^declared: [0-9a-f]+' | head -1 | awk '{print $2}')
[ -n "$PARENT" ] || { echo "FAIL(2): could not declare parent"; exit 1; }

CHILD_OUT=$("$CLI" declare "context probe child" --action "true" --parent "$PARENT" --no-drive 2>&1)
CHILD=$(printf '%s' "$CHILD_OUT" | grep -oE '^declared: [0-9a-f]+' | head -1 | awk '{print $2}')
[ -n "$CHILD" ] || { echo "FAIL(2): could not declare child"; exit 1; }

ENV=$("$CLI" context "$CHILD" 2>&1)
echo "$ENV" | python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
for k in ("id","plan","status","action","cwd","parent_chain","origin_chain","last_iterations"):
    assert k in d, f"missing field: {k}"
assert d["id"].startswith("'"${CHILD:0:6}"'") or d["id"]=="'"$CHILD"'"
' || { echo "FAIL(2): envelope missing required fields"; echo "$ENV"; exit 1; }
echo "PASS(2): known leaf envelope has all required fields"

# Phase 3: parent_chain contains immediate parent
echo "$ENV" | python3 -c '
import json,sys,os
d=json.loads(sys.stdin.read())
chain=d["parent_chain"]
assert len(chain)>=1, f"expected non-empty parent_chain, got {chain}"
assert chain[0]["id"]=="'"$PARENT"'", f"parent_chain[0] != PARENT: {chain[0]}"
' || { echo "FAIL(3): parent_chain missing parent"; exit 1; }
echo "PASS(3): parent_chain ordered immediate-parent-first"

# Phase 4: after ≥3 iterates, last_iterations populated
"$CLI" iterate "$CHILD" >/dev/null 2>&1 || true
"$CLI" iterate "$CHILD" >/dev/null 2>&1 || true
"$CLI" iterate "$CHILD" >/dev/null 2>&1 || true
ENV2=$("$CLI" context "$CHILD" 2>&1)
N=$(echo "$ENV2" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(len(d["last_iterations"]))')
[ "$N" -ge 3 ] || { echo "FAIL(4): expected ≥3 last_iterations, got $N"; exit 1; }
echo "$ENV2" | python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
for r in d["last_iterations"]:
    for k in ("wave","action_exit","ts"):
        assert k in r and r[k] is not None, f"missing {k} in iteration row: {r}"
' || { echo "FAIL(4): last_iterations row missing fields"; exit 1; }
echo "PASS(4): last_iterations populated with wave/action_exit/ts"

# Phase 5: --max-iterations cap
ENV3=$("$CLI" context "$CHILD" --max-iterations 2 2>&1)
N3=$(echo "$ENV3" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(len(d["last_iterations"]))')
[ "$N3" -le 2 ] || { echo "FAIL(5): --max-iterations 2 did not cap; got $N3"; exit 1; }
echo "PASS(5): --max-iterations N respected"

echo
echo "verb-gates/context: PASS"
exit 0
