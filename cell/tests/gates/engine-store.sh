#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export CELL_ENGINE_DB="$tmp/engine.db"
export CELL_UI_AUTO_OPEN=0

run_with_id() {  # $1 = order id, $2 = out dir
  python3 - "$CELL" "$1" "$tmp/in-$1.json" <<'PY'
import json, pathlib, sys
cell, oid, dest = sys.argv[1:4]
d = json.loads(pathlib.Path(f"{cell}/example/inputs.json").read_text())
d["order"] = dict(d["order"]); d["order"]["id"] = oid
pathlib.Path(dest).write_text(json.dumps(d))
PY
  python3 "$CELL/run.py" run "$CELL/example/pipeline.cell.yaml" --inputs "$tmp/in-$1.json" --out "$2" > /dev/null
}

# 1) a firing lands in the store, with per-node rows taken from the manifest
run_with_id engine-a "$tmp/a"
python3 - <<'PY' || { echo "FAIL engine: firing or node rows missing"; exit 1; }
import json, os, sqlite3, sys
db = sqlite3.connect(os.environ["CELL_ENGINE_DB"]); db.row_factory = sqlite3.Row
firings = db.execute("SELECT * FROM firings").fetchall()
assert len(firings) == 1, f"expected 1 firing, got {len(firings)}"
nodes = db.execute("SELECT node FROM node_runs WHERE firing_id = ?", (firings[0]["id"],)).fetchall()
assert {n["node"] for n in nodes} == {"qualify", "rank"}, [n["node"] for n in nodes]
PY

# 2) identity is the key: the same pinned inputs re-fired add no row
run_with_id engine-a "$tmp/a2"
count=$(python3 -c "
import os,sqlite3;print(sqlite3.connect(os.environ['CELL_ENGINE_DB']).execute('SELECT COUNT(*) FROM firings').fetchone()[0])")
[ "$count" = "1" ] || { echo "FAIL engine: re-fire duplicated identity ($count rows)"; exit 1; }

# 3) a different pinned input is a different firing
run_with_id engine-b "$tmp/b"
count=$(python3 -c "
import os,sqlite3;print(sqlite3.connect(os.environ['CELL_ENGINE_DB']).execute('SELECT COUNT(*) FROM firings').fetchone()[0])")
[ "$count" = "2" ] || { echo "FAIL engine: new identity not recorded ($count rows)"; exit 1; }

# 4) the projection reads the store and carries per-node rows
python3 "$CELL/run.py" firings --limit 10 | python3 -c "
import json,sys
d=json.load(sys.stdin)['firings']
assert len(d)==2, d
assert all('created_at' in f and f['nodes'] for f in d), d
" || { echo "FAIL engine: firings projection"; exit 1; }

# 5) deploy detection names the fde/self-wire family and nothing else
python3 - "$CELL" <<'PY' || { echo "FAIL engine: deploy detection"; exit 1; }
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("cellrun", pathlib.Path(sys.argv[1]) / "run.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m._is_deploy_cell("patterns/fde/self-wire.cell.yaml")
assert m._is_deploy_cell("patterns/fde/deploy-aiko.cell.yaml")
assert not m._is_deploy_cell("example/pipeline.cell.yaml")
PY

# 6) opening the canvas is best-effort: a failing opener must not fail a firing
mkdir -p "$tmp/bin"
printf '#!/bin/sh\nexit 3\n' > "$tmp/bin/open"; chmod +x "$tmp/bin/open"
printf '#!/bin/sh\nexit 3\n' > "$tmp/bin/xdg-open"; chmod +x "$tmp/bin/xdg-open"
PATH="$tmp/bin:$PATH" CELL_UI_AUTO_OPEN=1 python3 "$CELL/run.py" run "$CELL/example/pipeline.cell.yaml" \
  --inputs "$tmp/in-engine-b.json" --out "$tmp/c" --open > /dev/null \
  || { echo "FAIL engine: a broken UI opener failed the firing"; exit 1; }

echo "PASS engine-store: indexed firings, identity dedupe, per-node rows, deploy detection, best-effort open"
