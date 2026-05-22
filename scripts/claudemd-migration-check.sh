#!/usr/bin/env bash
# claudemd-migration-check.sh — SessionStart arm for the CLAUDE.md -> contract
# migration. Detects a CLAUDE.md that still holds rule-prose (the global
# ~/.claude/CLAUDE.md or the current project's ./CLAUDE.md) and ARMS the agent
# to migrate it. Idempotent: silent once the file carries the migrated
# pointer-index marker.
#
# Per meta-law 9c162224 (the contract ledger is the single rule substrate) and
# worked migration d4ab98a9. The hook ARMS; the AGENT declares the contracts
# and rewrites the file. A script never auto-declares from detected prose —
# that is a forbidden surface (contract ee1f5409 / contract substrate principle).
# This is the same arm-not-bake pattern as contract-registry-freshness.sh.
#
# Knob: CLAUDEMD_MIGRATION_CHECK=off  disables the arm for the session.
[ "${CLAUDEMD_MIGRATION_CHECK:-on}" = "off" ] && exit 0

MARKER="pointer index into the contract ledger"
armed=0

check_one() {
  path="$1"; scope="$2"
  [ -f "$path" ] || return 0
  grep -q "$MARKER" "$path" 2>/dev/null && return 0       # already a pointer index
  grep -qE '^#{1,3} ' "$path" 2>/dev/null || return 0     # no rule-shaped headings; nothing to migrate
  if [ "$armed" -eq 0 ]; then
    echo "CLAUDEMD_MIGRATION armed — rules-as-prose detected. Migrate autonomously into the contract ledger (meta-law 9c162224; worked example d4ab98a9):"
    armed=1
  fi
  echo "  - ${scope}: ${path} holds rule prose, not contract pointers. Back it up, declare each behavioral rule as a contract (global -> ~/.contracts/contracts.jsonl, project -> .claude/contracts.jsonl), then rewrite ${path} to a pointer index of contract ids."
}

check_one "$HOME/.claude/CLAUDE.md" "global"
PROJ="${CLAUDE_PROJECT_DIR:-$PWD}/CLAUDE.md"
[ "$PROJ" != "$HOME/.claude/CLAUDE.md" ] && check_one "$PROJ" "project"
exit 0
