#!/usr/bin/env bash
# check-origin-citations — every contract id cited in SKILL.md exists in the
# GLOBAL ledger as a declared row. A citation that doesn't resolve is a
# fake-witness violation of default #11.
set -uo pipefail
DOC=~/.claude/skills/contract/SKILL.md
GLOBAL=~/.contracts/contracts.jsonl
[ -f "$DOC" ] || { echo "missing $DOC"; exit 2; }
[ -f "$GLOBAL" ] || { echo "missing $GLOBAL"; exit 2; }

# Extract 8-hex ids cited in contract-shaped contexts. Be tight to avoid
# matching colour codes / git short-shas / unrelated 8-hex strings:
#   ` `<hex>` `, `Contract <hex>`, `contract <hex>`, `contract:<hex>`
IDS=$(python3 - "$DOC" <<'PY'
import re, sys
doc = open(sys.argv[1]).read()
# Tight patterns where the hex is unambiguously a contract id
patterns = [
    r'[Cc]ontract\s+`?([0-9a-f]{8})`?',
    r'`([0-9a-f]{8})`\s*\|',          # in a table cell with trailing |
    r'contract:([0-9a-f]{8})',
    r'origin[: ]+\s*[Cc]ontract\s+`?([0-9a-f]{8})`?',
]
ids = set()
for p in patterns:
    for m in re.finditer(p, doc):
        ids.add(m.group(1))
for i in sorted(ids):
    print(i)
PY
)

[ -z "$IDS" ] && { echo "no citations found (suspicious — SKILL.md should cite contracts)"; exit 1; }

fail=0; total=0
for id in $IDS; do
  total=$((total + 1))
  if grep -q "\"event\": \"declared\", \"id\": \"$id\"" "$GLOBAL"; then
    : # ok, silent
  else
    echo "  MISS $id — cited in SKILL.md, not in global ledger"
    fail=$((fail + 1))
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "OK $total cited contract ids all resolve in global ledger"
  exit 0
fi
echo "FAIL: $fail of $total citations don't resolve"
exit 1
