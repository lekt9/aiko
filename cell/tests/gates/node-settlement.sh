#!/bin/bash
# A cell is a graph node: it declares what it may write, and the runnable check
# that says it is done. This gate holds the two claims that follow from that —
# unordered nodes may not both claim a write, and firing is not settling.
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/worker.py" <<'PY'
def run(inputs, ctx):
    return {"value": inputs["value"]}
PY

leaf() { # leaf <name> <policy-yaml>
  cat > "$tmp/$1.cell.yaml" <<YAML
apiVersion: cell/v0
kind: Cell
metadata: {name: $1, description: settlement fixture worker}
spec:
  membrane:
    inputs: {value: {schema: string}}
    outputs: {value: {schema: string}}
    caps: {}
  policy: {$2}
  run: {kind: python, entry: ./worker.py}
YAML
}

parallel_graph() { # both nodes fed from the membrane => one frontier, unordered
  cat > "$tmp/graph.cell.yaml" <<'YAML'
apiVersion: cell/v0
kind: Cell
metadata: {name: settle-witness, description: proves writes collide and witnesses settle}
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
}
echo '{"value":"ok"}' > "$tmp/in.json"
run_graph() { python3 "$CELL/run.py" run "$tmp/graph.cell.yaml" --inputs "$tmp/in.json" --out "$tmp/$1"; }

# 1) two unordered nodes claiming the same write are refused — the graph does not
#    say which write survives, and lexical execution order is not a declared order.
leaf left  'writes: [shared.txt]'
leaf right 'writes: [shared.txt]'
parallel_graph
if run_graph out1 >"$tmp/log1" 2>&1; then
  echo "FAIL node-settlement: unordered nodes both claiming shared.txt were admitted"; exit 1
fi
grep -q "write collision" "$tmp/log1" || { echo "FAIL node-settlement: refused, but not as a write collision"; cat "$tmp/log1"; exit 1; }

# 2) the same two writes ARE admitted once an edge orders them — the refusal is
#    about missing order, not about declaring a write at all.
cat > "$tmp/graph.cell.yaml" <<'YAML'
apiVersion: cell/v0
kind: Cell
metadata: {name: settle-ordered, description: same writes, ordered by a real edge}
spec:
  membrane:
    inputs: {value: {schema: string}}
    outputs: {b: {schema: string}}
    caps: {}
  organelles:
    - {name: left, cell: ./left.cell.yaml}
    - {name: right, cell: ./right.cell.yaml}
  wiring:
    - {from: membrane.value, to: left.value}
    - {from: left.value, to: right.value}
    - {from: right.value, to: membrane.b}
YAML
run_graph out2 >/dev/null 2>&1 || { echo "FAIL node-settlement: ordered nodes sharing a write were refused"; exit 1; }

# 3) a node that fires green but whose witness is RED does not settle — this is
#    the whole claim: running is not being done.
leaf left  "writes: [], witness: \"test -f $tmp/never-created\""
leaf right 'writes: []'
parallel_graph
if run_graph out3 >"$tmp/log3" 2>&1; then
  echo "FAIL node-settlement: node with a red witness settled — firing was accepted as done"; exit 1
fi
grep -q "did not settle" "$tmp/log3" || { echo "FAIL node-settlement: refused, but not for failing its witness"; cat "$tmp/log3"; exit 1; }
if [ -f "$tmp/out3/manifest.json" ]; then echo "FAIL node-settlement: unsettled run still wrote a root manifest"; exit 1; fi

# 4) a green witness settles AND is recorded — and it really executed, proven by
#    a side effect the engine could not have produced by parsing the string.
leaf left  "writes: [], witness: \"touch $tmp/witness-ran && exit 0\""
leaf right 'writes: []'
parallel_graph
run_graph out4 >/dev/null 2>&1 || { echo "FAIL node-settlement: node with a green witness did not settle"; exit 1; }
[ -f "$tmp/witness-ran" ] || { echo "FAIL node-settlement: witness recorded as settled but never executed"; exit 1; }
python3 - <<PY
import json, sys
m = json.load(open("$tmp/out4/_work_left/manifest.json"))
w = m.get("witness")
assert w and w["settled"] is True and w["exit"] == 0, f"settlement not recorded on the node manifest: {w}"
r = json.load(open("$tmp/out4/_work_right/manifest.json"))
assert "witness" not in r, "a node that declared no witness was given one"
PY

# 5) the declarations fail closed at build time
leaf left  'writes: ["../escape"]'
leaf right 'writes: []'
parallel_graph
if python3 "$CELL/run.py" build "$tmp/left.cell.yaml" >/dev/null 2>&1; then echo "FAIL node-settlement: traversing write path admitted"; exit 1; fi
leaf left 'witness: ""'
if python3 "$CELL/run.py" build "$tmp/left.cell.yaml" >/dev/null 2>&1; then echo "FAIL node-settlement: empty witness command admitted"; exit 1; fi

echo "PASS node-settlement: unordered writes refused, ordered writes admitted, red witness blocks settlement, green witness recorded"
