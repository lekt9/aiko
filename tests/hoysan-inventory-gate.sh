#!/usr/bin/env bash
set -euo pipefail
f="docs/graph-engineering/HOYSAN-BREAKPOINT-INVENTORY.md"
test -s "$f"
grep -q 'breakpoint' "$f"
grep -q '5-consecutive' "$f"
grep -q 'PSA' "$f"
grep -q 'hoysan-draft' "$f"
test -s PRODUCT_BRIEF.md
echo "hoysan-inventory: PASS"
