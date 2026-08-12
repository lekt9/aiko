#!/usr/bin/env bash
# Re-fire the goal gate iff the files it is derived from are staged.
set -euo pipefail
REL="aiko"
WATCH="$REL/docs/GOAL.md $REL/README.md $REL/docs/README.md $REL/AGENTS.md $REL/apps/aiko-app/scripts/prepare-runtime.mjs $REL/apps/aiko-app/src-tauri/src/cli_probe.rs $REL/apps/aiko-app/src-tauri/tauri.conf.json $REL/scripts/goal-gate.sh"
staged=$(git diff --cached --name-only)
touched=0
for w in $WATCH; do echo "$staged" | grep -qxF "$w" && touched=1; done
if [ "$touched" = 1 ]; then
  echo "goal-hook: goal inputs changed — re-firing goal gate"
  bash "$REL/scripts/goal-gate.sh" >/dev/null 2>&1 || {
    echo "goal gate FAILED — this commit drifts Aiko's north star (docs/GOAL.md)." >&2
    echo "Run: bash $REL/scripts/goal-gate.sh   |   bypass once: git commit --no-verify" >&2
    exit 1
  }
  echo "goal-hook: goal gate green"
fi
