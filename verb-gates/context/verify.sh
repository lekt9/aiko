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

# Phase 6 (R8 gap 91d78419): channel-scoped ledger walking.
# `contract context <channel-id> [--limit N]` resolves
# ~/.contracts/channels/<channel-id>/contracts.jsonl, returns last N rows
# in chronological order as JSON. Empty / missing channel returns
# count == 0 without error (genuine empty case per Γ1, not a stub).
CHAN="test-r8-channel-$$"
CHANDIR="$HOME/.contracts/channels/$CHAN"
cleanup_chan() { rm -rf "$CHANDIR"; }
trap 'rm -rf "$TMPDIR_"; cleanup_chan' EXIT

# Missing channel → empty-events shape, count == 0, no error
MISSING=$("$CLI" context "$CHAN" --limit 5 2>&1) || { echo "FAIL(6a): missing channel should not error"; echo "$MISSING"; exit 1; }
echo "$MISSING" | python3 -c '
import json, sys, os
d = json.loads(sys.stdin.read())
assert d["channel"] == "'"$CHAN"'", f"channel mismatch: {d}"
assert d["count"] == 0, f"expected count=0 for missing channel, got {d[\"count\"]}"
assert d["events"] == [], f"expected empty events for missing channel, got {d[\"events\"]}"
' || { echo "FAIL(6a): missing-channel envelope wrong shape"; echo "$MISSING"; exit 1; }
echo "PASS(6a): missing channel returns count=0 empty-events shape"

# Seed 3 fake rows then assert --limit 2 returns the LAST 2 in chronological order
mkdir -p "$CHANDIR"
LEDGER="$CHANDIR/contracts.jsonl"
printf '%s\n' '{"event":"inbound","seq":1,"ts":"2026-05-25T00:00:01Z","msg":"first"}' >> "$LEDGER"
printf '%s\n' '{"event":"poll_delta","seq":2,"ts":"2026-05-25T00:00:02Z","msg":"second"}' >> "$LEDGER"
printf '%s\n' '{"event":"claim","seq":3,"ts":"2026-05-25T00:00:03Z","msg":"third"}' >> "$LEDGER"
OUT=$("$CLI" context "$CHAN" --limit 2 2>&1) || { echo "FAIL(6b): channel verb failed"; echo "$OUT"; exit 1; }
echo "$OUT" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
assert d["channel"] == "'"$CHAN"'", f"channel mismatch: {d}"
assert d["count"] == 2, f"expected count=2, got {d[\"count\"]}"
assert isinstance(d["events"], list) and len(d["events"]) == 2, f"events not 2-element list: {d}"
# Chronological order: last 2 are seq 2 then seq 3
assert d["events"][0]["seq"] == 2, f"events[0].seq expected 2, got {d[\"events\"][0]}"
assert d["events"][1]["seq"] == 3, f"events[1].seq expected 3, got {d[\"events\"][1]}"
' || { echo "FAIL(6b): channel envelope wrong shape/order"; echo "$OUT"; exit 1; }
echo "PASS(6b): channel returns last N rows in chronological order"

cleanup_chan

echo
echo "verb-gates/context: PASS"
exit 0
