#!/usr/bin/env bash
# verify-served-surface.sh — front-door wrapper for served-surface/verify.mjs.
#
# Lazy-installs playwright into scripts/served-surface/ on first use, then
# runs the gate. Idempotent and safe to point a /contract --action at.
#
# Usage:
#   verify-served-surface.sh <url> [<url>...] [--allow ...] [--report ...]
#
# Exit 0 → all URLs clean.  Exit 1 → at least one URL had errors.  Exit 2 → env fault.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$HERE/served-surface"

if [ ! -d "$DIR/node_modules/playwright" ]; then
  echo "served-surface: installing playwright (one-time)…" >&2
  if command -v bun >/dev/null 2>&1; then
    ( cd "$DIR" && bun install >/dev/null )
  elif command -v npm >/dev/null 2>&1; then
    ( cd "$DIR" && npm install --silent --no-audit --no-fund )
  else
    echo "served-surface: need bun or npm on PATH" >&2
    exit 2
  fi
fi

# Ensure chromium binary is present
if [ ! -d "$HOME/Library/Caches/ms-playwright" ] && [ ! -d "$HOME/.cache/ms-playwright" ]; then
  echo "served-surface: installing chromium (one-time)…" >&2
  if command -v bunx >/dev/null 2>&1; then
    ( cd "$DIR" && bunx playwright install chromium >/dev/null )
  else
    ( cd "$DIR" && npx playwright install chromium >/dev/null )
  fi
fi

exec node "$DIR/verify.mjs" "$@"
