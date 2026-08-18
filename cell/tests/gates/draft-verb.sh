#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

# 1) deterministic: same request -> byte-identical proposal (no clock, no randomness)
python3 "$CELL/run.py" draft "remind rostered workers before shift" --kind python > a.json
python3 "$CELL/run.py" draft "remind rostered workers before shift" --kind python > b.json
diff -q a.json b.json > /dev/null || { echo "FAIL draft: proposal not deterministic"; diff a.json b.json || true; exit 1; }

# 2) inert by default: without --write the engine materializes nothing
[ "$(ls | sort | tr '\n' ' ')" = "a.json b.json " ] || { echo "FAIL draft: wrote files without --write"; ls; exit 1; }

# 3) --write materializes a proposal the engine's own validator accepts
python3 "$CELL/run.py" draft "remind rostered workers before shift" --kind python --write "$tmp/pkg" > /dev/null
name=$(python3 -c "import json; print(json.load(open('a.json'))['name'])")
python3 "$CELL/run.py" build "$tmp/pkg/$name.cell.yaml" > /dev/null || { echo "FAIL draft: drafted cell rejected by build"; exit 1; }

# 4) nothing retained on compilation alone: the stub must REFUSE to fire green
echo '{"data":{}}' > in.json
if python3 "$CELL/run.py" run "$tmp/pkg/$name.cell.yaml" --inputs in.json --out "$tmp/out" > /dev/null 2>&1; then
  echo "FAIL draft: stub ran green — a do-nothing handler could earn admission"
  exit 1
fi

# 5) fail closed on bad requests
python3 "$CELL/run.py" draft "" --kind python > /dev/null 2>&1 && { echo "FAIL draft: empty goal accepted"; exit 1; }
python3 "$CELL/run.py" draft "x" --kind nosuch > /dev/null 2>&1 && { echo "FAIL draft: unknown kind accepted"; exit 1; }

# 6) never clobber an existing draft
python3 "$CELL/run.py" draft "remind rostered workers before shift" --kind python --write "$tmp/pkg" > /dev/null 2>&1 && { echo "FAIL draft: clobbered existing draft"; exit 1; }

echo "PASS draft-verb: deterministic, inert by default, validator-bound, stub refuses green"
