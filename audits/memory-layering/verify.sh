#!/usr/bin/env bash
# verify.sh — check every memory file in scope.txt's corpora against the
# three-layer doc-org rule. Exits 0 on full corpus compliance, 1 on any
# violation. Pure-read; never mutates.
set -uo pipefail

AUDIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCOPE_FILE="$AUDIT_DIR/scope.txt"
CHECKER="$HOME/.claude/skills/contract/scripts/check-memory-layering.py"

[ -f "$SCOPE_FILE" ] || { echo "missing scope.txt at $SCOPE_FILE" >&2; exit 2; }
[ -f "$CHECKER" ] || { echo "missing checker at $CHECKER" >&2; exit 2; }

# Expand scope: each non-comment line is a glob; resolve ~; expand *
mapfile -t globs < <(grep -vE '^\s*(#|$)' "$SCOPE_FILE")
dirs=()
for g in "${globs[@]}"; do
  # shellcheck disable=SC2086
  for d in $(eval echo "$g"); do
    [ -d "$d" ] && dirs+=("$d")
  done
done

if [ "${#dirs[@]}" -eq 0 ]; then
  echo "verify: no memory dirs match scope.txt — vacuously OK"
  exit 0
fi

total_violations=0
total_files=0
for d in "${dirs[@]}"; do
  # Count files for the per-dir reporting line
  n=$(find "$d" -maxdepth 1 -name '*.md' ! -name 'MEMORY.md' 2>/dev/null | wc -l | tr -d ' ')
  total_files=$((total_files + n))
  if [ "$n" -eq 0 ]; then
    printf "  -- %-3s files  %s\n" "$n" "$d"
    continue
  fi
  out=$(/usr/bin/python3 "$CHECKER" "$d" 2>&1)
  bad=$(printf '%s\n' "$out" | grep -c '^FAIL' || true)
  total_violations=$((total_violations + bad))
  status="OK"
  [ "$bad" -gt 0 ] && status="FAIL($bad)"
  printf "  %-9s  %-3s files  %s\n" "$status" "$n" "$d"
  if [ "$bad" -gt 0 ]; then
    printf '%s\n' "$out" | grep '^FAIL' | head -5 | sed 's/^/      /'
    extra=$((bad - 5))
    [ "$extra" -gt 0 ] && echo "      ... ($extra more)"
  fi
done

echo
echo "verify: $total_violations violation(s) across $total_files file(s) in ${#dirs[@]} corpus dir(s)"
[ "$total_violations" -eq 0 ] && exit 0
exit 1
