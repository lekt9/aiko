#!/usr/bin/env bash
# observe-original.sh — front-door wrapper for browser/observe.mjs.
#
# Drives an existing live site through a scripted tour with a headless
# browser and records the per-screen network traffic + screenshots. The
# output `screen-flow.md` is the ground truth for any agent-led rebuild —
# read THIS, not the JS bundle's endpoint strings.
#
# Usage:
#   observe-original.sh --tour <tour.json> [--out <dir>]
#                       [--env-from <file>] [--timeout <ms>] [--headed]
#
# Exit 0 → captured successfully. Exit 2 → env fault.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$HERE/browser"

if [ ! -d "$DIR/node_modules/playwright" ]; then
  echo "browser: installing playwright (one-time)…" >&2
  if command -v bun >/dev/null 2>&1; then
    ( cd "$DIR" && bun install >/dev/null )
  elif command -v npm >/dev/null 2>&1; then
    ( cd "$DIR" && npm install --silent --no-audit --no-fund )
  else
    echo "browser: need bun or npm on PATH" >&2
    exit 2
  fi
fi

if [ ! -d "$HOME/Library/Caches/ms-playwright" ] && [ ! -d "$HOME/.cache/ms-playwright" ]; then
  echo "browser: installing chromium (one-time)…" >&2
  if command -v bunx >/dev/null 2>&1; then
    ( cd "$DIR" && bunx playwright install chromium >/dev/null )
  else
    ( cd "$DIR" && npx playwright install chromium >/dev/null )
  fi
fi

exec node "$DIR/observe.mjs" "$@"
