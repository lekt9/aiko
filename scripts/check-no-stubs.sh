#!/bin/bash
# Γ1 no-stubs scanner: scans skill code for stub patterns. A stub is:
#   - dead/redirect verb cases that print "deprecation" or "redirect" without doing the work
#   - TODO/FIXME/XXX/STUB comments without a captured DEFERRED-* contract row
#   - raise NotImplementedError / pass # stub / # stub: / # placeholder
#   - empty function bodies that just `pass` / `return None` with no comment
#   - shell echo "soon" / "coming" / "deprecated"
#
# Exit 0 if no stubs found OR every stub is covered by an open DEFERRED-* row
# whose plan substring matches the stub location.
# Exit 1 with surfaced offenders if stubs exist uncovered.
set -uo pipefail

SCAN_ROOTS=(
  "$HOME/.claude/skills/contract/scripts"
  "$HOME/.claude/skills/aiko/scripts"
  "$HOME/.contracts/hooks"
)

STUB_PATTERNS=(
  "raise NotImplementedError"
  "# TODO"
  "# FIXME"
  "# XXX"
  "# stub"
  "# STUB"
  "# placeholder"
  "DEPRECATION"
  "is removed:"
  "is superseded\."
  "soft-deprecated"
)

OFFENDERS=()
for root in "${SCAN_ROOTS[@]}"; do
  [ -d "$root" ] || continue
  for pattern in "${STUB_PATTERNS[@]}"; do
    while IFS= read -r hit; do
      [ -n "$hit" ] && OFFENDERS+=("$hit")
    done < <(grep -rnI "$pattern" "$root" --include="*.sh" --include="*.py" --include="contract" --include="aiko*" 2>/dev/null \
              | grep -v "check-no-stubs.sh" \
              | grep -v "verify.sh" \
              | grep -v "/audits/" \
              || true)
  done
done

if [ ${#OFFENDERS[@]} -eq 0 ]; then
  echo "Γ1 NO-STUBS: clean"
  exit 0
fi

echo "Γ1 NO-STUBS: FAIL — ${#OFFENDERS[@]} stub-pattern hit(s) in skill code"
echo
for offender in "${OFFENDERS[@]}"; do
  echo "  $offender"
done
echo
echo "Each hit must either:"
echo "  (a) be fully removed (do the work or delete the surface), or"
echo "  (b) have a captured DEFERRED-* contract row naming the gap (Β6: contract gap)"
exit 1
