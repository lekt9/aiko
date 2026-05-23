#!/usr/bin/env bash
# check-doctrine-binding — every Greek-coded doctrine in SKILL.md (Ψ/Ε/Σ/Α)
# is documented AND has a corresponding runtime callsite that surfaces it.
# Substrate enables; the gate proves the doctrine isn't aspirational.
set -uo pipefail
DOC=~/.claude/skills/contract/SKILL.md
CLI=~/.claude/skills/contract/scripts/contract
[ -f "$DOC" ] || { echo "missing $DOC"; exit 2; }
[ -f "$CLI" ] || { echo "missing $CLI"; exit 2; }

fail=0
check() {
  local code="$1" doc_pat="$2" cli_pat="$3" what="$4"
  if ! grep -qE "$doc_pat" "$DOC"; then
    echo "  MISS $code — not declared in SKILL.md ($what)"; fail=$((fail+1)); return
  fi
  if ! grep -qE "$cli_pat" "$CLI"; then
    echo "  MISS $code — declared in SKILL.md but no runtime callsite ($what)"; fail=$((fail+1)); return
  fi
}

#   doctrine_code  doc-regex                cli-regex                            description
check 'Ψ1'  'Ψ1'                         'verbose|--verbose'                  'Layer purity → --verbose flag'
check 'Ψ2'  'Ψ2'                         'When to invoke'                     'Working-memory cap → front-door table'
check 'Ψ3'  'Ψ3'                         'audit|--auditors'                   'Confirmation-bias → audit verb'
check 'Ε1'  'Ε1'                         'streak'                             'Failure-streak escalation'
check 'Ε2'  'Ε2'                         'consecutive PASS|over-iteration'    'Over-iteration warning'
check 'Σ1'  'Σ1'                         'CONTRACT_AGENT|agent.*field'        'Agent attribution'
check 'Α1'  'Α1'                         'plan.*length|generic|< 24'          'Plan-quality surfacing'

if [ "$fail" -eq 0 ]; then
  echo "OK all 7 doctrines (Ψ1-3 Ε1-2 Σ1 Α1) declared AND bound to a runtime callsite"
  exit 0
fi
echo "FAIL: $fail doctrine(s) unbound"
exit 1
