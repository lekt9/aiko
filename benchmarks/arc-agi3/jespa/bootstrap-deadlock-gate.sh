#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PYTHON=${ARC_AGI3_PYTHON:-/Users/lewis/Unbrowse/ARC-AGI-3-Agents/.venv/bin/python}

"$PYTHON" -m pytest -q \
  "$ROOT/.agents/skills/arc-agi-3/scripts/tests/test_world_model.py"
bash "$ROOT/.agents/skills/arc-agi-3/scripts/native_contract_gate.sh" >/dev/null
python3 "$ROOT/benchmarks/arc-agi3/jespa/bench_arc_contract.py" \
  --games all \
  --max-actions 500 \
  --seeds 11,29 \
  --rounds 1 \
  --output "$ROOT/benchmarks/arc-agi3/jespa/bootstrap-result.json" \
  --assert-win
python3 - "$ROOT/benchmarks/arc-agi3/jespa/bootstrap-result.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["jespa"] == {"levelsCompleted": 14, "wins": 0, "completionActions": 354}
assert report["baseline"] == {"levelsCompleted": 14, "wins": 0, "completionActions": 358}
assert report["won"] is True
print("ARC next-level witness: 14 levels, Contract 354 actions, baseline 358")
PY
