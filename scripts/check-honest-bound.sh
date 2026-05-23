#!/usr/bin/env bash
# check-honest-bound.sh — guard: 'contract honest' --help and the report
# rendering code agree on the same 5 dimensions. Static check on the
# scripts/contract source (no invocation) — avoids the metacognition
# recursion that would occur if honest called skill-self-test which
# called this check which called honest...
#
# The dimensions are pinned here as the load-bearing claim; both --help
# text and the report's print() calls must reference them.
set -uo pipefail
CLI_SRC="$HOME/.claude/skills/contract/scripts/contract"

# Extract the honest verb's body (from 'honest)' to the next '  ;;')
verb_body=$(awk '/^  honest\)/,/^    ;;$/' "$CLI_SRC")
if [ -z "$verb_body" ]; then
  echo "FAIL: 'contract honest' verb not found in $CLI_SRC" >&2
  exit 1
fi

declare -a required=(
  "self/\*"        # (a) self/* checks
  "audits/"        # (b) audits/*/verify.sh
  "digest chain"   # (c) digest chain
  "standing-gate"  # (d) standing-gate ids
  "verbs"          # (e) CLI verbs
)

missing=()
for dim in "${required[@]}"; do
  if ! echo "$verb_body" | grep -qE "$dim"; then
    missing+=("source missing: $dim")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "FAIL: contract honest drift — --help and report code disagree" >&2
  for m in "${missing[@]}"; do
    echo "  $m" >&2
  done
  exit 1
fi

echo "honest-bound clean: --help and report code agree on all 5 dimensions"
exit 0
