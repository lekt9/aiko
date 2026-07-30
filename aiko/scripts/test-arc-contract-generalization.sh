#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PYTHON=${ARC_AGI3_PYTHON:-/Users/lewis/Unbrowse/ARC-AGI-3-Agents/.venv/bin/python}
REPORT=${TMPDIR:-/tmp}/aiko-arc-contract-generalization.json

cd "$ROOT"
python3 -m py_compile .agents/skills/arc-agi-3/scripts/arc_skill.py
python3 scripts/test-contract-native-skills.py
ARC_CONTRACT_REQUIRED=1 .agents/skills/arc-agi-3/scripts/native_contract_gate.sh
ARC_CONTRACT_REQUIRED=1 ARC_MECHANICAL=1 "$PYTHON" \
  .agents/skills/arc-agi-3/scripts/benchmark_native.py \
  --games r11l,sb26,tn36 \
  --max-actions 500 \
  --output "$REPORT"
python3 - "$REPORT" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1]))
assert report["errors"] == 0, report
assert report["contractRequired"] is True, report
assert report["contractCalls"] > 0, report
assert report["levelsCompleted"] >= 6, report
solved = {trial["game"]: trial["levelsCompleted"] for trial in report["trials"]}
assert solved.get("sb26", 0) >= 4, solved
assert solved.get("r11l", 0) >= 1, solved
assert solved.get("tn36", 0) >= 1, solved
print(json.dumps({
    "contractCalls": report["contractCalls"],
    "levelsCompleted": report["levelsCompleted"],
    "solved": solved,
}, sort_keys=True))
PY
