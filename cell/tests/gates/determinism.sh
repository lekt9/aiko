#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# pipeline's rank is required determinism: sorted() -> total order, same inputs -> same outputs
python3 "$CELL/run.py" run "$CELL/example/pipeline.cell.yaml" --inputs "$CELL/example/inputs.json" --out "$tmp/a" > /dev/null
python3 "$CELL/run.py" run "$CELL/example/pipeline.cell.yaml" --inputs "$CELL/example/inputs.json" --out "$tmp/b" > /dev/null
if ! diff -q "$tmp/a/roster.json" "$tmp/b/roster.json" > /dev/null; then
  echo "FAIL determinism: same inputs produced different roster"
  diff "$tmp/a/roster.json" "$tmp/b/roster.json" || true
  exit 1
fi
echo "PASS determinism: same inputs -> same bytes"
