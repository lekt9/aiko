#!/usr/bin/env bash
# audits/references-purge/verify.sh — exits 0 iff references/ holds only allowlisted files.
set -u
REFDIR="$HOME/.claude/skills/contract/references"
ALLOWED='^(REGISTRY|README)\.md$'
if [ ! -d "$REFDIR" ]; then
  exit 0  # absent = trivially clean
fi
fail=0
for f in "$REFDIR"/*; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  if [[ ! "$base" =~ $ALLOWED ]]; then
    echo "FAIL: references/ contains forbidden file: $base — Β3 doctrine requires standing-gate contract + Outline appendix, not prose .md (see references/REGISTRY.md)"
    fail=1
  fi
done
exit $fail
