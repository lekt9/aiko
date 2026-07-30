#!/usr/bin/env bash
# Mechanical completeness/falsifier gate for CONTRACT-INTERFACE-HOLES-PLAN.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="${INTERFACE_HOLES_PLAN:-$ROOT/docs/CONTRACT-INTERFACE-HOLES-PLAN.md}"
FAIL=0
PASS=0

pass() { printf 'PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }
need() {
  local label="$1" pattern="$2"
  if rg -q "$pattern" "$DOC"; then pass "$label"; else fail "$label"; fi
}

[[ -f "$DOC" ]] || { printf 'FAIL  missing plan: %s\n' "$DOC"; exit 1; }

need "control plane boundary" 'Contract is the control plane'
need "complete port algebra" 'observe → normalize → authorize → prepare → execute → sense → evaluate → settle'
need "event envelope" '^### 2\.1 Interface event'
need "effect envelope" '^### 2\.2 Interface effect'
need "closed response union" 'typing.*callback_answer.*custom'
need "typing lease and coalescing" 'typing lease, TTL/coalescing'
need "typing cannot satisfy parent" 'never parent success'
need "media bytes excluded" 'media bytes never'
need "Telegram typing" 'sendChatAction'
need "Telegram voice" 'sendVoice'
need "Telegram replies" 'preserves `reply_to`'
need "Telegram callbacks" 'Callback query is acknowledged'
need "Telegram idempotency" 'idempotency prevents double send'
need "eight Telegram scenarios" '^8\. Provider acknowledgement'
need "iOS App Intent" 'App Intent enters once'
need "iOS background expiry" 'Background task expiry'
need "iOS permissions" 'Denied microphone permission'
need "iOS MainActor" 'MainActor'
need "eight iOS scenarios" '^8\. Foreground progress/typing'
need "agent live rule" 'The agent must receive a compact live rule'
need "unsupported capability HOLD" 'unsupported provider capability HOLDs'
need "third adapter falsifier" 'zero provider-specific branches added to Contract core'
need "positive and negative fixtures" 'positive/negative fixtures'
need "privacy falsifiers" 'Privacy tests proving tokens'
need "no fake execution" 'model does not execute effects by emitting JSON alone'

printf '\n=== summary: %d pass, %d fail ===\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1

# Negative witness: a plan without the universal algebra must not pass.
MUTATION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/interface-holes-plan.XXXXXX")"
trap 'rm -rf "$MUTATION_DIR"' EXIT
MUTANT="$MUTATION_DIR/plan.md"
sed '/observe → normalize → authorize → prepare → execute → sense → evaluate → settle/d' \
  "$DOC" >"$MUTANT"
if INTERFACE_HOLES_PLAN="$MUTANT" "$0" >"$MUTATION_DIR/output" 2>&1; then
  printf 'FAIL  mutation without port algebra passed\n'
  exit 1
fi
if ! rg -q 'FAIL  complete port algebra' "$MUTATION_DIR/output"; then
  printf 'FAIL  mutation failed for unrelated reason\n'
  cat "$MUTATION_DIR/output"
  exit 1
fi
printf 'PASS  mutation without port algebra rejected\n'
printf 'ALL PASS — interface-hole plan is complete and falsifiable\n'
