#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo '{"root":"'"$CELL/system/builder.cell.yaml"'"}' > "$tmp/in.json"
out=$(python3 "$CELL/run.py" run "$CELL/system/builder.cell.yaml" --inputs "$tmp/in.json" --out "$tmp/out" 2>&1)
if [ ! -f "$tmp/out/canonical.json" ] || [ ! -f "$tmp/out/digest.json" ]; then
  echo "FAIL builder-self: builder did not self-host (missing outputs): $out"
  exit 1
fi
echo "PASS builder-self: builder builds itself"
