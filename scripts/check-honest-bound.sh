#!/usr/bin/env bash
# check-honest-bound.sh — guard: 'contract honest' never drifts from its
# own --help. Every dimension named in --help MUST appear as a section
# header in the live report. If --help claims a dimension the report
# doesn't surface, the substrate is lying about its own metacognition.
#
# This is the recursion catcher: metacognition gating metacognition.
set -uo pipefail
CLI="$HOME/.claude/skills/contract/scripts/contract"

help_out=$(bash "$CLI" honest --help 2>&1)
report_out=$(bash "$CLI" honest 2>&1)

# Required dimensions named in --help (as section labels)
declare -a required=(
  "self/\*"
  "audits/"
  "digest chain"
  "standing-gate"
  "verbs"
)

missing=()
for dim in "${required[@]}"; do
  if ! echo "$help_out" | grep -qE "$dim"; then
    missing+=("--help missing: $dim")
  fi
  if ! echo "$report_out" | grep -qE "$dim"; then
    missing+=("report missing: $dim")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "FAIL: contract honest drift detected" >&2
  for m in "${missing[@]}"; do
    echo "  $m" >&2
  done
  exit 1
fi

echo "honest-bound clean: --help and report agree on all 5 dimensions"
exit 0
