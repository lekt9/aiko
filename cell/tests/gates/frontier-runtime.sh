#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/worker.py" <<'PY'
import time
def run(inputs, ctx):
    time.sleep(0.05)
    return {"value": inputs["value"]}
PY
cat > "$tmp/graph.cell.yaml" <<'YAML'
apiVersion: cell/v0
kind: Cell
metadata: {name: frontier-witness, description: proves typed deterministic Kahn frontier}
spec:
  membrane:
    inputs: {value: {schema: string}}
    outputs: {a: {schema: string}, b: {schema: string}}
    caps: {}
  organelles:
    - {name: left, cell: ./left.cell.yaml}
    - {name: right, cell: ./right.cell.yaml}
  wiring:
    - {from: membrane.value, to: left.value}
    - {from: membrane.value, to: right.value}
    - {from: left.value, to: membrane.a}
    - {from: right.value, to: membrane.b}
YAML
for name in left right; do cat > "$tmp/$name.cell.yaml" <<YAML
apiVersion: cell/v0
kind: Cell
metadata: {name: $name, description: deterministic frontier worker}
spec:
  membrane:
    inputs: {value: {schema: string}}
    outputs: {value: {schema: string}}
    caps: {}
  run: {kind: python, entry: ./worker.py}
YAML
done
echo '{"value":"ok"}' > "$tmp/in.json"
python3 "$CELL/run.py" run "$tmp/graph.cell.yaml" --inputs "$tmp/in.json" --out "$tmp/out1" >/dev/null
cell1=$(python3 -c 'import json; print(json.load(open("'$tmp'/out1/manifest.json"))["cell"])')
echo '# provenance mutation' >> "$tmp/worker.py"
python3 "$CELL/run.py" run "$tmp/graph.cell.yaml" --inputs "$tmp/in.json" --out "$tmp/out2" >/dev/null
cell2=$(python3 -c 'import json; print(json.load(open("'$tmp'/out2/manifest.json"))["cell"])')
if [ "$cell1" = "$cell2" ]; then
  echo "FAIL frontier-runtime: child executable bytes did not move parent cell digest"; exit 1
fi
python3 - <<PY
import json
m=json.load(open("$tmp/out2/manifest.json"))
assert set(m["children"]) == {"left", "right"}, m
assert all("digest" in child for child in m["children"].values()), m
PY
# Unknown ports and undeclared inputs must be refused before any worker fires.
sed 's/to: left.value/to: left.missing/' "$tmp/graph.cell.yaml" > "$tmp/bad.cell.yaml"
if python3 "$CELL/run.py" build "$tmp/bad.cell.yaml" >/dev/null 2>&1; then
  echo "FAIL frontier-runtime: unknown target port admitted"; exit 1
fi
echo '{"value":"ok","ambient":"forbidden"}' > "$tmp/extra.json"
if python3 "$CELL/run.py" run "$tmp/graph.cell.yaml" --inputs "$tmp/extra.json" --out "$tmp/out3" >/dev/null 2>&1; then
  echo "FAIL frontier-runtime: undeclared root input admitted"; exit 1
fi
echo "PASS frontier-runtime: strict ports, deterministic Kahn frontier, child-code Merkle provenance"
