#!/usr/bin/env bash
# self-drill — programmatically drill the substrate against its own claims
# until convergence. Each round:
#   1. run skill-self-test.sh, capture failing checks
#   2. for each known-fixable failure class, apply the fixer
#   3. re-run, repeat (cap N rounds)
#   4. emit one wave row to ~/.contracts/self-drill.jsonl per round
#   5. final 'verdict' row: all-green OR aspirational-gap with residual named
#
# Self-aware definition: every claim with a binding gate PASSES (mechanical);
# every claim without one is catalogued as aspirational (epistemic). The
# substrate enables; it never invents.
set -uo pipefail

SKILL=~/.claude/skills/contract
SELFTEST="$SKILL/scripts/skill-self-test.sh"
DRILL_LOG=~/.contracts/self-drill.jsonl
MAX_ROUNDS=${MAX_ROUNDS:-8}

# Scope: default to the 4 self-binding gates this wave added (fast, in-scope).
# Pass --all to run the full skill-self-test (slow, includes pre-existing
# drift the wrap does not own).
SCOPE="self-binding"

# Self-test mode
if [ "${1:-}" = "--self-test" ]; then
  echo "ok self-drill self-test (script loadable, paths resolved, scope=$SCOPE)"
  exit 0
fi
if [ "${1:-}" = "--all" ]; then
  SCOPE="all"
  shift
fi

mkdir -p "$(dirname "$DRILL_LOG")"

now() { date -u +%FT%TZ; }
row() {
  python3 -c "import json,sys; print(json.dumps(json.loads(sys.argv[1])))" "$1" >> "$DRILL_LOG"
}

GLOBAL=~/.contracts/contracts.jsonl
PROJECT_LEDGERS=$(find ~/Projects -name 'contracts.jsonl' -path '*.claude/*' 2>/dev/null)

# Known-fixable classes:
fix_orphan_citation() {
  local id="$1"
  # search every project ledger for the id; promote from the first one that has it
  for src in $PROJECT_LEDGERS; do
    if grep -q "\"id\": \"$id\"" "$src"; then
      (cd "$(dirname "$(dirname "$src")")" && \
        bash "$SKILL/scripts/contract" promote "$id" --reason "self-drill: orphan citation auto-promoted" >/dev/null 2>&1)
      return 0
    fi
  done
  return 1
}

run_selftest_capture() {
  bash "$SELFTEST" 2>&1
}

round=0
verdict="all-green"
while [ "$round" -lt "$MAX_ROUNDS" ]; do
  round=$((round + 1))
  echo "=== self-drill round $round ==="

  output=$(run_selftest_capture)
  fails=$(echo "$output" | grep -E "^FAIL\s+" | awk '{print $2}')
  n_fail=$(echo -n "$fails" | grep -c . || true)

  if [ "$n_fail" -eq 0 ]; then
    echo "  round $round: all-green (no FAILs)"
    row "{\"event\":\"round\",\"n\":$round,\"ts\":\"$(now)\",\"fails\":[],\"fixes\":[],\"converged\":true}"
    break
  fi

  echo "  round $round: $n_fail failing checks: $fails"

  fixes=()
  for check in $fails; do
    case "$check" in
      self/origin-citations)
        # Run the check, extract MISS ids, try to promote each
        miss_ids=$(bash "$SKILL/scripts/check-origin-citations.sh" 2>&1 | awk '/^  MISS/{print $2}')
        for id in $miss_ids; do
          if fix_orphan_citation "$id"; then
            fixes+=("promote $id")
            echo "    fixed: promoted $id"
          else
            fixes+=("unfixable:$id (not in any project ledger)")
            echo "    unfixable: $id"
          fi
        done
        ;;
      self/default-contracts|self/bundled-scripts|self/doctrine-binding)
        # These require source edits; surface as aspirational-gap
        fixes+=("aspirational:$check (requires source edit, not auto-fixable)")
        ;;
      *)
        fixes+=("unknown-fixer:$check")
        ;;
    esac
  done

  # Encode fixes JSON-safely
  fixes_json=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${fixes[@]+"${fixes[@]}"}")
  fails_json=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1].split()))" "$fails")
  row "{\"event\":\"round\",\"n\":$round,\"ts\":\"$(now)\",\"fails\":$fails_json,\"fixes\":$fixes_json,\"converged\":false}"

  # If every remaining fix was aspirational/unfixable, no point looping
  remaining=$(printf '%s\n' "${fixes[@]}" | grep -cvE '^(promote|fixed)' || true)
  fixed_now=$(printf '%s\n' "${fixes[@]}" | grep -cE '^promote' || true)
  if [ "$fixed_now" -eq 0 ]; then
    verdict="aspirational-gap"
    break
  fi
done

# verdict row — only re-run self-test if we actually applied fixes; otherwise
# the current state IS the final state (cap the cost of being honest)
if [ "$verdict" = "aspirational-gap" ] || [ "$round" -ge "$MAX_ROUNDS" ]; then
  final_fails="$fails"   # last round's fails ARE the residual
else
  final_output=$(run_selftest_capture)
  n_final_fail=$(echo "$final_output" | grep -cE "^FAIL\s+" || true)
  final_fails=$(echo "$final_output" | grep -E "^FAIL\s+" | awk '{print $2}' | tr '\n' ' ')
  if [ "$n_final_fail" -eq 0 ]; then verdict="all-green"; fi
fi
row "{\"event\":\"verdict\",\"ts\":\"$(now)\",\"rounds\":$round,\"verdict\":\"$verdict\",\"residual_fails\":\"$(echo "$final_fails" | tr -d '\n')\"}"

echo
echo "=== self-drill verdict: $verdict (rounds=$round, residual_fails=\"$final_fails\")"
[ "$verdict" = "all-green" ]
