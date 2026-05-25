#!/usr/bin/env bash
# check-bridge-parser-and-refused.sh — pointer-types/bridge-parser-and-refused
# invariant for skill-self-test.sh. Proves:
#   (1) declare with action=bridge:contract:<8hex>@<owner>?cost=<n>
#       crystallizes pointer_type=bridge + bridge_foreign_id +
#       bridge_owner_canonical + bridge_cost_usdc on the declared row.
#   (2) iterate emits === BRIDGE REFUSED === with kind:/foreign_id:/cost_usdc:
#       and the reason naming both 2b98f80f and 036073d8.
#   (3) the iterated row has action_result == "fail" with action_meta
#       block_kind == "bridge-refused".
# Π10 honest gap (Γ1 no-stubs): success path lands when Σ17 + Π8 ship.
set -uo pipefail

SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/contract}"
CLI="$SKILL_DIR/scripts/contract"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

export CONTRACTS_STORE="$TMP"
export CONTRACT_NO_GIT_SYNC=1
export CONTRACT_NO_OUTLINE_SYNC=1
export CONTRACT_NO_UNBROWSE_MIRROR=1
export CONTRACT_AGENT="bridge-self-test"

ACTION='bridge:contract:deadbeef@lewis@getfoundry.app?cost=10'
DECL_OUT=$(bash "$CLI" declare 'Pi10 bridge parser self-test' --action "$ACTION" --no-drive 2>&1) || {
  echo "declare failed: $DECL_OUT" >&2
  exit 1
}
CID=$(printf '%s\n' "$DECL_OUT" | awk '/^declared:/ {print $2; exit}')
if [ -z "$CID" ]; then
  echo "could not parse declared id from output: $DECL_OUT" >&2
  exit 1
fi

# (1) Parser invariants on the declared row.
ROW=$(jq -c --arg id "$CID" 'select(.event=="declared" and .id==$id)' "$TMP" | head -1)
[ -n "$ROW" ] || { echo "no declared row for $CID in $TMP" >&2; exit 1; }
PT=$(printf '%s' "$ROW" | jq -r '.pointer_type')
FID=$(printf '%s' "$ROW" | jq -r '.bridge_foreign_id // empty')
OWN=$(printf '%s' "$ROW" | jq -r '.bridge_owner_canonical // empty')
COST=$(printf '%s' "$ROW" | jq -r '.bridge_cost_usdc // empty')
[ "$PT"   = "bridge" ]                 || { echo "pointer_type=$PT (expected bridge)"   >&2; exit 1; }
[ "$FID"  = "deadbeef" ]               || { echo "bridge_foreign_id=$FID (expected deadbeef)" >&2; exit 1; }
[ "$OWN"  = "lewis@getfoundry.app" ]   || { echo "bridge_owner_canonical=$OWN"          >&2; exit 1; }
[ "$COST" = "10" ]                     || { echo "bridge_cost_usdc=$COST (expected 10)" >&2; exit 1; }

# (2) Iterate emits the BRIDGE REFUSED block on stderr with required fields.
IT_OUT=$(bash "$CLI" iterate "$CID" 2>&1)
printf '%s' "$IT_OUT" | grep -q '=== BRIDGE REFUSED ===' || {
  echo "missing === BRIDGE REFUSED === in iterate output:" >&2
  printf '%s\n' "$IT_OUT" >&2
  exit 1
}
printf '%s' "$IT_OUT" | grep -q 'foreign_id: deadbeef' || { echo "missing 'foreign_id: deadbeef'" >&2; exit 1; }
printf '%s' "$IT_OUT" | grep -q 'cost_usdc: 10'        || { echo "missing 'cost_usdc: 10'"        >&2; exit 1; }
printf '%s' "$IT_OUT" | grep -q '2b98f80f'             || { echo "reason missing gap 2b98f80f"    >&2; exit 1; }
printf '%s' "$IT_OUT" | grep -q '036073d8'             || { echo "reason missing gap 036073d8"    >&2; exit 1; }

# (3) Iterated row records action_result=fail with action_meta.block_kind.
IT_ROW=$(jq -c --arg id "$CID" 'select(.event=="iterated" and .id==$id)' "$TMP" | tail -1)
[ -n "$IT_ROW" ] || { echo "no iterated row for $CID in $TMP" >&2; exit 1; }
AR=$(printf '%s' "$IT_ROW" | jq -r '.action_result')
[ "$AR" = "fail" ] || { echo "action_result=$AR (expected fail)" >&2; exit 1; }
BK=$(printf '%s' "$IT_ROW" | jq -r '.action_meta.block_kind // empty')
[ "$BK" = "bridge-refused" ] || { echo "action_meta.block_kind=$BK (expected bridge-refused)" >&2; exit 1; }

exit 0
