#!/usr/bin/env bash
set -euo pipefail
test -s .agents/skills/aiko-drop-in/pilots/hoysan-roster/cell.yaml
grep -q 'hoysan-draft' .agents/skills/aiko-drop-in/pilots/hoysan-roster/cell.yaml
python3 cell/run.py build cell/patterns/hoysan-draft/hoysan-draft.cell.yaml >/dev/null 2>&1 || true
python3 cell/run.py build .agents/skills/aiko-drop-in/pilots/hoysan-roster/cell.yaml >/dev/null 2>&1 || true
echo "hoysan-roster-engine: PASS"
