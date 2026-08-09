#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/worker.py" <<'PY'
import os, pathlib, time

def run(inputs, ctx):
    root = pathlib.Path(inputs["root"])
    marker = root / "active"
    name = pathlib.Path(ctx["cell_file"]).stem.split(".", 1)[0]
    try:
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        (root / "overlap").write_text(name, encoding="utf-8")
        raise RuntimeError(f"same-frontier overlap: {name}") from exc
    try:
        os.close(fd)
        with (root / "trace").open("a", encoding="utf-8") as stream:
            stream.write(name + "\n")
        # Make overlap deterministic if a future runtime reintroduces Python concurrency.
        time.sleep(0.25)
    finally:
        marker.unlink(missing_ok=True)
    return {"value": name}
PY

cat > "$tmp/graph.cell.yaml" <<'YAML'
apiVersion: cell/v0
kind: Cell
metadata: {name: effect-safety, description: proves advisory Python authority stays serialized}
spec:
  membrane:
    inputs: {root: {schema: string}}
    outputs: {a: {schema: string}, b: {schema: string}, e: {schema: string}}
    caps: {}
  organelles:
    - {name: advisory-a, cell: ./advisory-a.cell.yaml}
    - {name: advisory-b, cell: ./advisory-b.cell.yaml}
    - {name: effectful, cell: ./effectful.cell.yaml}
  wiring:
    - {from: membrane.root, to: advisory-a.root}
    - {from: membrane.root, to: advisory-b.root}
    - {from: membrane.root, to: effectful.root}
    - {from: advisory-a.value, to: membrane.a}
    - {from: advisory-b.value, to: membrane.b}
    - {from: effectful.value, to: membrane.e}
YAML
for name in advisory-a advisory-b; do
cat > "$tmp/$name.cell.yaml" <<YAML
apiVersion: cell/v0
kind: Cell
metadata: {name: $name, description: empty caps are advisory not confinement}
spec:
  membrane:
    inputs: {root: {schema: string}}
    outputs: {value: {schema: string}}
    caps: {}
  run: {kind: python, entry: ./worker.py}
YAML
done
cat > "$tmp/effectful.cell.yaml" <<'YAML'
apiVersion: cell/v0
kind: Cell
metadata: {name: effectful, description: declared effect remains serial}
spec:
  membrane:
    inputs: {root: {schema: string}}
    outputs: {value: {schema: string}}
    caps: {allow_write: ["declared/**"]}
  run: {kind: python, entry: ./worker.py}
YAML

mkdir "$tmp/external"
printf '{"root":"%s"}\n' "$tmp/external" > "$tmp/in.json"
python3 "$CELL/run.py" run "$tmp/graph.cell.yaml" --inputs "$tmp/in.json" --out "$tmp/out" >/dev/null
[ ! -e "$tmp/external/overlap" ] || { echo "FAIL effect-safety: Python siblings overlapped"; exit 1; }
expected=$'advisory-a\nadvisory-b\neffectful'
actual=$(cat "$tmp/external/trace")
[ "$actual" = "$expected" ] || { echo "FAIL effect-safety: non-lexical/overlapping trace: $actual"; exit 1; }
# The empty-caps leaves wrote outside their workdirs. That is evidence of ambient authority,
# not success of a sandbox; the specification must label it declaration/audit only.
grep -q 'declaration/audit only' "$CELL/docs/constraints.md"
grep -q 'not sandboxed' "$CELL/SPEC.md"
! grep -q 'No ambient authority' "$CELL/SPEC.md"
echo "PASS effect-safety: advisory and effectful Python siblings serialize; empty caps are not called mechanical confinement"
