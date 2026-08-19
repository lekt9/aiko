#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; rm -rf "$CELL/drafts/gate-crud"' EXIT

# 1) firings journal: a run through the public CLI lands in the engine journal,
#    so activity from ANY caller (UI, CLI, agent) shows in `firings`
python3 "$CELL/run.py" run "$CELL/example/pipeline.cell.yaml" --inputs "$CELL/example/inputs.json" --out "$tmp/run" > /dev/null
fid=$(python3 -c "import json; print(json.load(open('$tmp/run/manifest.json'))['produced_by'])")
python3 "$CELL/run.py" firings --limit 500 | python3 -c "
import json, sys
ids = [f['id'] for f in json.load(sys.stdin)['firings']]
sys.exit(0 if '$fid' in ids else 1)
" || { echo "FAIL crud: firing not journaled"; exit 1; }

# 2) save is validator-bound: a valid cell saves, an invalid one refuses
python3 "$CELL/run.py" draft "gate crud probe" --kind python --name gate-crud-probe --write "$CELL/drafts/gate-crud" > /dev/null
saved="drafts/gate-crud/gate-crud-probe.cell.yaml"
python3 "$CELL/run.py" save "$saved" < "$CELL/$saved" > /dev/null || { echo "FAIL crud: valid save refused"; exit 1; }
echo "apiVersion: cell/v0" | python3 "$CELL/run.py" save "$saved" > /dev/null 2>&1 && { echo "FAIL crud: invalid save accepted"; exit 1; }

# 3) the root jail holds
echo "x" | python3 "$CELL/run.py" save "../evil.cell.yaml" > /dev/null 2>&1 && { echo "FAIL crud: traversal accepted"; exit 1; }

# 4) remove refuses a cell another cell references (composability guard)
if python3 "$CELL/run.py" remove "example/rank-python.cell.yaml" > /dev/null 2>&1; then
  git -C "$CELL/.." checkout -- "cell/example/rank-python.cell.yaml" 2>/dev/null || true
  echo "FAIL crud: removed a referenced cell"
  exit 1
fi

# 5) remove deletes an unreferenced cell
python3 "$CELL/run.py" remove "$saved" > /dev/null || { echo "FAIL crud: could not remove unreferenced draft"; exit 1; }
[ ! -f "$CELL/$saved" ] || { echo "FAIL crud: file still exists after remove"; exit 1; }

echo "PASS crud-verbs: journaled firings, validator-bound save, reference-guarded remove"
