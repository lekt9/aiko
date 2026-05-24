#!/bin/bash
# Γ1 verb-gate: skill code has no stub patterns + drill is fully gone
set -e
~/.claude/skills/contract/scripts/check-no-stubs.sh >/dev/null 2>&1 || { echo "FAIL: stub patterns present"; ~/.claude/skills/contract/scripts/check-no-stubs.sh; exit 1; }
# assert drill is fully removed (returns 'unknown subcommand')
OUT=$(~/.claude/skills/contract/scripts/contract drill 2>&1 | head -1)
echo "$OUT" | grep -q "unknown subcommand: drill" || { echo "FAIL: drill stub still present: $OUT"; exit 1; }
echo "PASS: Γ1 — no stubs in skill code, drill fully removed"
