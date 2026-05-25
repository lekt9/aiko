#!/usr/bin/env bash
# verb-gate for Π10 bridge: pointer-type
#
# Asserts:
#   1. `--action "bridge:contract:<id>@<owner>?cost=<n>"` declares a row with
#      pointer_type="bridge" on the ledger.
#   2. iterate emits === BRIDGE REFUSED === block with structured fields
#      (foreign_id, owner_canonical, cost_usdc) and the reason citing gap 2b98f80f.
#   3. iterate exits non-zero (refused, not satisfied).
#
# Honest by construction: until Σ17 (gap 2b98f80f) and unbrowse-broker
# (gap 036073d8) land, every bridge: iterate MUST refuse. Γ1 no-stubs.

set -u  # NOT set -e: we want to inspect failing exit codes

CONTRACT_BIN="$HOME/.claude/skills/contract/scripts/contract"
LEDGER="$HOME/.contracts/contracts.jsonl"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

cd "$TMPDIR" || fail "cannot cd to $TMPDIR"

echo "=== verb-gate: bridge-pointer ==="

# --- step 1: declare a bridge contract ---
declare_out=$(bash "$CONTRACT_BIN" declare \
  "VERB-GATE bridge-pointer smoke" \
  --action "bridge:contract:deadbeef@lewis@getfoundry.app?cost=10" \
  --no-drive 2>&1)
declare_rc=$?
[ "$declare_rc" -eq 0 ] || fail "declare exited $declare_rc — out: $declare_out"

CID=$(printf '%s\n' "$declare_out" | awk '/^declared:/ {print $2; exit}')
[ -n "$CID" ] || fail "could not parse contract id from declare output: $declare_out"
pass "declared id=$CID"

# --- step 2: assert pointer_type is "bridge" on the declared row ---
ptype=$(grep "\"id\": \"$CID\"" "$LEDGER" \
  | grep '"event": "declared"' \
  | head -1 \
  | python3 -c "import json,sys; row=json.loads(sys.stdin.read()); print(row.get('pointer_type',''))" 2>/dev/null)
[ "$ptype" = "bridge" ] || fail "expected pointer_type=bridge, got '$ptype' for id=$CID"
pass "pointer_type=bridge persisted on declared row"

# --- step 3: iterate and capture stderr + stdout ---
# Note: the iterate verb wraps action_rc into the TWO-KEY EXIT block and does
# not propagate the inner action's exit code as the script's exit. We instead
# verify the recorded action_result on the ledger row, which is the
# source-of-truth for whether the inner action passed or failed.
iter_out=$(bash "$CONTRACT_BIN" iterate "$CID" 2>&1)

# --- step 4: assert KEY 1 = FAIL in output AND action_result=fail on ledger ---
printf '%s\n' "$iter_out" | grep -q "KEY 1 (machine): FAIL" \
  || fail "expected KEY 1 (machine): FAIL in iterate output (bridge was not refused)"
pass "iterate reported KEY 1 (machine): FAIL"

last_result=$(grep "\"id\": \"$CID\"" "$LEDGER" \
  | grep '"event": "iterated"' \
  | tail -1 \
  | python3 -c "import json,sys; row=json.loads(sys.stdin.read()); print(row.get('action_result',''))" 2>/dev/null)
[ "$last_result" = "fail" ] || fail "expected last iteration action_result='fail', got '$last_result'"
pass "ledger row records action_result=fail (refused, not satisfied)"

# --- step 5: assert the === BRIDGE REFUSED === block + structured fields ---
printf '%s\n' "$iter_out" | grep -q "=== BRIDGE REFUSED ===" \
  || fail "missing === BRIDGE REFUSED === block in iterate output"
pass "block header present"

printf '%s\n' "$iter_out" | grep -q "foreign_id=deadbeef" \
  || fail "missing foreign_id=deadbeef"
pass "foreign_id=deadbeef present"

printf '%s\n' "$iter_out" | grep -q "owner_canonical=lewis@getfoundry.app" \
  || fail "missing owner_canonical=lewis@getfoundry.app"
pass "owner_canonical=lewis@getfoundry.app present"

printf '%s\n' "$iter_out" | grep -q "cost_usdc=10" \
  || fail "missing cost_usdc=10"
pass "cost_usdc=10 present"

printf '%s\n' "$iter_out" | grep -q "2b98f80f" \
  || fail "reason does not cite Σ17 RBAC gap 2b98f80f"
pass "reason cites gap 2b98f80f"

echo ""
echo "PASS: verb-gate bridge-pointer (parser + refused-block emitter shipped)"
exit 0
