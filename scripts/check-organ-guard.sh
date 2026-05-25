#!/usr/bin/env bash
# check-organ-guard.sh — runtime regression for Σ28 organ-shape mark-time guard.
#
# Proves that empty_organ, no_satisfied_branch, and stage_skip refusals fire
# from a real `_mark satisfied` call (not just the Python helper), and that
# --no-organ-guard bypass writes organ_guard_bypassed onto the row.
#
# Σ27 binary-IS-interface analog: the guard's truth surface IS this runtime
# probe of the real CLI, not a unit test of the helper in isolation.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CC="$SCRIPT_DIR/contract"

SBX=$(mktemp -d -t contract-organ-guard-XXXXXX)
trap "rm -rf '$SBX'" EXIT
export CONTRACTS_STORE="$SBX/contracts.jsonl"
export CONTRACT_AGENT="organ-guard-test@local"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ✓ $*"; }

# ─── 1. empty_organ: declare a funnel with zero children, try to mark ───
echo "=== empty_organ refusal ==="
EMPTY_FUNNEL=$("$CC" declare "an empty funnel that should refuse mark" --action funnel --no-drive 2>&1 \
  | grep -oE 'id:[[:space:]]+[a-f0-9]{8}' | head -1 | awk '{print $2}')
[[ -z "$EMPTY_FUNNEL" ]] && fail "could not declare empty funnel"
pass "declared empty funnel: $EMPTY_FUNNEL"

# Bare mark should be refused with ORGAN GUARD: empty_organ
OUT=$("$CC" _mark "$EMPTY_FUNNEL" satisfied --proof "trying to mark with no kids — should be refused" 2>&1 || true)
echo "$OUT" | grep -q "ORGAN GUARD: empty_organ" || fail "empty_organ refusal not surfaced. got:
$OUT"
pass "empty_organ refusal fired"

# Bypass via --no-organ-guard should write organ_guard_bypassed
OUT=$("$CC" _mark "$EMPTY_FUNNEL" satisfied --proof "agent acknowledges empty organ, bypassing" --no-organ-guard 2>&1 || true)
echo "$OUT" | grep -q "Σ28 ORGAN GUARD BYPASSED" || fail "bypass banner not emitted. got:
$OUT"
grep -q '"organ_guard_bypassed".*"empty_organ"' "$CONTRACTS_STORE" || fail "organ_guard_bypassed not written to row. ledger tail:
$(tail -3 "$CONTRACTS_STORE")"
pass "empty_organ bypass + audit row landed"

# ─── 2. no_satisfied_branch: funnel-first with children, none satisfied ───
echo "=== no_satisfied_branch refusal ==="
OR_ROOT=$("$CC" declare "an OR-gate that should refuse with zero satisfied branches" --action funnel-first --no-drive 2>&1 \
  | grep -oE 'id:[[:space:]]+[a-f0-9]{8}' | head -1 | awk '{print $2}')
[[ -z "$OR_ROOT" ]] && fail "could not declare funnel-first root"
# Spawn 2 unsatisfied children
"$CC" declare "branch a, never satisfied" --action "agent-judges" --parent "$OR_ROOT" --no-drive >/dev/null 2>&1
"$CC" declare "branch b, never satisfied" --action "agent-judges" --parent "$OR_ROOT" --no-drive >/dev/null 2>&1
pass "declared OR-gate with 2 unsatisfied branches: $OR_ROOT"

OUT=$("$CC" _mark "$OR_ROOT" satisfied --proof "trying to mark OR-gate with no winning branch" 2>&1 || true)
echo "$OUT" | grep -q "ORGAN GUARD: no_satisfied_branch" || fail "no_satisfied_branch refusal not surfaced. got:
$OUT"
pass "no_satisfied_branch refusal fired"

# ─── 3. stage_skip: sequence with unsatisfied stage 1, mark root ───
echo "=== stage_skip refusal ==="
SEQ_ROOT=$("$CC" declare "an ordered sequence that should refuse with stage 1 pending" --action sequence --no-drive 2>&1 \
  | grep -oE 'id:[[:space:]]+[a-f0-9]{8}' | head -1 | awk '{print $2}')
[[ -z "$SEQ_ROOT" ]] && fail "could not declare sequence root"
"$CC" declare "stage 1, will stay pending" --action "agent-judges" --parent "$SEQ_ROOT" --no-drive >/dev/null 2>&1
"$CC" declare "stage 2, never reached" --action "agent-judges" --parent "$SEQ_ROOT" --no-drive >/dev/null 2>&1
pass "declared sequence with 2 pending stages: $SEQ_ROOT"

OUT=$("$CC" _mark "$SEQ_ROOT" satisfied --proof "trying to mark sequence with stage 1 pending" 2>&1 || true)
echo "$OUT" | grep -q "ORGAN GUARD: stage_skip" || fail "stage_skip refusal not surfaced. got:
$OUT"
pass "stage_skip refusal fired"

# ─── 4. happy path: funnel with a satisfied child marks cleanly ───
echo "=== happy path: funnel with satisfied child ==="
GOOD_FUNNEL=$("$CC" declare "a funnel that should mark cleanly" --action funnel --no-drive 2>&1 \
  | grep -oE 'id:[[:space:]]+[a-f0-9]{8}' | head -1 | awk '{print $2}')
CHILD=$("$CC" declare "the one child" --action "agent-judges" --parent "$GOOD_FUNNEL" --no-drive 2>&1 \
  | grep -oE 'id:[[:space:]]+[a-f0-9]{8}' | head -1 | awk '{print $2}')
"$CC" _mark "$CHILD" satisfied --proof "child satisfied with a substantive proof string for the test" >/dev/null 2>&1
OUT=$("$CC" _mark "$GOOD_FUNNEL" satisfied --proof "all children satisfied, funnel resolves cleanly" 2>&1 || true)
echo "$OUT" | grep -q "ORGAN GUARD" && fail "organ guard fired on healthy funnel. got:
$OUT"
grep -q "\"event\": \"satisfied\", \"id\": \"$GOOD_FUNNEL\"" "$CONTRACTS_STORE" || fail "happy-path satisfied row missing"
pass "healthy funnel marked without guard refusal"

echo ""
echo "=== ALL GREEN ==="
echo "  Σ28 organ-shape mark-time guard: empty_organ / no_satisfied_branch / stage_skip"
echo "  refusals fire; --no-organ-guard bypass writes organ_guard_bypassed audit field;"
echo "  happy path with satisfied children unaffected."
