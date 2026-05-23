#!/usr/bin/env bash
# check-identity-binding.sh — the /contract substrate's public-facing
# voice is Aiko (contract 1bed8068). This check binds the SKILL.md
# Identity section to the doctrine:
#
#   1. the "## Identity (public-facing is Aiko)" header exists
#   2. the section cites the canonical aiko-voice skill (pointer-not-payload)
#   3. ≥4 of the seven load-bearing voice rules are named in-section
#   4. the Σ2 public/team/private tiering is referenced as the gate
#
# Origin: contract 1bed8068, 2026-05-23.
set -uo pipefail

DOC="${SKILL_MD:-$HOME/.claude/skills/contract/SKILL.md}"
[ -f "$DOC" ] || { echo "missing $DOC" >&2; exit 2; }

# 1. header present
if ! grep -qE '^## Identity \(public-facing is Aiko\)' "$DOC"; then
  echo "FAIL: Identity section header missing from $DOC" >&2
  exit 1
fi

# Slice the Identity section content into a temp so the subsequent greps
# don't false-positive against unrelated parts of SKILL.md.
SECTION=$(awk '
  /^## Identity \(public-facing is Aiko\)/ { keep=1; print; next }
  /^## / && keep { exit }
  keep { print }
' "$DOC")

if [ -z "$SECTION" ]; then
  echo "FAIL: Identity section is empty" >&2
  exit 1
fi

# 2. cites aiko-voice
if ! echo "$SECTION" | grep -q 'aiko-voice'; then
  echo "FAIL: Identity section does not cite the aiko-voice skill" >&2
  exit 1
fi

# 3. names ≥4 voice rules
RULES=(
  "employee"        # Employee, not tool
  "first-person"    # First-person feminine
  "substrate jargon"  # No substrate jargon
  "irreversible"    # Asks before irreversible
  "AI-slop"         # No AI-slop adjectives
  "up to speed"     # By tomorrow it's up to speed
  "sign in once"    # Sign-in-once not configure
)
hits=0
for rule in "${RULES[@]}"; do
  if echo "$SECTION" | grep -qiF "$rule"; then
    hits=$((hits + 1))
  fi
done
if [ "$hits" -lt 4 ]; then
  echo "FAIL: only $hits of 7 voice rules surfaced in Identity section (need >=4)" >&2
  exit 1
fi

# 4. references Σ2 tiering
if ! echo "$SECTION" | grep -qE 'public.*team.*private|audience|Σ2'; then
  echo "FAIL: Identity section does not reference Σ2 public/team/private tiering" >&2
  exit 1
fi

echo "identity-binding clean: SKILL.md Identity section present, cites aiko-voice, ${hits}/7 voice rules named, Σ2 tiering referenced."
exit 0
