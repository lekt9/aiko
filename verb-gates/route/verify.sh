#!/usr/bin/env bash
# verb-gate: route — backend-selection IS a /contract, not a per-action hardcode.
#
# Plank 2 of DEFERRED-MEGA-VISION 386497eb. Realises layer-router auto-pick
# via existing primitives: funnel-first organ + N candidate cells iterated
# in declared order, first PASS wins. Every candidate is a visible CHILD ROW
# (not hidden in one action) — `contract status <organ>` shows the full graph
# per the multi-dimensional-gates doctrine.
#
# Catches regressions where:
#   - first-PASS doesn't short-circuit (would over-iterate; defeats efficiency)
#   - middle-PASS-after-FAIL doesn't satisfy the organ (would silently lose work)
#   - all-FAIL doesn't surface ROUTE FAILED block (silent failure; un-debuggable)
#   - empty --try silently succeeds (would auto-pass with no backend)
#   - organ pointer_type isn't funnel-first (composition-shape claim broken)
#   - children aren't real ledger rows (route hides logic instead of exposing graph)
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"
mkdir -p "$TD/.contracts/hooks"  # silence hook-dir warnings

# === Phase 1: middle-PASS-after-FAIL (false → true → machine:true) ===
OUT_MID=$("$CLI" route "phase1 middle PASS" \
  --try "false" \
  --try "true" \
  --try "machine:true" 2>&1)
echo "$OUT_MID" | grep -q "candidate 1/3: false"   || { echo "FAIL P1: missing candidate 1 in trace. OUT=$OUT_MID"; exit 1; }
echo "$OUT_MID" | grep -q "→ FAIL"                  || { echo "FAIL P1: no FAIL line for false. OUT=$OUT_MID"; exit 1; }
echo "$OUT_MID" | grep -q "candidate 2/3: true"    || { echo "FAIL P1: missing candidate 2 in trace. OUT=$OUT_MID"; exit 1; }
echo "$OUT_MID" | grep -q "→ PASS (winner)"        || { echo "FAIL P1: no PASS-winner line. OUT=$OUT_MID"; exit 1; }
echo "$OUT_MID" | grep -q "result: PASS"           || { echo "FAIL P1: no overall PASS. OUT=$OUT_MID"; exit 1; }
echo "$OUT_MID" | grep -q "backend=true"           || { echo "FAIL P1: winner backend not reported. OUT=$OUT_MID"; exit 1; }
# Candidate 3 must NOT have been iterated (short-circuit on first PASS)
echo "$OUT_MID" | grep -q "candidate 3/3"          && { echo "FAIL P1: route did NOT short-circuit on first PASS. OUT=$OUT_MID"; exit 1; }
ORGAN_P1=$(echo "$OUT_MID" | grep -oE "organ=[a-f0-9]{8}" | head -1 | cut -d= -f2)
[ -n "$ORGAN_P1" ] || { echo "FAIL P1: no organ id in PASS line"; exit 1; }

# === Phase 2: organ pointer_type IS funnel-first + 3 children exist ===
STATUS_P1=$("$CLI" status "$ORGAN_P1" 2>&1)
echo "$STATUS_P1" | grep -qE "action: funnel-first" || { echo "FAIL P2: organ action not funnel-first. STATUS=$STATUS_P1"; exit 1; }
CHILD_COUNT=$(echo "$STATUS_P1" | grep -cE "^\s*\[(pending|satisfied|active)\] [a-f0-9]{8} \(cell\)")
[ "$CHILD_COUNT" = "3" ] || { echo "FAIL P2: expected 3 child cells in status, got $CHILD_COUNT. STATUS=$STATUS_P1"; exit 1; }

# === Phase 3: first-PASS short-circuit (true wins immediately, machine:false never tried) ===
OUT_FIRST=$("$CLI" route "phase3 first PASS" \
  --try "true" \
  --try "false" 2>&1)
echo "$OUT_FIRST" | grep -q "candidate 2"           && { echo "FAIL P3: candidate 2 iterated despite candidate 1 PASS. OUT=$OUT_FIRST"; exit 1; }
echo "$OUT_FIRST" | grep -q "result: PASS"          || { echo "FAIL P3: first-PASS didn't resolve. OUT=$OUT_FIRST"; exit 1; }

# === Phase 4: all-FAIL surfaces ROUTE FAILED block + exit 1 + reasons listed ===
set +e
OUT_FAIL=$("$CLI" route "phase4 all-fail" \
  --try "false" \
  --try "machine:totally-nonexistent-binary-xyz" \
  --try "false" 2>&1)
