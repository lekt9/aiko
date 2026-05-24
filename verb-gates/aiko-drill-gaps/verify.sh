#!/bin/bash
# aiko drill-gaps gate: --dry-run lists candidates without spawning;
# live run creates aiko_cell rows with parent_id = gap_id; idempotent.
set -e
AIKO=~/.claude/skills/aiko/scripts/aiko
OUT=$($AIKO drill-gaps --dry-run --max 3 2>&1)
echo "$OUT" | grep -q "AIKO DRILL-GAPS" || { echo "FAIL: header"; exit 1; }
echo "$OUT" | grep -q "open gaps:" || { echo "FAIL: gap count"; exit 1; }
# the --only filter narrows scope (skipped/zero allowed when no match)
OUT2=$($AIKO drill-gaps --dry-run --max 1 --only "ZZZZ-NOMATCH" 2>&1)
echo "$OUT2" | grep -q "drilling:   0" || { echo "FAIL: --only filter not respected"; exit 1; }
echo "PASS: aiko drill-gaps lists candidates, respects --only filter"
