#!/usr/bin/env bash
# Fail-closed witness for the Telegram self-wire bug.
# Green only when the lying placeholder is gone, lineage is gated,
# ACP errors expose data, the exclusive-poller rule exists, and
# the daemon crate tests pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOT="$ROOT/aiko/crates/codegen/xai-telegram-daemon/src/bot.rs"
MAIL="$ROOT/aiko/crates/codegen/xai-telegram-daemon/src/agent_mail.rs"
API="$ROOT/aiko/crates/codegen/xai-telegram-daemon/src/api.rs"
SKILL="$ROOT/aiko/.agents/skills/self-integrate/SKILL.md"

die() { echo "FAIL: $*" >&2; exit 1; }

test -s "$BOT" && test -s "$MAIL" && test -s "$API" && test -s "$SKILL" \
  || die "expected daemon / skill files missing"

if grep -F -q "I'm handling it now and will reply momentarily" "$BOT"; then
  die "lying 'reply momentarily' fallback still in bot.rs"
fi
if grep -F -q "Got it — received your message" "$BOT"; then
  die "placeholder 'Got it — received your message' still in bot.rs"
fi

grep -q 'fn valid_contract_id' "$BOT" || die "bot.rs must gate lineage with valid_contract_id"
grep -q 'fn format_acp_error' "$MAIL" || die "agent_mail.rs must extract error.data via format_acp_error"
grep -q 'error.get("data")' "$MAIL" || die "agent_mail.rs must read error.data"
grep -qiE 'exclusive poller|owns the slot' "$SKILL" \
  || die "self-integrate must refuse a second getUpdates holder"
grep -qiE 'do not (curl getUpdates|start a second)|Do NOT (curl getUpdates|start)' "$SKILL" \
  || die "self-integrate must say not to curl getUpdates / start a second host"
grep -q 'Conflict' "$API" || die "api.rs must handle getUpdates Conflict"
grep -q 'sleep' "$API" || die "api.rs must back off on 409 instead of tight-looping"

if command -v cargo >/dev/null 2>&1; then
  (cd "$ROOT/aiko" && cargo test -p xai-telegram-daemon --offline -- --test-threads=1)
else
  die "cargo not on PATH"
fi

echo "PASS telegram-wire witness"
