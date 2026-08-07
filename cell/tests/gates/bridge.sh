#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
python3 "$CELL/run.py" run "$CELL/example/pipeline.cell.yaml" --inputs "$CELL/example/inputs.json" --out "$tmp/out" > /dev/null
for f in "$tmp/out/roster.json" "$tmp/out/manifest.json"; do
  if [ ! -f "$f" ]; then echo "FAIL bridge: $f missing"; exit 1; fi
  if ! python3 -m json.tool "$f" > /dev/null 2>&1; then echo "FAIL bridge: $f not valid json"; cat "$f"; exit 1; fi
done
echo "PASS bridge: outputs + manifest round-trip"
