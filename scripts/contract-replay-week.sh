#!/usr/bin/env bash
# contract-replay-week — RESTART primitive
#
# Usage: contract-replay-week.sh [--since-days N] [--project-glob PAT]
#
# What it does (no verdicts — pure evidence):
#   1. Lists git commits + file deltas in this repo over the window
#   2. Harvests every authentic user prompt from ~/.claude/projects/*.jsonl
#      that touched the current project, in the window, in chronological order
#   3. Surfaces both as a single artifact at /tmp/contract-replay-week-<ts>/
#   4. Returns the artifact path; agent reads + decides what to re-declare
#
# Idempotent: re-runs into a fresh timestamped dir, never overwrites.
set -eu  # no pipefail — head | sort | awk SIGPIPEs are benign
# normalise: derive PROJECT_DIRS from the canonical claude-project slug + variants
SINCE_DAYS="${SINCE_DAYS:-8}"
while [ $# -gt 0 ]; do
  case "$1" in
    --since-days) SINCE_DAYS="$2"; shift 2 ;;
    *) shift ;;
  esac
done
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="/tmp/contract-replay-week-${TS}"
mkdir -p "$OUT"

# Detect the repo + claude project slug
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SLUG="$(echo "$REPO_ROOT" | sed 's|^/||; s|/|-|g')"
PROJECT_GLOBS=(
  "$HOME/.claude/projects/-${SLUG}"
  "$HOME/.claude/projects/-${SLUG}-frontend"
  "$HOME/.claude/projects/-${SLUG}-backend"
)

# 1. git evidence
{
  echo "# Git activity over last ${SINCE_DAYS} days"
  echo
  echo "## Commits"
  git log --since="${SINCE_DAYS} days ago" --pretty=format:'%h %ad %an %s' --date=short
  echo
  echo
  echo "## File deltas (top 30 by lines changed)"
  git log --since="${SINCE_DAYS} days ago" --numstat --pretty=tformat: \
    | awk '$1 ~ /^[0-9]/ {add[$3]+=$1; del[$3]+=$2} END {for (f in add) printf "%6d +%6d -%6d %s\n", add[f]+del[f], add[f], del[f], f}' \
    | sort -rn | head -30
} > "$OUT/git.md"

# 2. prompt harvest (calls a sibling Python script for the JSON-parse heavy work)
export SINCE_DAYS
PROJECT_DIRS_STR="${PROJECT_GLOBS[*]}"
export PROJECT_DIRS="$PROJECT_DIRS_STR"
python3 "$(dirname "$0")/contract-replay-harvest.py" > "$OUT/prompts.jsonl"
wc -l "$OUT/prompts.jsonl" | awk '{print "harvested "$1" prompts"}' > "$OUT/SUMMARY"

# 3. surface artifact path
echo "$OUT"
