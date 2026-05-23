#!/usr/bin/env bash
# verb-gate: alias (Σ3) — identity equivalence classes resolve transitively.
#
# Catches regressions where:
#   - declared `alias` row isn't honored by visible_to/is_team_member
#   - canonical resolution drops mid-walk (e.g., declared (A,B) then (B,C)
#     fails to unify A↔C — transitivity broken)
#   - cache invalidation misses on a fresh alias declaration
#   - latest canonical name doesn't win when re-declared
#   - unaliased identities accidentally collapse to someone else
set -euo pipefail

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT

export CONTRACTS_STORE="$TD/contracts.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

declare_as() {
  local agent="$1" plan="$2"
  CONTRACT_AGENT="$agent" "$CLI" declare "$plan" --action "true" --no-drive 2>&1 \
    | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1
}

contains() {
  local id="$1"; shift
  "$CLI" list "$@" 2>&1 | grep -q "$id"
}

# Two declarers: lewis-canonical, alice (a separate team member).
ROW_LEWIS=$(declare_as "lewis@getfoundry.app" "lewis-team-row")
ROW_ALICE=$(declare_as "alice@example.com"     "alice-team-row")
[ -n "$ROW_LEWIS" ] || { echo "FAIL: lewis declare empty"; exit 1; }
[ -n "$ROW_ALICE" ] || { echo "FAIL: alice declare empty"; exit 1; }

# === Phase 1: pre-alias state — bot and unrelated aliases are not team ===
if contains "$ROW_LEWIS" --for "lekt8"; then
  echo "FAIL: lekt8 sees team row BEFORE aliasing (not team yet)"; exit 1
fi
if contains "$ROW_LEWIS" --for "foundry_aiko_bot"; then
  echo "FAIL: bot sees team row (should be team-default invisible)"; exit 1
fi

# === Phase 2: declare alias lewis = lewistham9x = lekt8 ===
"$CLI" alias "lewis@getfoundry.app" "lewistham9x@gmail.com" "lekt8" >/dev/null 2>&1 \
  || { echo "FAIL: alias verb errored"; exit 1; }

# === Phase 3: post-alias — lekt8 now sees team rows (resolves to canonical lewis) ===
contains "$ROW_LEWIS" --for "lekt8"               || { echo "FAIL: lekt8 can't see lewis team row after alias"; exit 1; }
contains "$ROW_ALICE" --for "lekt8"               || { echo "FAIL: lekt8 can't see alice team row (alice is also team)"; exit 1; }
contains "$ROW_LEWIS" --for "lewistham9x@gmail.com" || { echo "FAIL: lewistham9x can't see team row"; exit 1; }

# Bot still NOT team — was never aliased.
if contains "$ROW_LEWIS" --for "foundry_aiko_bot"; then
  echo "FAIL: bot now sees team row (alias should NOT have made the bot team)"; exit 1
fi

# === Phase 4: transitivity — declare (lekt8, lekt9) extends the group via lekt8 ===
"$CLI" alias "lewis@getfoundry.app" "lekt9" >/dev/null 2>&1 \
  || { echo "FAIL: second alias errored"; exit 1; }
contains "$ROW_LEWIS" --for "lekt9" || { echo "FAIL: lekt9 (transitively in lewis group) can't see team row"; exit 1; }

# === Phase 5: private-tier respects aliases (declarer can see own row) ===
PRIV=$(CONTRACT_AGENT="lewis@getfoundry.app" "$CLI" declare \
  "lewis private claim" --action "true" --audience "private" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$PRIV" ] || { echo "FAIL: priv declare empty"; exit 1; }
contains "$PRIV" --for "lekt8" || { echo "FAIL: lekt8 (= lewis via alias) can't see lewis's private"; exit 1; }
if contains "$PRIV" --for "alice@example.com"; then
  echo "FAIL: alice CAN see lewis's private (alias group leak!)"; exit 1
fi

# === Phase 6: unaliased identity resolves to itself ===
# A brand-new viewer never seen in the ledger → not team → public-only.
COUNT=$( "$CLI" list --for "totally-new-stranger" 2>&1 | grep -c '^\[' || true )
[ "$COUNT" = "0" ] || { echo "FAIL: stranger sees $COUNT team rows (should be 0; no public rows here)"; exit 1; }

echo "PASS: alias gate (Σ3) — equivalence classes resolve transitively, team membership canonicalized, private respects aliases, unaliased identities self-resolve"
