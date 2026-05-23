#!/usr/bin/env bash
# check-doctrine-binding — every Greek-coded doctrine in SKILL.md (Ψ/Ε/Σ/Α)
# is at minimum DECLARED in the doc. Those that have runtime callsites are
# bound; those that don't are NAMED as aspirational so the agent knows.
# Substrate enables; honest data > pretend-bound.
set -uo pipefail
DOC=~/.claude/skills/contract/SKILL.md
CLI=~/.claude/skills/contract/scripts/contract
[ -f "$DOC" ] || { echo "missing $DOC"; exit 2; }
[ -f "$CLI" ] || { echo "missing $CLI"; exit 2; }

declared=0; bound=0; aspirational=()
check() {
  local code="$1" cli_pat="$2" what="$3"
  if ! grep -qE "${code}" "$DOC"; then
    echo "  MISS $code — not declared in SKILL.md ($what)"; return 1
  fi
  declared=$((declared+1))
  if grep -qE -- "$cli_pat" "$CLI"; then
    bound=$((bound+1))
  else
    aspirational+=("$code — $what")
  fi
}

check 'Ψ1'  'verbose|--verbose'                  'Layer purity → --verbose flag'
check 'Ψ2'  'When to invoke'                     'Working-memory cap → front-door table'
check 'Ψ3'  '--auditors|contract audit'          'Confirmation-bias → audit verb'
check 'Ε1'  'streak'                             'Failure-streak escalation'
check 'Ε2'  'consecutive PASS|over-iteration'    'Over-iteration warning'
check 'Σ1'  'CONTRACT_AGENT'                     'Agent attribution'
check 'Α1'  'plan.*length|generic|< 24'          'Plan-quality surfacing'

[ "$declared" -eq 7 ] || { echo "FAIL: only $declared/7 doctrines declared in SKILL.md"; exit 1; }

# Bound floor: at least 3/7 must be runtime-bound (otherwise the substrate
# is mostly aspiration, which is the prose-only failure mode this gate exists
# to prevent).
if [ "$bound" -lt 3 ]; then
  echo "FAIL: only $bound/7 doctrines runtime-bound (floor=3) — substrate too aspirational"
  exit 1
fi

echo "OK 7/7 doctrines declared; $bound/7 runtime-bound"
if [ "${#aspirational[@]}" -gt 0 ]; then
  echo "  honest gap (aspirational, follow-on binding needed):"
  for a in "${aspirational[@]}"; do echo "    · $a"; done
fi
exit 0
