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
m = re.search(r'^##\s+Bundled scripts\b(.*?)(?=^##\s|\Z)', doc, re.M | re.S)
if not m:
    sys.exit(0)
body = m.group(1)
# Extract paths from `backticked` markers
paths = re.findall(r'`([^`\s]+)`', body)
# Keep filesystem-shaped entries (contain '/' or end with .py/.sh/.jsonl etc.)
ok = []
for p in paths:
    if '/' in p or p.endswith(('.py', '.sh', '.jsonl', '.md')):
        ok.append(p)
seen = set()
for p in ok:
    if p in seen: continue
    seen.add(p)
    print(p)
PY
)

[ -z "$PATHS" ] && { echo "no bundled-script paths found in SKILL.md"; exit 1; }

fail=0; total=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  total=$((total + 1))
  # Resolve ~ → $HOME if present
  abs="$p"
  case "$p" in
    "~/"*) abs="$HOME/${p#~/}" ;;
    "scripts/"*|"audits/"*|"verb-gates/"*|"<shape>-gate/"*|"references/"*) abs="$SKILL/$p" ;;
  esac
  # Glob patterns (contain *, <)  → just check the parent directory exists
  case "$abs" in
    *'*'*|*'<'*)
      parent="${abs%/*}"
      if [ -d "$parent" ]; then
        : # parent ok
      else
        echo "  MISS $p (parent $parent missing)"
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
