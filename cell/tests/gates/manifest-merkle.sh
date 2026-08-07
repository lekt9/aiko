#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
python3 "$CELL/run.py" run "$CELL/example/hello.cell.yaml" --out "$tmp/out" > /dev/null
if [ ! -f "$tmp/out/manifest.json" ]; then echo "FAIL manifest-merkle: out/manifest.json missing"; exit 1; fi
m=$(cat "$tmp/out/manifest.json")
for f in '"cell"' '"inputs"' '"outputs"' '"evidence"' '"produced_by"'; do
  if ! echo "$m" | grep -q "$f"; then echo "FAIL manifest-merkle: manifest missing $f: $m"; exit 1; fi
done
python3 "$CELL/run.py" run "$CELL/example/pipeline.cell.yaml" --inputs "$CELL/example/inputs.json" --out "$tmp/out2" > /dev/null
if [ ! -f "$tmp/out2/manifest.json" ]; then echo "FAIL manifest-merkle: composite manifest missing"; exit 1; fi
echo "PASS manifest-merkle: leaf+composite manifests present"
