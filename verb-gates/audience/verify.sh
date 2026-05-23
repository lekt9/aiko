#!/usr/bin/env bash
# verb-gate: audience (Σ2) — three-tier visibility (private / team / public)
# plus explicit-identity audience lists.
#
# Tiers (Lewis 2026-05-23):
#   public  — every viewer sees
#   team    — viewers in the ledger's agent-set (Σ1 attribution column)
#   private — only the declarer sees (row.agent == viewer)
#   default — implicit ["team"] when audience field is absent
#
# Catches regressions where:
#   - explicit-identity lists stop filtering (mixed with tier semantics)
#   - team tier accidentally lets unknown viewers in (bot leak!)
#   - private tier leaks to non-declarers
#   - default-team isn't applied to legacy rows missing the audience field
#   - public marker no longer wins over tier checks
set -euo pipefail

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT

export CONTRACTS_STORE="$TD/contracts.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

# Declarer A: lewis identity. Declarer B: alice identity. Bot: foundry_aiko_bot
# (never declares — should NOT count as team).
A="lewis@example.com"
B="alice@example.com"

declare_as() {
  # $1=agent, $2=plan, $3=audience (optional)
  local agent="$1" plan="$2" aud="${3:-}"
  if [ -n "$aud" ]; then
    CONTRACT_AGENT="$agent" "$CLI" declare "$plan" --action "true" --audience "$aud" --no-drive 2>&1 \
      | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1
  else
    CONTRACT_AGENT="$agent" "$CLI" declare "$plan" --action "true" --no-drive 2>&1 \
      | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1
  fi
}

# Variety of rows: each declarer + each audience tier + an explicit-id list.
PUB=$(declare_as "$A" "public-claim" "public")          # everyone
TEAM_A=$(declare_as "$A" "default-team-by-lewis" "")    # default → team
TEAM_B=$(declare_as "$B" "default-team-by-alice" "")    # default → team
PRIV_A=$(declare_as "$A" "private-to-lewis" "private")  # only lewis (declarer)
PRIV_B=$(declare_as "$B" "private-to-alice" "private")  # only alice (declarer)
EXPLICIT=$(declare_as "$A" "addressed-to-bot" "foundry_aiko_bot")  # bot only

for id in "$PUB" "$TEAM_A" "$TEAM_B" "$PRIV_A" "$PRIV_B" "$EXPLICIT"; do
  [ -n "$id" ] || { echo "FAIL: empty declared id"; exit 1; }
done

contains() {
  # contains <id> <args> → exit 0 if id is in list output
  local id="$1"; shift
  "$CLI" list "$@" 2>&1 | grep -q "$id"
}

count_visible() {
  "$CLI" list "$@" 2>&1 | grep -c '^\[' || true
}

# === Lewis is a team member (declared rows) ===
#   Should see: PUB, TEAM_A, TEAM_B (team), PRIV_A (declarer), EXPLICIT? no (addressed to bot only).
#   Should NOT see: PRIV_B (someone else's private).
contains "$PUB"     --for "$A" || { echo "FAIL: lewis can't see public"; exit 1; }
contains "$TEAM_A"  --for "$A" || { echo "FAIL: lewis can't see his own team row"; exit 1; }
contains "$TEAM_B"  --for "$A" || { echo "FAIL: lewis can't see alice's team row (both are team)"; exit 1; }
contains "$PRIV_A"  --for "$A" || { echo "FAIL: lewis can't see his own private"; exit 1; }
if contains "$PRIV_B" --for "$A"; then
  echo "FAIL: lewis CAN see alice's private (leak!)"; exit 1
fi
if contains "$EXPLICIT" --for "$A"; then
  echo "FAIL: lewis sees a row addressed only to the bot"; exit 1
fi

# === Bot is NOT a team member (never declared) ===
#   Should see: PUB, EXPLICIT (addressed-to-bot).
#   Should NOT see: TEAM_A, TEAM_B, PRIV_A, PRIV_B.
contains "$PUB"      --for "foundry_aiko_bot" || { echo "FAIL: bot can't see public"; exit 1; }
contains "$EXPLICIT" --for "foundry_aiko_bot" || { echo "FAIL: bot can't see row addressed to it"; exit 1; }
if contains "$TEAM_A" --for "foundry_aiko_bot"; then
  echo "FAIL: bot sees a team row (team leak!)"; exit 1
fi
if contains "$TEAM_B" --for "foundry_aiko_bot"; then
  echo "FAIL: bot sees another team row"; exit 1
fi
if contains "$PRIV_A" --for "foundry_aiko_bot"; then
  echo "FAIL: bot sees a private row"; exit 1
fi

# === Stranger never seen in ledger → NOT team ===
STR=$(count_visible --for "completely-new-stranger")
[ "$STR" = "1" ] || { echo "FAIL: stranger sees $STR rows, expected 1 (public only)"; exit 1; }
contains "$PUB" --for "completely-new-stranger" || { echo "FAIL: stranger can't see public"; exit 1; }

# === No --for: every row visible (no filter applied) ===
ALL=$(count_visible)
[ "$ALL" = "6" ] || { echo "FAIL: plain list count=$ALL, expected 6"; exit 1; }

echo "PASS: audience gate (Σ2) — three-tier (public/team/private) + explicit-id + bot-not-team leak-free"
