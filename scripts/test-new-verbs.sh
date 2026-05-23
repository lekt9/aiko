#!/usr/bin/env bash
# test-new-verbs.sh — self-test for the three new contract substrate verbs:
#   pre-mortem, baserate, invert
# Plus a regression check that `search --context ...` now appends a BASE RATE line.
#
# Asserts run against the REAL ledger (~/.contracts/contracts.jsonl). Test
# contracts are superseded into the gating contract (971e1917) at cleanup
# so the ledger stays append-only and the test contracts vanish from
# `contract list`.
#
# Exits 0 only on 5/5 PASS. Prints a clean per-step PASS/FAIL line.

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT="$SELF_DIR/contract"
GATE_CONTRACT="971e1917"
# Resolve the ledger the contract CLI will actually write to (env > project > global).
LEDGER=$(PYTHONPATH="$SELF_DIR/lib:${PYTHONPATH:-}" python3 -c "
from contract_core import _resolve_ledger
print(_resolve_ledger())
")

PASS=0
FAIL=0
FAILED_STEPS=()
TEST_ID=""
SIBLING_ID=""

_assert() {
  # _assert "<step name>" <cond_exit>
  local name="$1" rc="$2"
  if [ "$rc" -eq 0 ]; then
    echo "  PASS  $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $name"
    FAIL=$((FAIL+1))
    FAILED_STEPS+=("$name")
  fi
}

_grep_ledger_event() {
  # grep last 200 ledger lines for a row with both event=<ev> and id=<id>
  local ev="$1" id="$2"
  [ -f "$LEDGER" ] || return 1
  tail -200 "$LEDGER" | python3 -c "
import json, sys
ev = '$ev'; tid = '$id'
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except Exception: continue
    if r.get('event') == ev and r.get('id') == tid:
        sys.exit(0)
sys.exit(1)
"
}

echo "=== test-new-verbs.sh ==="
echo "  ledger:   $LEDGER"
echo "  contract: $CONTRACT"
echo

# ── Step 0: declare a throwaway test parent ───────────────────────────────
DECLARE_OUT=$(bash "$CONTRACT" declare \
  "TEST: throwaway parent for verb self-test $(date +%s)" \
  --action agent-judges --no-drive 2>&1)
TEST_ID=$(printf '%s\n' "$DECLARE_OUT" | grep -E '^declared:' | head -1 | awk '{print $2}')
if [ -z "$TEST_ID" ]; then
  echo "  FATAL: could not parse TEST_ID from declare output:"
  echo "$DECLARE_OUT" | sed 's/^/    /'
  exit 2
fi
echo "  TEST_ID=$TEST_ID"
echo

# ── Step 1: contract pre-mortem $TEST_ID --voices 3 ───────────────────────
echo "[1/5] pre-mortem fan-out"
PM_OUT=$(bash "$CONTRACT" pre-mortem "$TEST_ID" --voices 3 2>&1)
PM_RC=0
echo "$PM_OUT" | grep -q "=== PRE-MORTEM FAN-OUT ===" || PM_RC=1
echo "$PM_OUT" | grep -q "VOICE 3 of 3"               || PM_RC=1
_grep_ledger_event "pre-mortem" "$TEST_ID"            || PM_RC=1
_assert "pre-mortem: header + VOICE 3 of 3 + ledger row" "$PM_RC"

# ── Step 2: contract baserate $TEST_ID ────────────────────────────────────
echo "[2/5] baserate"
BR_OUT=$(bash "$CONTRACT" baserate "$TEST_ID" 2>&1)
BR_RC=0
echo "$BR_OUT" | grep -E "BASE RATE for this class: [0-9]+ / [0-9]+ satisfied = [0-9]+(\.[0-9]+)?%" >/dev/null || BR_RC=1
_grep_ledger_event "baserate" "$TEST_ID" || BR_RC=1
_assert "baserate: BASE RATE line + ledger row" "$BR_RC"

# ── Step 3: contract search --context "throwaway test" gets BASE RATE tail ─
echo "[3/5] search --context appends BASE RATE summary"
SR_OUT=$(bash "$CONTRACT" search --context "throwaway test" 2>&1)
SR_RC=0
echo "$SR_OUT" | grep -E "BASE RATE for this class: [0-9]+ / [0-9]+ satisfied = [0-9]+(\.[0-9]+)?%" >/dev/null || SR_RC=1
# Also verify the original search output is still there: either RELATED
# CONTRACTS header OR the "no related" message — both prove the script ran.
if ! { echo "$SR_OUT" | grep -q "RELATED CONTRACTS" || echo "$SR_OUT" | grep -q "no RELATED CONTRACTS"; }; then
  SR_RC=1
fi
_assert "search: original output + BASE RATE summary line" "$SR_RC"

# ── Step 4: contract invert $TEST_ID ──────────────────────────────────────
echo "[4/5] invert"
INV_OUT=$(bash "$CONTRACT" invert "$TEST_ID" 2>&1)
INV_RC=0
echo "$INV_OUT" | grep -q "=== INVERSION DECLARED ===" || INV_RC=1
SIBLING_ID=$(printf '%s\n' "$INV_OUT" | grep -E '^  sibling:' | head -1 | awk '{print $2}')
[ -n "$SIBLING_ID" ] || INV_RC=1
# Sibling's declared row carries inverted_from=$TEST_ID
if [ -n "$SIBLING_ID" ]; then
  python3 -c "
import json, sys
sid = '$SIBLING_ID'; tid = '$TEST_ID'
hit = False
with open('$LEDGER') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try: r = json.loads(line)
        except Exception: continue
        if r.get('event') == 'declared' and r.get('id') == sid:
            if r.get('inverted_from') == tid:
                hit = True
                break
sys.exit(0 if hit else 1)
" || INV_RC=1
fi
_assert "invert: header + sibling id + declared row has inverted_from" "$INV_RC"

# ── Step 5: cleanup — supersede test contracts into the gating contract ───
echo "[5/5] cleanup (supersede test contracts into $GATE_CONTRACT)"
CU_RC=0
bash "$CONTRACT" supersede "$TEST_ID" "$GATE_CONTRACT" \
  --reason "test-new-verbs.sh cleanup" >/dev/null 2>&1 || CU_RC=1
if [ -n "$SIBLING_ID" ]; then
  bash "$CONTRACT" supersede "$SIBLING_ID" "$GATE_CONTRACT" \
    --reason "test-new-verbs.sh cleanup (invert sibling)" >/dev/null 2>&1 || CU_RC=1
fi
_assert "cleanup: test contracts superseded into $GATE_CONTRACT" "$CU_RC"

echo
echo "=== RESULT ==="
echo "  PASS: $PASS / 5"
echo "  FAIL: $FAIL"
if [ "$FAIL" -ne 0 ]; then
  echo "  failed steps:"
  for s in "${FAILED_STEPS[@]}"; do
    echo "    - $s"
  done
  exit 1
fi
echo "  GREEN — all 5 assertions PASS, ledger rows verified."
exit 0
