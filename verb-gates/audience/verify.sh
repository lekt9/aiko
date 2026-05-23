#!/usr/bin/env bash
# verb-gate: audience (Σ2) — declare --audience + list --for filter behaviour.
#
# Binds the truth-claim that the substrate filters ledger queries by viewer
# identity. Catches a regression where:
#   - declare drops the --audience arg
#   - list ignores --for
#   - audience=None rows accidentally become invisible to all viewers
#   - "public" marker stops behaving like the implicit-public default
#   - an unknown viewer somehow sees a restricted row
#
# Tempdir-scoped CONTRACTS_STORE so the real ledger is never touched.
set -euo pipefail

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT

export CONTRACTS_STORE="$TD/contracts.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

declare_id() {
  # $1 = plan, $2 = audience flag value (empty for public)
  local plan="$1" aud="$2"
  if [ -n "$aud" ]; then
    "$CLI" declare "$plan" --action "true" --audience "$aud" --no-drive 2>&1 \
      | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1
  else
    "$CLI" declare "$plan" --action "true" --no-drive 2>&1 \
      | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1
  fi
}

PUB=$(declare_id "public-claim" "")
LEW=$(declare_id "lewis-only-claim" "lewis@example.com")
BOT=$(declare_id "bot-only-claim" "foundry_aiko_bot")
PUBX=$(declare_id "explicit-public-claim" "public")
MUL=$(declare_id "multi-claim" "lewis@example.com,foundry_aiko_bot")

[ -n "$PUB" ]  || { echo "FAIL: public id empty"; exit 1; }
[ -n "$LEW" ]  || { echo "FAIL: lewis id empty"; exit 1; }
[ -n "$BOT" ]  || { echo "FAIL: bot id empty"; exit 1; }
[ -n "$PUBX" ] || { echo "FAIL: explicit-public id empty"; exit 1; }
[ -n "$MUL" ]  || { echo "FAIL: multi id empty"; exit 1; }

count_ids() {
  # count distinct contract ids visible in `contract list [args...]`
  "$CLI" list "$@" 2>&1 | grep -oE '^\[[a-z]+\] [a-f0-9]{8}' | awk '{print $2}' | sort -u | wc -l | tr -d ' '
}

contains() {
  # contains <id> <args-to-list> → exit 0 if id is in output
  local id="$1"; shift
  "$CLI" list "$@" 2>&1 | grep -q "$id"
}

# Plain list — every contract (5 rows).
ALL=$(count_ids)
[ "$ALL" = "5" ] || { echo "FAIL: plain list count=$ALL, expected 5"; exit 1; }

# --for lewis@example.com — sees public, lewis-only, explicit-public, multi (4); NOT bot-only.
contains "$PUB"  --for "lewis@example.com" || { echo "FAIL: lewis can't see public"; exit 1; }
contains "$LEW"  --for "lewis@example.com" || { echo "FAIL: lewis can't see lewis-only"; exit 1; }
contains "$PUBX" --for "lewis@example.com" || { echo "FAIL: lewis can't see explicit-public"; exit 1; }
contains "$MUL"  --for "lewis@example.com" || { echo "FAIL: lewis can't see multi"; exit 1; }
if contains "$BOT" --for "lewis@example.com"; then
  echo "FAIL: lewis CAN see bot-only (leak!)"; exit 1
fi

# --for foundry_aiko_bot — sees public, bot-only, explicit-public, multi; NOT lewis-only.
contains "$PUB"  --for "foundry_aiko_bot" || { echo "FAIL: bot can't see public"; exit 1; }
contains "$BOT"  --for "foundry_aiko_bot" || { echo "FAIL: bot can't see bot-only"; exit 1; }
contains "$PUBX" --for "foundry_aiko_bot" || { echo "FAIL: bot can't see explicit-public"; exit 1; }
contains "$MUL"  --for "foundry_aiko_bot" || { echo "FAIL: bot can't see multi"; exit 1; }
if contains "$LEW" --for "foundry_aiko_bot"; then
  echo "FAIL: bot CAN see lewis-only (leak!)"; exit 1
fi

# --for unknown-stranger — sees only public + explicit-public (2 rows total).
STR=$(count_ids --for "unknown-stranger")
[ "$STR" = "2" ] || { echo "FAIL: stranger sees $STR rows, expected 2 (public + explicit-public)"; exit 1; }
contains "$PUB"  --for "unknown-stranger" || { echo "FAIL: stranger can't see public"; exit 1; }
contains "$PUBX" --for "unknown-stranger" || { echo "FAIL: stranger can't see explicit-public"; exit 1; }

# Empty --for value behaves like no filter (Σ2 is opt-in).
EMPTY=$(count_ids --for "")
[ "$EMPTY" = "5" ] || { echo "FAIL: empty --for behaves as a filter ($EMPTY), expected 5 (no filter)"; exit 1; }

echo "PASS: audience gate (Σ2) — public default, lewis-only, bot-only, explicit-public, multi, empty-viewer all correct"
