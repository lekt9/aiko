#!/usr/bin/env bash
# verify.sh — proves the tool-guard capability end to end against the REAL
# contract ledger and the REAL PreToolUse hook script. Declares a guard on a
# test-only tool pattern (matches no real tool), drives the hook three ways,
# then lifts the guard. The agent renders KEY 2.
set -uo pipefail

CONTRACT="$HOME/.claude/skills/contract/scripts/contract"
HOOK="$HOME/.contracts/hooks/contract-tool-guard.py"
export CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl"

[ -x "$HOOK" ] || { echo "FAIL: hook missing/not executable: $HOOK"; exit 1; }
echo "evidence: hook present and executable"

TESTTOOL="__contract_toolguard_selftest__probe"

# 1. declare a tool-guard on a test-only pattern (guards no real tool).
GID=$(bash "$CONTRACT" declare "self-test guard for the tool-guard verify harness" \
        --action "tool-guard:__contract_toolguard_selftest__*" 2>/dev/null \
        | awk '/^declared:/{print $2}')
[ -n "$GID" ] || { echo "FAIL: could not declare the test guard"; exit 1; }
echo "evidence: declared test guard $GID"

# 2. the hook must BLOCK a matching tool (exit 2) and cite the contract.
OUT=$(printf '{"tool_name":"%s","cwd":"/tmp"}' "$TESTTOOL" | "$HOOK" 2>&1); RC=$?
if [ "$RC" != "2" ]; then
  echo "FAIL: hook did not block a guarded tool (exit $RC, expected 2)"
  bash "$CONTRACT" _mark "$GID" satisfied --proof-skip "shape-gate self-test" >/dev/null 2> satisfied >/dev/null 2>&11
  exit 1
fi
case "$OUT" in
  *"$GID"*) echo "evidence: guarded tool blocked (exit 2), reason cites $GID  OK" ;;
  *) echo "FAIL: block message did not cite contract $GID"
     bash "$CONTRACT" _mark "$GID" satisfied --proof-skip "shape-gate self-test" >/dev/null 2> satisfied >/dev/null 2>&11; exit 1 ;;
esac

# 3. the hook must ALLOW a non-matching tool (exit 0).
printf '{"tool_name":"SomeUnrelatedTool","cwd":"/tmp"}' | "$HOOK" >/dev/null 2>&1; RC=$?
if [ "$RC" != "0" ]; then
  echo "FAIL: hook blocked an unguarded tool (exit $RC)"
  bash "$CONTRACT" _mark "$GID" satisfied --proof-skip "shape-gate self-test" >/dev/null 2> satisfied >/dev/null 2>&11
  exit 1
fi
echo "evidence: unguarded tool allowed (exit 0)  OK"

# 4. marking the guard satisfied LIFTS it — the matching tool is allowed again.
bash "$CONTRACT" _mark "$GID" satisfied --proof-skip "shape-gate self-test" >/dev/null 2> satisfied >/dev/null 2>&11
printf '{"tool_name":"%s","cwd":"/tmp"}' "$TESTTOOL" | "$HOOK" >/dev/null 2>&1; RC=$?
if [ "$RC" != "0" ]; then
  echo "FAIL: guard still active after _mark satisfied (exit $RC)"
  exit 1
fi
echo "evidence: guard lifted after _mark satisfied, tool allowed  OK"

echo "PASS: tool-guard blocks guarded tools, allows others, lifts on satisfy."
exit 0
