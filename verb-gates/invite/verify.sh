#!/usr/bin/env bash
# verb-gate: invite (Σ5) — viral allowlist with per-inviter cap.
#
# Catches regressions where:
#   - stranger CAN invite (the worst possible bug — allowlist bypass)
#   - cap doesn't enforce (>2 invites per inviter slip through)
#   - invitee doesn't become team after invite (membership doesn't propagate)
#   - self-invite slips (alice invites alice)
#   - re-invite of existing team member silently succeeds
#   - Σ3 alias chain skipped (lewis's invites should count across all his aliases)
set -euo pipefail

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT

export CONTRACTS_STORE="$TD/contracts.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

declare_as() {
  local agent="$1"
  CONTRACT_AGENT="$agent" "$CLI" declare "bootstrap-by-$agent" --action "true" --no-drive 2>&1 \
    | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1
}

invite_as() {
  local agent="$1" invitee="$2"
  CONTRACT_AGENT="$agent" "$CLI" invite "$invitee" 2>&1
}

# Bootstrap: lewis declares to become team.
declare_as "lewis@example.com" >/dev/null

# === Phase 1: stranger (never declared) MUST be refused ===
OUT_STR=$(invite_as "stranger@nowhere" "eve@example.com" || true)
echo "$OUT_STR" | grep -q "is not a team member" || { echo "FAIL: stranger was not refused. OUT=$OUT_STR"; exit 1; }
# Verify NO `invite` row was written for that attempted invite.
if grep -q '"event": *"invite".*"invitee": *"eve@example.com"' "$CONTRACTS_STORE" 2>/dev/null; then
  echo "FAIL: stranger invite leaked a ledger row (allowlist bypass!)"; exit 1
fi

# === Phase 2: lewis invites alice + bob (2/2 cap) ===
invite_as "lewis@example.com" "alice@example.com" | grep -q "invited:" || { echo "FAIL: lewis can't invite alice"; exit 1; }
invite_as "lewis@example.com" "bob@example.com"   | grep -q "invited:" || { echo "FAIL: lewis can't invite bob"; exit 1; }

# === Phase 3: lewis hits the cap on the 3rd ===
OUT_CAP=$(invite_as "lewis@example.com" "carol@example.com" || true)
echo "$OUT_CAP" | grep -qE "2/2 active invites|cap reached" || { echo "FAIL: cap did not enforce. OUT=$OUT_CAP"; exit 1; }

# === Phase 4: alice (an invitee, now team) can invite ===
invite_as "alice@example.com" "carol@example.com" | grep -q "invited:" || { echo "FAIL: alice (invitee) can't invite carol"; exit 1; }

# === Phase 5: re-inviting an existing team member is refused ===
OUT_RE=$(invite_as "alice@example.com" "lewis@example.com" || true)
echo "$OUT_RE" | grep -q "already a team member" || { echo "FAIL: re-invite of existing team not refused. OUT=$OUT_RE"; exit 1; }

# === Phase 6: self-invite refused ===
OUT_SELF=$(invite_as "alice@example.com" "alice@example.com" || true)
echo "$OUT_SELF" | grep -qE "can't invite yourself|already a team member" || { echo "FAIL: self-invite slipped. OUT=$OUT_SELF"; exit 1; }

# === Phase 7: Σ3 — lewis's aliases share the cap (lekt8 = lewis@example.com) ===
# Reset by giving lewis a fresh allowlist via alias on a clean tempdir scenario.
# We can't easily reset the cap mid-test; instead create a new tempdir + new lewis
# and verify the cap is shared across aliases.
TD2=$(mktemp -d)
export CONTRACTS_STORE="$TD2/contracts.jsonl"
declare_as "lewis2@example.com" >/dev/null
"$CLI" alias "lewis2@example.com" "lekt8-alias" >/dev/null 2>&1
invite_as "lewis2@example.com" "x@example.com" | grep -q "invited:" || { echo "FAIL: alias-test: lewis2 can't invite x"; exit 1; }
invite_as "lekt8-alias"        "y@example.com" | grep -q "invited:" || { echo "FAIL: alias-test: lekt8-alias (= lewis2) can't invite y"; exit 1; }
OUT_ALIAS=$(invite_as "lekt8-alias" "z@example.com" || true)
echo "$OUT_ALIAS" | grep -qE "2/2 active invites|cap reached" || { echo "FAIL: alias-test: cap not shared across aliases. OUT=$OUT_ALIAS"; exit 1; }

echo "PASS: invite gate (Σ5) — stranger refused, 2-per-inviter cap enforced, invitees promoted, self-invite + re-invite refused, Σ3 aliases share the cap"