ROUTE_FAIL_RC=$?
set -e
[ "$ROUTE_FAIL_RC" = "1" ]                          || { echo "FAIL P4: all-fail route exited $ROUTE_FAIL_RC, expected 1"; exit 1; }
echo "$OUT_FAIL" | grep -q "=== ROUTE FAILED ==="   || { echo "FAIL P4: ROUTE FAILED block missing. OUT=$OUT_FAIL"; exit 1; }
echo "$OUT_FAIL" | grep -q "attempted: 3 backend"   || { echo "FAIL P4: block doesn't name attempt count. OUT=$OUT_FAIL"; exit 1; }
echo "$OUT_FAIL" | grep -q "false"                  || { echo "FAIL P4: block doesn't list failed specs. OUT=$OUT_FAIL"; exit 1; }
echo "$OUT_FAIL" | grep -q "totally-nonexistent"    || { echo "FAIL P4: block doesn't list machine: spec. OUT=$OUT_FAIL"; exit 1; }
# Sanity: machine: MISSING reason got captured
echo "$OUT_FAIL" | grep -qE "MISSING|FAIL"          || { echo "FAIL P4: failure reasons not surfaced. OUT=$OUT_FAIL"; exit 1; }

# === Phase 5: missing args → exit 2 with usage ===
set +e
OUT_USAGE1=$("$CLI" route 2>&1)
RC1=$?
OUT_USAGE2=$("$CLI" route "plan but no try" 2>&1)
RC2=$?
set -e
[ "$RC1" = "2" ]                                    || { echo "FAIL P5a: empty route didn't exit 2 (got $RC1). OUT=$OUT_USAGE1"; exit 1; }
[ "$RC2" = "2" ]                                    || { echo "FAIL P5b: route without --try didn't exit 2 (got $RC2). OUT=$OUT_USAGE2"; exit 1; }
echo "$OUT_USAGE1" | grep -q "usage: contract route" || { echo "FAIL P5a: no usage line. OUT=$OUT_USAGE1"; exit 1; }
echo "$OUT_USAGE2" | grep -q "usage: contract route" || { echo "FAIL P5b: no usage line. OUT=$OUT_USAGE2"; exit 1; }

# === Phase 6: routed children are real ledger rows with their declared specs as action ===
# Take the failed route's organ, list its children, confirm each carries its --try spec
ORGAN_P4=$(echo "$OUT_FAIL" | grep -oE "organ:\s+[a-f0-9]{8}" | head -1 | awk '{print $2}')
[ -n "$ORGAN_P4" ] || { echo "FAIL P6: no organ id surfaced on failure. OUT=$OUT_FAIL"; exit 1; }
STATUS_P4=$("$CLI" status "$ORGAN_P4" 2>&1)
echo "$STATUS_P4" | grep -q "action: false"               || { echo "FAIL P6: child action 'false' not in status. STATUS=$STATUS_P4"; exit 1; }
echo "$STATUS_P4" | grep -q "machine:totally-nonexistent" || { echo "FAIL P6: child action 'machine:...' not in status. STATUS=$STATUS_P4"; exit 1; }

# === Phase 7: route composes mixed-backend specs (machine: + cli) on one organ ===
# This proves the doctrine "routing IS a funnel-first organ of mixed-pointer-type children"
OUT_MIXED=$("$CLI" route "phase7 mixed backends" \
  --try "machine:nonexistent-bin-9z" \
  --try "true" 2>&1)
ORGAN_P7=$(echo "$OUT_MIXED" | grep -oE "organ=[a-f0-9]{8}" | head -1 | cut -d= -f2)
[ -n "$ORGAN_P7" ] || { echo "FAIL P7: no organ id from mixed route. OUT=$OUT_MIXED"; exit 1; }
STATUS_P7=$("$CLI" status "$ORGAN_P7" 2>&1)
# Both pointer-types should be represented as children:
echo "$STATUS_P7" | grep -q "machine:nonexistent" || { echo "FAIL P7: machine: child missing from organ. STATUS=$STATUS_P7"; exit 1; }
echo "$STATUS_P7" | grep -q "action: true"         || { echo "FAIL P7: cli child missing from organ. STATUS=$STATUS_P7"; exit 1; }

echo "PASS: route gate — middle-PASS-after-FAIL satisfies organ, organ pointer_type=funnel-first with N child cells, first-PASS short-circuits, all-FAIL surfaces ROUTE FAILED block + exit 1 + reasons, missing args → exit 2 with usage, routed children are real ledger rows with their --try spec as action, mixed-backend composition (machine: + cli on one organ) works"
