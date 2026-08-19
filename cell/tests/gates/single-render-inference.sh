#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$(cd "$CELL/.." && pwd)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# 1) the engine exposes the membrane, with a real render and its provenance
python3 "$CELL/run.py" inspect "$CELL/patterns/hoysan-draft/hoysan-draft.cell.yaml" > "$tmp/m.json"
python3 - "$tmp/m.json" <<'PY' || { echo "FAIL: engine membrane"; exit 1; }
import json, sys
m = json.load(open(sys.argv[1]))
ports = {p["name"]: p for p in m["ports"]}
assert ports, "no ports"
assert all(p.get("render") for p in m["ports"]), "a port has no render spec"
assert all(p["renderVia"] in ("explicit", "inferred") for p in m["ports"]), "renderVia missing"
# schema files must resolve, or every real cell renders as "raw"
req = ports["request"]
assert req["render"]["type"] == "form", req["render"]
assert any(f.get("label") for f in req["render"]["fields"]), "labels missing"
PY

# 2) a cell with no ports fails closed rather than rendering an empty membrane
mkdir -p "$tmp/c"
cat > "$tmp/c/empty.cell.yaml" <<'YAML'
apiVersion: cell/v0
kind: Cell
metadata:
  name: empty-probe
  description: no ports on purpose
spec:
  membrane:
    inputs: {}
    outputs: {}
  run:
    kind: python
    entry: neurons/none.py
YAML
python3 "$CELL/run.py" inspect "$tmp/c/empty.cell.yaml" > /dev/null 2>&1 \
  && { echo "FAIL: a portless membrane was accepted"; exit 1; }

# 3) ONE inference in the substrate. A UI that re-derives a render spec drifts
#    from the engine that fires it — this is what the merge removed, so
#    reintroducing it must turn this gate red.
copies=$(cd "$ROOT" && python3 - <<'PY'
import pathlib
skip = {"node_modules", "dist", ".git", "target", "out", ".next", "zig-out"}
hits = []
for p in pathlib.Path(".").rglob("*"):
    if p.is_dir() or any(s in p.parts for s in skip): continue
    if p.suffix not in (".ts", ".tsx", ".js", ".py"): continue
    try: t = p.read_text()
    except Exception: continue
    # a definition of render inference, not a call or a mention
    if "def infer_render" in t or "function inferCellRender" in t or "const inferCellRender" in t:
        hits.append(str(p))
print("\n".join(sorted(hits)))
PY
)
count=$(printf '%s\n' "$copies" | grep -c . || true)
[ "$count" = "1" ] || { echo "FAIL: expected exactly 1 render inference, found $count:"; printf '%s\n' "$copies"; exit 1; }
printf '%s\n' "$copies" | grep -q "helpers.py" || { echo "FAIL: the single inference is not the engine's"; exit 1; }

echo "PASS single-render-inference: engine owns inference, ports carry renderVia, portless fails closed"
