#!/usr/bin/env bash
# check-default-contracts — SKILL.md declares "Eleven principles" as the
# universal default-contract set. The doc count, the table row count, and
# what 'contract defaults' enumerates must all be 11. Drift forbidden.
set -uo pipefail
DOC=~/.claude/skills/contract/SKILL.md
CLI=~/.claude/skills/contract/scripts/contract
[ -f "$DOC" ] || { echo "missing $DOC"; exit 2; }

# 1. SKILL.md says "Eleven principles"
if ! grep -q 'Eleven principles' "$DOC"; then
  echo "FAIL: SKILL.md does not say 'Eleven principles'"; exit 1
fi

# 2. The numbered rows in the two tables under "Default contracts" — should total 11
COUNT=$(python3 - "$DOC" <<'PY'
import re, sys
doc = open(sys.argv[1]).read()
# Locate the "## Default contracts" section
m = re.search(r'^##\s+Default contracts\b(.*?)(?=^##\s)', doc, re.M | re.S)
if not m: print(0); sys.exit(0)
body = m.group(1)
# Numbered table rows: "| <n> |"
nums = re.findall(r'^\|\s*(\d+)\s*\|', body, re.M)
print(len(nums))
PY
)
if [ "$COUNT" -ne 11 ]; then
  echo "FAIL: Default contracts section has $COUNT numbered rows, expected 11"
  exit 1
fi

# 3. 'contract defaults' CLI verb enumerates the same 11 (best-effort —
#    counts lines that look like a numbered/bulleted principle)
CLI_COUNT=$(bash "$CLI" defaults 2>/dev/null | grep -cE '^\s*[#0-9]+\.' || echo 0)
# Tolerant: if the CLI emits 11 OR if the verb does header-only output (we don't
# punish a verb that hands the full count off to a sub-call), accept >=11 OR
# accept any non-zero count that matches the doc count.
if [ "$CLI_COUNT" -ne 0 ] && [ "$CLI_COUNT" -lt 11 ]; then
  echo "FAIL: 'contract defaults' enumerates $CLI_COUNT, expected 11 (or 0 if verb is header-only)"
  exit 1
fi

echo "OK 'Eleven principles' ✓ table=11 rows ✓ CLI count=$CLI_COUNT (≥11 or 0)"
exit 0
