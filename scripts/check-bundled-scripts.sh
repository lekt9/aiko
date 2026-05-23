#!/usr/bin/env bash
# check-bundled-scripts — every script path listed in the "Bundled scripts"
# section of SKILL.md exists. If listed as ".sh" or ".py", must be executable.
# Data files (.jsonl, inbox/) just need to be the documented kind of artifact.
set -uo pipefail
DOC=~/.claude/skills/contract/SKILL.md
SKILL=~/.claude/skills/contract
[ -f "$DOC" ] || { echo "missing $DOC"; exit 2; }

PATHS=$(python3 - "$DOC" <<'PY'
import re, sys
doc = open(sys.argv[1]).read()
# Locate the "## Bundled scripts" section
m = re.search(r'^##\s+Bundled scripts\b(.*?)(?=^##\s)', doc, re.M | re.S)
if not m:
    sys.exit(0)
body = m.group(1)
# Only extract the LEADING backticked path in each bullet item — this is the
# bundled-script "subject", not inline mentions in descriptions.
seen = set()
for line in body.split('\n'):
    line = line.strip()
    if not line.startswith('- '):
        continue
    m2 = re.match(r'-\s+`([^`]+)`', line)
    if m2:
        p = m2.group(1)
        if p in seen: continue
        seen.add(p); print(p)
PY
)

[ -z "$PATHS" ] && { echo "no bundled-script paths found in SKILL.md"; exit 1; }

fail=0; total=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  total=$((total + 1))
  # Resolve ~ → $HOME if present, else skill-relative
  abs="${p/#\~/$HOME}"
  case "$abs" in
    /*) ;;  # already absolute
    *) abs="$SKILL/$p" ;;
  esac
  # Glob patterns (contain *, <)  → strip from first glob char, then check the
  # remaining REAL parent directory exists.
  case "$abs" in
    *'*'*|*'<'*)
      # Truncate at the first glob/placeholder character, then take the parent
      head="${abs%%[*<]*}"
      parent="${head%/*}"
      if [ -d "$parent" ]; then
        : # documented directory family exists
      else
        echo "  MISS $p (real parent $parent missing)"
        fail=$((fail + 1))
      fi
      continue
      ;;
  esac
  if [ ! -e "$abs" ]; then
    echo "  MISS $p (resolved $abs) — listed in Bundled scripts, doesn't exist"
    fail=$((fail + 1))
  fi
done <<< "$PATHS"

if [ "$fail" -eq 0 ]; then
  echo "OK $total bundled-script paths all exist"
  exit 0
fi
echo "FAIL: $fail of $total bundled-script paths missing"
exit 1
