#!/usr/bin/env bash
set -euo pipefail
bash tests/drop-in-covenant-gate.sh
bash tests/hoysan-roster-engine-gate.sh
bash tests/hoysan-deploy-gate.sh
test -x .agents/skills/aiko-drop-in/scripts/shadow.py
echo "aiko-drop-in: PASS"
