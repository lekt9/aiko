#!/usr/bin/env bash
# check-streams-convention.sh — guard the receptor↔stream duality docs against
# drift between SKILL.md and the implementing CLI. Three properties must hold:
#
#   1. SKILL.md has a "Streams (the output side of receptors)" section
#   2. SKILL.md names the stream path convention ~/.contracts/streams/<id>/
#   3. The 'contract tail' verb exists and follows that same path
#
# Failure on any one of the three means docs and code disagree.
set -uo pipefail
SKILL="$HOME/.claude/skills/contract/SKILL.md"
CLI="$HOME/.claude/skills/contract/scripts/contract"
fail=0

if ! grep -q '^## Streams (the output side of receptors)' "$SKILL"; then
  echo "FAIL: SKILL.md missing '## Streams (the output side of receptors)' section" >&2
  fail=$((fail+1))
fi

if ! grep -qE '~/\.contracts/streams/<contract-id>|~/\.contracts/streams/<id>/stdout\.log|contracts/streams/<id>' "$SKILL"; then
  echo "FAIL: SKILL.md does not name the stream path convention" >&2
  fail=$((fail+1))
fi

if ! grep -qE 'streams/\$ID|streams/\$\{ID\}|HOME/\.contracts/streams' "$CLI"; then
  echo "FAIL: 'contract' CLI does not reference ~/.contracts/streams (the documented path)" >&2
  fail=$((fail+1))
fi

# Verify the verb is actually wired (not just a comment)
if ! grep -q '^  tail)' "$CLI"; then
  echo "FAIL: 'contract' CLI lacks a 'tail)' case branch" >&2
  fail=$((fail+1))
fi

if [ $fail -gt 0 ]; then
  exit 1
fi
echo "streams-convention clean: SKILL.md, tail verb, and path convention all agree."
exit 0
