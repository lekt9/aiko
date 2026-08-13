#!/usr/bin/env bash
# Aiko loads Smithers as a native plugin limb, Smithers schedules a Cell, and
# resume reads durable state without refiring the settled Cell.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOW="$ROOT/aiko-flow"
AIKO_BIN="${AIKO_BIN:-$ROOT/aiko/target/debug/aiko}"
[ -x "$AIKO_BIN" ] || { echo "FAIL: Aiko binary missing: $AIKO_BIN" >&2; exit 1; }
[ -d "$FLOW/node_modules" ] || { echo "FAIL: Smithers dependencies missing; run (cd aiko-flow && bun install --frozen-lockfile)" >&2; exit 1; }
[ -f "$FLOW/packages/gateway-client/src/data/createSmithersCollections.ts" ] || { echo "FAIL: Smithers control source is incomplete" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export AIKO_HOME="$tmp/aiko-home"
export GROK_HOME="$AIKO_HOME/.grok"

python3 "$ROOT/scripts/aiko-packages.py" install --with-control --aiko-bin "$AIKO_BIN" > "$tmp/install.txt"
"$AIKO_BIN" plugin list --json > "$tmp/plugins.json"
"$AIKO_BIN" inspect --json > "$tmp/inspect.json"
python3 - "$tmp/plugins.json" "$tmp/inspect.json" <<'PY'
import json,sys
plugins=json.load(open(sys.argv[1])); inspect=json.load(open(sys.argv[2]))
assert any(p["name"]=="smithers" and p["status"]=="installed" for p in plugins)
plug=next(p for p in inspect["plugins"] if p["name"]=="smithers")
assert plug["enabled"] and plug["provides"]["skills"]>=1 and plug["provides"]["mcpServers"]==1
mcp=next(s for s in inspect["mcpServers"] if s["name"]=="smithers")
assert mcp["source"]["type"]=="plugin" and mcp["source"]["plugin_name"]=="smithers"
print("ok Aiko discovered the Smithers skill + MCP limb")
PY

# Drive the installed plugin's MCP launcher, not a direct adapter import.
plugin_path=$(python3 -c 'import json,sys; print(next(p["path"] for p in json.load(open(sys.argv[1])) if p["name"]=="smithers"))' "$tmp/plugins.json")
[ -f "$plugin_path/runtime/apps/cli/src/index.js" ] || { echo "FAIL: installed control runtime missing" >&2; exit 1; }
[ ! -L "$plugin_path/runtime" ] || { echo "FAIL: control runtime must be installed bytes, not a source symlink" >&2; exit 1; }
export GROK_PLUGIN_ROOT="$plugin_path"
export AIKO_SMITHERS_RUNTIME="$FLOW"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"aiko-gate","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node "$plugin_path/bin/smithers.mjs" --mcp > "$tmp/mcp.jsonl" 2> "$tmp/mcp.err"
python3 - "$tmp/mcp.jsonl" <<'PY'
import json,sys
rows={r.get("id"):r for line in open(sys.argv[1]) if (r:=json.loads(line))}
assert rows[1]["result"]["serverInfo"]["name"]=="smithers"
tools={t["name"] for t in rows[2]["result"]["tools"]}
assert {"list_workflows","run_workflow","get_run","watch_run"} <= tools, tools
print("ok installed Smithers MCP booted through Aiko's plugin limb")
PY

run_id="aiko-smithers-limb-$RANDOM-$$"
input='{"tenant":"synthetic","origin":"https://ops.invalid","account_id":"aiko","role":"fde","outcome":"extend Aiko to an operational seat","seatAgent":false}'
(
  cd "$FLOW"
  bun apps/cli/src/index.js up .smithers/workflows/deploy-aiko.tsx \
    --run-id "$run_id" --input "$input" --format json \
    --no-report --no-monitor --no-post-failure > "$tmp/run.json"
)
python3 - "$tmp/run.json" "$FLOW/smithers.db" "$run_id" <<'PY'
import json,sqlite3,sys
run=json.load(open(sys.argv[1])); assert run["status"]=="finished",run
row=run["output"][0]
assert row["agent"]=="aiko" and row["handle_id"].startswith("cred:") and len(row["workflow_digest"])==64
con=sqlite3.connect(sys.argv[2])
state=con.execute("select status from _smithers_runs where run_id=?",(sys.argv[3],)).fetchone()
assert state==("finished",),state
handoff=con.execute("select agent,role,handle_id,_cell from handoff where run_id=? and node_id='wire'",(sys.argv[3],)).fetchone()
assert handoff[:3]==("aiko","fde",row["handle_id"]),handoff
cell=json.loads(handoff[3]); assert len(cell["digest"])==64 and len(cell["manifest"]["produced_by"])==64
attempts=con.execute("select node_id,attempt,state from _smithers_attempts where run_id=? order by node_id",(sys.argv[3],)).fetchall()
assert attempts==[("output",1,"finished"),("wire",1,"finished")],attempts
print("ok Smithers durably scheduled the native Cell and retained provenance")
PY

(
  cd "$FLOW"
  bun apps/cli/src/index.js up .smithers/workflows/deploy-aiko.tsx \
    --resume "$run_id" --format json --no-report --no-monitor --no-post-failure > "$tmp/resume.json"
)
python3 - "$tmp/resume.json" "$FLOW/smithers.db" "$run_id" <<'PY'
import json,sqlite3,sys
assert json.load(open(sys.argv[1]))["status"]=="finished"
con=sqlite3.connect(sys.argv[2])
attempts=con.execute("select node_id,attempt,state from _smithers_attempts where run_id=? order by node_id",(sys.argv[3],)).fetchall()
assert attempts==[("output",1,"finished"),("wire",1,"finished")],attempts
print("ok restart/resume did not refire the settled Cell")
PY

echo "PASS aiko-smithers-limb-gate"
