#!/usr/bin/env bash
# claudemd-migration-check.sh — agent-run helper (NOT a hook).
#
# Lists instruction files (CLAUDE.md / AGENTS.md and equivalents, global +
# current project) that still hold behavioral rules as prose instead of
# contract pointers. The agent runs this when its instruction file's
# ACTIVATION block tells it to invoke /contract — a file pointer, not a
# framework hook, so it works for any agent (Claude, Codex, Cursor, ...).
#
# It only SURFACES candidates. The agent declares the contracts and rewrites
# the files; a script never auto-declares from detected prose (forbidden
# surface — contract ee1f5409). Per meta-law 9c162224; worked example d4ab98a9.
#
# Knob: CLAUDEMD_MIGRATION_CHECK=off  silences it.
[ "${CLAUDEMD_MIGRATION_CHECK:-on}" = "off" ] && exit 0

# A file is already a pointer (no migration needed) if it references the
# contract ledger / carries the migrated pointer-index marker.
is_pointerized() {
  # Require the STRUCTURAL marker — the heading that names the file as a
  # pointer-index, not an incidental string match. Old check tripped on any
  # mention of contracts.jsonl (e.g. a reference section happening to cite
  # the file path); contract a499b1f3 stage C tightened this so a 1023-line
  # prose-rule CLAUDE.md that merely names the ledger file is correctly
  # flagged as still-needing-migration.
  grep -qE '^#{1,3} Operating rules — pointer index into the contract ledger|ACTIVATION: invoke /contract' "$1" 2>/dev/null
}

armed=0
check_one() {
  path="$1"; scope="$2"
  [ -f "$path" ] || return 0
  grep -qE '^#{1,3} ' "$path" 2>/dev/null || return 0     # no rule-shaped headings
  is_pointerized "$path" && return 0                       # already points at the ledger
  if [ "$armed" -eq 0 ]; then
    echo "CLAUDEMD_MIGRATION — instruction files still holding rule prose. Migrate into the contract ledger (meta-law 9c162224; worked example d4ab98a9):"
    armed=1
  fi
  echo "  - ${scope}: ${path} — declare each behavioral rule as a contract (global -> ~/.contracts/contracts.jsonl, project -> .claude/contracts.jsonl), then rewrite ${path} to pointers. Back up first."
}

check_one "$HOME/.claude/CLAUDE.md"  "global (claude)"
check_one "$HOME/.codex/AGENTS.md"   "global (codex)"
check_one "$HOME/AGENTS.md"          "global (home)"
PD="${CLAUDE_PROJECT_DIR:-$PWD}"
[ "$PD" != "$HOME" ] && [ "$PD" != "$HOME/.claude" ] && {
  check_one "$PD/CLAUDE.md" "project"
  check_one "$PD/AGENTS.md" "project"
}
exit 0
