#!/usr/bin/env bash
# check-readme-fresh.sh — guard README.md against drift vs SKILL.md.
#
# Properties:
#   1. README.md exists (the substrate's self-modeling requires the derived view)
#   2. README.md embeds a 'SKILL.md digest: <sha256>' header line
#   3. That digest matches the live SHA-256 of SKILL.md
#
# Failure on any one means README.md and SKILL.md have drifted. Regenerate
# with: bash ~/.claude/skills/contract/scripts/contract readme
set -uo pipefail
SKILL="$HOME/.claude/skills/contract/SKILL.md"
README="$HOME/.claude/skills/contract/README.md"

if [ ! -f "$README" ]; then
  echo "FAIL: README.md missing — regenerate with 'contract readme'" >&2
  exit 1
fi

embedded=$(grep -oE 'SKILL\.md digest: [a-f0-9]+' "$README" | head -1 | awk '{print $3}')
if [ -z "$embedded" ]; then
  echo "FAIL: README.md has no embedded 'SKILL.md digest: <hex>' header" >&2
  exit 1
fi

live=$(shasum -a 256 "$SKILL" 2>/dev/null | awk '{print $1}')
if [ -z "$live" ]; then
  # Linux fallback
  live=$(sha256sum "$SKILL" 2>/dev/null | awk '{print $1}')
fi
if [ -z "$live" ]; then
  echo "FAIL: could not compute SKILL.md SHA-256 (neither shasum nor sha256sum available)" >&2
  exit 2
fi

if [ "$embedded" != "$live" ]; then
  echo "FAIL: README.md digest drifted from SKILL.md" >&2
  echo "  embedded: $embedded" >&2
  echo "  live:     $live" >&2
  echo "  regenerate with: bash ~/.claude/skills/contract/scripts/contract readme" >&2
  exit 1
fi

echo "readme-fresh clean: README.md digest matches live SKILL.md ($embedded)"
exit 0
