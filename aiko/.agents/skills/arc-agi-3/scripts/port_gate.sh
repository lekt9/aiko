#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ARC_REPO="${ARC_AGI3_REPO:-/Users/lewis/Unbrowse/ARC-AGI-3-Agents}"
PYTHON="${ARC_AGI3_PYTHON:-$ARC_REPO/.venv/bin/python}"

test -x "$PYTHON"
test -d "$ARC_REPO/environment_files"
bash "$HERE/validate_skill_structure.sh"
ARC_MECHANICAL=1 ARC_AGI3_REPO="$ARC_REPO" \
  "$PYTHON" "$HERE/run_offline.py" --game "${ARC_AGI3_SMOKE_GAME:-ls20}" --max-actions 1 \
  --output /tmp/aiko-arc-agi3-port-gate.json > /tmp/aiko-arc-agi3-port-gate.log
"$PYTHON" - /tmp/aiko-arc-agi3-port-gate.json <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["solver"] == "aiko-arc-skill"
assert report["mode"] == "offline-mechanical"
assert report["actions"] == 1
step = report["transitions"][0]
assert 1 <= int(step["action"]) <= 7
assert step["organ"]
assert step["organ"] in ("cogmap-explore", "contract-ebm"), step
print("ARC-AGI-3 port gate: PASS", step["organ"], step["action"])
PY
