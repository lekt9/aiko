#!/usr/bin/env bash
# Φ2 — empathy-by-experience: snapshot user-facing URLs at typical viewports
# so the agent can Read what a real user sees on first paint before claiming
# a user-facing artifact is "satisfied".
#
# Usage:
#   user-pov-snapshot.sh <url> [<url>...]
#     [--viewport mobile:390x844] [--viewport desktop:1440x900]
#     [--wait 2500] [--fullpage] [--out <dir>]
#
# Defaults: mobile (390x844) + desktop (1440x900), above-the-fold, 2500ms wait.
# Writes one jpg per URL × viewport plus a manifest.txt with paths.
# Last stdout line: MANIFEST=<path>  — the agent reads that file then opens each jpg.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BROWSER_DIR="$SCRIPT_DIR/browser"

if [ ! -d "$BROWSER_DIR/node_modules/playwright" ]; then
  echo "bootstrapping playwright in $BROWSER_DIR ..." >&2
  (cd "$BROWSER_DIR" && bun install --silent)
fi

cd "$BROWSER_DIR"
exec bun user-pov-snap.mjs "$@"
