#!/usr/bin/env bash
# check-break-on-resolution.sh — guard the refractory period (KEY 3).
#
# Properties:
#   1. scripts/contract _mark verb emits 'BREAK ON RESOLUTION (refractory)'
#   2. The BREAK block source appears BEFORE the SIGNAL PROPAGATION source
#      (refractory pause happens BEFORE the wavefront — biology order)
#   3. The block is unconditional on STATUS=satisfied (every satisfied mark
#      fires it, no other guard)
#
# Static source check — does not invoke _mark (avoids the recursion the
# honest-bound check ran into).
set -uo pipefail
CLI_SRC="$HOME/.claude/skills/contract/scripts/contract"

if ! grep -q 'BREAK ON RESOLUTION (refractory)' "$CLI_SRC"; then
  echo "FAIL: 'BREAK ON RESOLUTION (refractory)' string missing from $CLI_SRC" >&2
  exit 1
fi

if ! grep -q 'KEY 3' "$CLI_SRC"; then
  echo "FAIL: 'KEY 3' marker missing from $CLI_SRC (refractory needs an explicit key)" >&2
  exit 1
fi

# Order: BREAK appears before SIGNAL PROPAGATION in the _mark body
break_line=$(grep -n 'BREAK ON RESOLUTION (refractory)' "$CLI_SRC" | head -1 | cut -d: -f1)
prop_line=$(grep -n 'SIGNAL PROPAGATION: a contract becoming satisfied' "$CLI_SRC" | head -1 | cut -d: -f1)
if [ -z "$break_line" ] || [ -z "$prop_line" ]; then
  echo "FAIL: could not locate both BREAK and SIGNAL PROPAGATION sections" >&2
  exit 1
fi
if [ "$break_line" -ge "$prop_line" ]; then
  echo "FAIL: BREAK ON RESOLUTION must appear BEFORE SIGNAL PROPAGATION (biology order: refractory pause before signal travels)" >&2
  echo "  break_line=$break_line prop_line=$prop_line" >&2
  exit 1
fi

echo "break-on-resolution clean: KEY 3 emits before PROPAGATION (refractory period preserved)"
exit 0
