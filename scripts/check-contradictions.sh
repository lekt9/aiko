#!/usr/bin/env bash
# check-contradictions — scan SKILL.md for known drift classes that the
# substrate considers contradictions (the skill saying X while the code
# says Y, or the doc disagreeing with itself).
#
# Drift classes:
#   A) duplicate consecutive `## <header>` (same heading line twice)
#   B) stale CLI verb count — '38+' / '43 verbs' / 'verbs (N)' must match
#      `contract self`'s live count
#   C) L1 architecture verb list out-of-sync — listing only ~9 verbs as
#      "the verb surface" when 40+ exist is a lie of omission
#   D) dangling reference: backticked tokens like `bind_to` cited but never
#      defined anywhere in the doc
#
# Pure-read; surfaces line numbers. Substrate enables — fixing is the
# agent's job. Origin: contract 599c43a3, 2026-05-23.
set -uo pipefail
DOC=~/.claude/skills/contract/SKILL.md
CLI=~/.claude/skills/contract/scripts/contract
[ -f "$DOC" ] || { echo "missing $DOC"; exit 2; }
[ -x "$CLI" ] || { echo "missing $CLI"; exit 2; }

fail=0
report() { echo "  CONTRADICTION: $*"; fail=$((fail + 1)); }

# A. duplicate consecutive ## headers
out=$(python3 - "$DOC" <<'PY'
import re, sys
doc = open(sys.argv[1]).read().split('\n')
prev_h2 = None
prev_line = 0
n = 0
for i, line in enumerate(doc, 1):
    m = re.match(r'^##\s+(.+?)\s*$', line)
    if m:
        h = m.group(1)
        if prev_h2 == h:
            print(f"  CONTRADICTION: duplicate ## header '{h}' at lines {prev_line} and {i}")
            n += 1
        prev_h2 = h
        prev_line = i
sys.exit(n)
PY
)
[ -n "$out" ] && echo "$out"
n=$?; fail=$((fail + n))

# B. CLI verb count
live_count=$(bash "$CLI" self 2>/dev/null | grep -oE 'verbs \(([0-9]+)\)' | grep -oE '[0-9]+' | head -1)
[ -z "$live_count" ] && live_count=0

out=$(python3 - "$DOC" "$live_count" <<'PY'
import re, sys
doc = open(sys.argv[1]).read()
live = int(sys.argv[2])
n = 0
for m in re.finditer(r'verb list \((\d+)\+?\)', doc):
    cited = int(m.group(1))
    line = doc[:m.start()].count('\n') + 1
    if cited > live or live - cited > 5:
        print(f"  CONTRADICTION: stale verb count — line {line}: cites {cited}+ verbs, live is {live}")
        n += 1
for m in re.finditer(r'the (\d+) (?:surface )?verbs', doc):
    cited = int(m.group(1))
    line = doc[:m.start()].count('\n') + 1
    if cited != live:
        print(f"  CONTRADICTION: stale verb count — line {line}: cites {cited} surface verbs, live is {live}")
        n += 1
sys.exit(n)
PY
)
[ -n "$out" ] && echo "$out"
n=$?; fail=$((fail + n))

# C. L1 architecture verb list (subset masquerading as complete)
l1_line=$(grep -nE '\*\*L1 .*CLI\*\*.*verb surface' "$DOC" | head -1 | cut -d: -f1)
if [ -n "$l1_line" ]; then
  l1_text=$(sed -n "${l1_line}p" "$DOC")
  n_verbs=$(echo "$l1_text" | grep -oE '`[a-z_]+`' | wc -l | tr -d ' ')
  if [ "$n_verbs" -gt 0 ] && [ "$n_verbs" -lt 20 ] && ! echo "$l1_text" | grep -q "contract self"; then
    report "line $l1_line: L1 bullet enumerates $n_verbs verbs but $live_count exist — should reference 'contract self' not stale subset"
  fi
fi

# D. dangling references
if grep -q 'bind_to' "$DOC"; then
  if ! grep -qE '^##.*bind_to|`bind_to` is|`bind_to` field|`bind_to` —|`bind_to` carries' "$DOC"; then
    line=$(grep -n 'bind_to' "$DOC" | head -1 | cut -d: -f1)
    report "line $line: \`bind_to\` cited but never defined (dangling)"
  fi
fi

if [ "$fail" -eq 0 ]; then
  echo "OK SKILL.md clean of known contradictions (live verb count = $live_count)"
  exit 0
fi
echo "FAIL: $fail contradiction(s)"
exit 1
