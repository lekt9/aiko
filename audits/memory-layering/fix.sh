#!/usr/bin/env bash
# fix.sh — bring every memory file in scope.txt's corpora into compliance
# with the three-layer doc-org rule. Idempotent: a green corpus stays
# untouched. Never edits body content; only frontmatter description and
# the MEMORY.md link line.
set -uo pipefail

AUDIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCOPE_FILE="$AUDIT_DIR/scope.txt"
FIXER="$HOME/.claude/skills/contract/scripts/backfill-memory-layering.py"

[ -f "$SCOPE_FILE" ] || { echo "missing scope.txt at $SCOPE_FILE" >&2; exit 2; }
[ -f "$FIXER" ] || { echo "missing fixer at $FIXER" >&2; exit 2; }

dirs=()
while IFS= read -r g; do
  [ -n "$g" ] || continue
  case "$g" in \#*) continue;; esac
  # shellcheck disable=SC2086
  for d in $(eval echo "$g"); do
    [ -d "$d" ] && dirs+=("$d")
  done
done < "$SCOPE_FILE"

dry="${1:-}"
flag=""
[ "$dry" = "--dry-run" ] && flag="--dry-run"

total_fixed=0
for d in "${dirs[@]}"; do
  out=$(/usr/bin/python3 "$FIXER" "$d" $flag 2>&1)
  fixed=$(printf '%s\n' "$out" | grep -c '^FIX ' || true)
  total_fixed=$((total_fixed + fixed))
  if [ "$fixed" -gt 0 ]; then
    printf "  fixed %-3s  %s\n" "$fixed" "$d"
    printf '%s\n' "$out" | grep '^FIX ' | head -3 | sed 's/^/      /'
    extra=$((fixed - 3))
    [ "$extra" -gt 0 ] && echo "      ... ($extra more fixes)"
  fi
done

echo
echo "fix: $total_fixed file(s) fixed across ${#dirs[@]} corpus dir(s)"
