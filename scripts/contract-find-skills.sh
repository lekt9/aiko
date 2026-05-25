#!/usr/bin/env bash
# contract-find-skills.sh — substrate-side bridge for contract:197330b6
#
# At /contract iterate time, this wrapper surfaces best-practice skill rows
# from the /find-skills surface so the agent (KEY 2) doesn't re-discover
# already-installed primitives. Emits JSON lines on stdout that the caller
# prepends to the iterate evidence as "AUGMENTED:" rows.
#
# Substrate enables, never prescribes (ee1f5409): we surface what /find-skills
# already indexes — we do not invent skill recommendations here. The agent
# judges which augmented row is load-bearing for the current contract.
#
# Usage:
#   contract-find-skills.sh "<context-string>"
#
# Output (stdout): one JSON object per line:
#   {"skill":"<name>","doctrine_refs":["<id>",...],"reason":"<one-line>"}
#
# When /find-skills is not available locally, emit nothing and exit 0
# (honest gap, not stub: Γ1 no-stubs).

set -euo pipefail

CONTEXT="${1:-}"
[ -z "$CONTEXT" ] && { echo "usage: contract-find-skills.sh <context>" >&2; exit 2; }

# Resolve the find-skills SKILL.md. Honour the symlink at ~/.claude/skills.
FIND_SKILLS_DIR=""
for candidate in \
  "$HOME/.claude/skills/find-skills" \
  "$HOME/.agents/skills/find-skills" \
; do
  if [ -f "$candidate/SKILL.md" ]; then
    FIND_SKILLS_DIR="$candidate"
    break
  fi
done

if [ -z "$FIND_SKILLS_DIR" ]; then
  # Honest gap — no augmentation available. Exit 0 so iterate continues.
  exit 0
fi

# Local skill registry — what's already installed on this machine.
# /find-skills proper is an agent-routed surface (npx skills find <q>),
# but at substrate-time we surface installed-skill metadata as the
# augmentation. The agent can still route to the full /find-skills tool
# in-thread when KEY 2 needs deeper search.
SKILLS_ROOT="$HOME/.claude/skills"
[ -d "$SKILLS_ROOT" ] || exit 0

# Tokenize context for naive keyword match against skill names + descriptions.
# This is a structural primitive (substring match); the agent does the
# semantic judging in KEY 2.
CTX_LOWER=$(printf '%s' "$CONTEXT" | tr '[:upper:]' '[:lower:]')

# Walk installed skills. For each SKILL.md, surface skills whose name or
# description shares any non-trivial token with the context.
emitted=0
for skill_dir in "$SKILLS_ROOT"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_md="$skill_dir/SKILL.md"
  [ -f "$skill_md" ] || continue
  skill_name=$(basename "${skill_dir%/}")
  # Skip self (contract) and the find-skills bridge target itself.
  case "$skill_name" in
    contract|find-skills) continue ;;
  esac
  # Read front-matter description (line 3 typically).
  desc=$(awk '/^description:/ {sub(/^description: */,""); print; exit}' "$skill_md" 2>/dev/null || true)
  [ -z "$desc" ] && continue
  desc_lower=$(printf '%s' "$desc" | tr '[:upper:]' '[:lower:]')
  # Match: any context token of length >= 4 appears in desc or name.
  matched=""
  for tok in $CTX_LOWER; do
    [ ${#tok} -ge 4 ] || continue
    case "$desc_lower" in *"$tok"*) matched="$tok"; break ;; esac
    case "$skill_name" in *"$tok"*) matched="$tok"; break ;; esac
  done
  if [ -n "$matched" ]; then
    # Emit JSON line. Doctrine refs left empty — the skill's own SKILL.md
    # cites its doctrine; we don't re-derive it here (substrate enables).
    printf '{"skill":"%s","doctrine_refs":[],"reason":"name/description matches context token: %s"}\n' \
      "$skill_name" "$matched"
    emitted=$((emitted + 1))
    [ "$emitted" -ge 5 ] && break
  fi
done

exit 0
