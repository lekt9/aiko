#!/usr/bin/env bash
# Structural validator (banger-skill-builder anatomy) for this skill directory.
# Usage: validate_skill_structure.sh [skill-dir]   (defaults to this skill)
set -u
SKILL="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail=0
ok()  { echo "  PASS  $1"; }
bad() { echo "  FAIL  $1"; fail=1; }

echo "== structure: $SKILL =="

# frontmatter: name + description
S="$SKILL/SKILL.md"
[ -s "$S" ] || { bad "no SKILL.md"; exit 1; }
head -1 "$S" | grep -q '^---$' && ok "frontmatter opens" || bad "frontmatter must start at line 1"
grep -q "^name:" "$S" && ok "has name:" || bad "missing name:"
grep -q "^description:" "$S" && ok "has description:" || bad "missing description:"

# required sections
for sec in "Output mode" "Workflow" "Hard rules" "does NOT do"; do
  grep -qi "$sec" "$S" && ok "section: $sec" || bad "missing section: $sec"
done

# at least one executable script
execs=$(find "$SKILL/scripts" -maxdepth 1 -type f -perm -u+x 2>/dev/null | wc -l | tr -d ' ')
[ "$execs" -ge 1 ] && ok "scripts/ has $execs executable(s)" || bad "no executable script in scripts/"

# references one level deep only (no nested reference dirs except upstream/)
nested=$(find "$SKILL/references" -mindepth 2 -type d 2>/dev/null | grep -v "/upstream" | wc -l | tr -d ' ')
[ "$nested" -eq 0 ] && ok "references one level deep" || bad "references nested deeper than one level"

# assets present
[ -d "$SKILL/assets" ] && ok "assets/ present" || bad "no assets/"

echo "== $( [ $fail -eq 0 ] && echo OK || echo FAIL ) =="
exit $fail
