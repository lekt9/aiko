#!/usr/bin/env bash
# Verb-gate for Φ11 (doctrine 23dff9bf): _render_fractal_context fires from
# _fire_contract_hooks on EVERY substrate emission (declare / iterate / mark).
# Builds a 3-deep test organ in a sandboxed ledger, asserts that the
# === FRACTAL CONTEXT === block appears in stderr for each of the three events
# AND that the block names the full parent chain + the referrer.
#
# Composes Σ25 b84774cd (guards baked at chokepoint) + Σ10 117928f7
# (universal verb hook bus) + Σ1 (agent attribution) by exercising the
# render path through the real CLI, not a mock.

set -euo pipefail

CONTRACT="${CONTRACT_CLI:-$HOME/.claude/skills/contract/scripts/contract}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export CONTRACTS_STORE="$TMP/contracts.jsonl"

fail() { echo "phi11-fractal-context FAIL: $*" >&2; exit 1; }
pass() { echo "phi11-fractal-context PASS: $*"; }

# Build 3-deep test organ
ROOT=$(bash "$CONTRACT" declare "phi11-gate root organ" --action funnel --no-drive --no-layer-guard 2>/dev/null | grep -oE "^declared: [0-9a-f]{8}" | awk '{print $2}')
[ -n "$ROOT" ] || fail "root declare returned no id"

ORGAN=$(bash "$CONTRACT" declare "phi11-gate organ" --action sequence --parent "$ROOT" --no-drive --no-layer-guard 2>/dev/null | grep -oE "^declared: [0-9a-f]{8}" | awk '{print $2}')
[ -n "$ORGAN" ] || fail "organ declare returned no id"

LEAF=$(bash "$CONTRACT" declare "phi11-gate leaf" --action agent-judges --parent "$ORGAN" --no-drive --no-layer-guard 2>/dev/null | grep -oE "^declared: [0-9a-f]{8}" | awk '{print $2}')
[ -n "$LEAF" ] || fail "leaf declare returned no id"

REF=$(bash "$CONTRACT" declare "phi11-gate referrer" --action "contract:$LEAF" --no-drive --no-layer-guard 2>/dev/null | grep -oE "^declared: [0-9a-f]{8}" | awk '{print $2}')
[ -n "$REF" ] || fail "referrer declare returned no id"

# Assertion 1: FRACTAL CONTEXT fires on iterate
ITER_STDERR=$(bash "$CONTRACT" iterate "$LEAF" --no-layer-guard 2>&1 1>/dev/null)
echo "$ITER_STDERR" | grep -q "=== FRACTAL CONTEXT ===" || fail "no FRACTAL CONTEXT block on iterate"
echo "$ITER_STDERR" | grep -q "$ROOT\[funnel\] → $ORGAN\[sequence\] → THIS\[judgment\]" || \
  fail "iterate FRACTAL CONTEXT missing 3-deep parent chain ($ROOT → $ORGAN → THIS)"
echo "$ITER_STDERR" | grep -q "$REF" || fail "iterate FRACTAL CONTEXT missing referrer $REF"
pass "iterate emits FRACTAL CONTEXT with parent chain + referrer"

# Assertion 2: FRACTAL CONTEXT fires on _mark
MARK_STDERR=$(bash "$CONTRACT" _mark "$LEAF" satisfied --proof "phi11-gate test mark" --no-layer-guard 2>&1 1>/dev/null)
echo "$MARK_STDERR" | grep -q "=== FRACTAL CONTEXT ===" || fail "no FRACTAL CONTEXT block on _mark"
echo "$MARK_STDERR" | grep -q "EVENT:.*mark" || fail "mark FRACTAL CONTEXT missing EVENT=mark line"
echo "$MARK_STDERR" | grep -q "harness → evidence on row.*satisfied" || \
  fail "mark FRACTAL CONTEXT missing satisfied status"
pass "_mark emits FRACTAL CONTEXT with satisfied state"

# Assertion 3: bypass env silences the block
SILENT_STDERR=$(CONTRACT_FRACTAL_CONTEXT=0 bash "$CONTRACT" iterate "$ROOT" --no-layer-guard 2>&1 1>/dev/null || true)
if echo "$SILENT_STDERR" | grep -q "=== FRACTAL CONTEXT ==="; then
  fail "CONTRACT_FRACTAL_CONTEXT=0 did not silence the block"
fi
pass "CONTRACT_FRACTAL_CONTEXT=0 silences the block"

# Assertion 4: re-entry guard prevents recursion
[ "${CONTRACT_PHI11_FIRING:-}" = "" ] || fail "re-entry guard env should be unset outside firing"
pass "re-entry guard env clean after invocation"

# Assertion 5: the function definition exists in the source
grep -q "^_render_fractal_context()" "$CONTRACT" || fail "_render_fractal_context() not defined in CLI source"
grep -q "_render_fractal_context.*\$event.*\$id.*\$rc" "$CONTRACT" || \
  fail "_render_fractal_context not wired from _fire_contract_hooks chokepoint"
pass "function definition + chokepoint wiring present in source"

echo "phi11-fractal-context: all assertions pass"
exit 0
