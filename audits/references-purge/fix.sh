#!/usr/bin/env bash
# audits/references-purge/fix.sh — surfaces violations; never auto-deletes (the .md may carry
# unmigrated doctrine; the agent decides the disposition: standing-gate-promote + Outline-append + delete).
set -u
REFDIR="$HOME/.claude/skills/contract/references"
ALLOWED='^(REGISTRY|README)\.md$'
[ -d "$REFDIR" ] || exit 0
violations=()
for f in "$REFDIR"/*; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  if [[ ! "$base" =~ $ALLOWED ]]; then
    violations+=("$base")
  fi
done
if [ ${#violations[@]} -eq 0 ]; then
  echo "audits/references-purge: clean ($REFDIR holds only allowlisted files)"
  exit 0
fi
echo "audits/references-purge: ${#violations[@]} violation(s) — disposition required per file:"
for v in "${violations[@]}"; do
  echo "  - $v"
  echo "    1. ensure doctrine has a standing-gate contract in global ledger (search/promote)"
  echo "    2. append narrative to Outline router doc 502200ae as appendix"
  echo "    3. update references/REGISTRY.md with the standing-gate id"
  echo "    4. rm references/$v"
done
echo "(fix.sh refuses to auto-delete; the agent supplies the migration disposition)"
exit 1
