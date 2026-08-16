#!/usr/bin/env bash
# Installed Smithers is a closed, relocatable runtime: neither CLI nor MCP may
# read its producing checkout or ask bunx/the network for missing dependencies.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOW="$ROOT/aiko-flow"
AIKO_BIN="${AIKO_BIN:-$ROOT/aiko/target/debug/aiko}"
[ -x "$AIKO_BIN" ] || { echo "FAIL smithers-relocatable-runtime: Aiko binary missing: $AIKO_BIN" >&2; exit 1; }
[ -d "$FLOW/node_modules/.bun" ] || { echo "FAIL smithers-relocatable-runtime: Smithers dependency store missing" >&2; exit 1; }
BUN="$(command -v bun)"
NODE="$(command -v node)"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/smithers-relocation.XXXXXX")
moved="$ROOT/.aiko-flow.relocation.$$"
cleanup() {
  rc=$?
  if [ -d "$moved" ]; then
    if [ -e "$FLOW" ]; then
      echo "FAIL smithers-relocatable-runtime: cannot restore $FLOW because it was recreated" >&2
      rc=1
    else
      mv "$moved" "$FLOW"
    fi
  fi
  if [ "${KEEP_SMITHERS_RELOCATION_TMP:-0}" = 1 ]; then echo "kept $tmp" >&2; else rm -rf "$tmp"; fi
  exit "$rc"
}
trap cleanup EXIT HUP INT TERM
[ ! -e "$moved" ] || { echo "FAIL smithers-relocatable-runtime: stale relocation path: $moved" >&2; exit 1; }

# Installation has no pre-existing user state. It must materialize the runtime
# and dependency closure before the checkout becomes unavailable.
export HOME="$tmp/home"
export AIKO_HOME="$HOME/.aiko"
export GROK_HOME="$HOME/.grok"
mkdir -p "$HOME" "$tmp/empty" "$tmp/poison"
python3 "$ROOT/scripts/aiko-packages.py" install --with-control --aiko-bin "$AIKO_BIN" > "$tmp/install.txt"
"$AIKO_BIN" plugin list --json > "$tmp/plugins.json"
plugin_path=$(python3 -c 'import json,sys; print(next(p["path"] for p in json.load(open(sys.argv[1])) if p["name"]=="smithers"))' "$tmp/plugins.json")
[ -f "$plugin_path/runtime/apps/cli/src/index.js" ] || { echo "FAIL smithers-relocatable-runtime: packaged CLI missing" >&2; exit 1; }
[ -d "$plugin_path/runtime/node_modules/.bun" ] || { echo "FAIL smithers-relocatable-runtime: packaged dependency store missing" >&2; exit 1; }
[ ! -L "$plugin_path/runtime" ] || { echo "FAIL smithers-relocatable-runtime: runtime is a symlink" >&2; exit 1; }
! grep -q 'AIKO_SMITHERS_RUNTIME' "$plugin_path/.mcp.json" || { echo "FAIL smithers-relocatable-runtime: installed MCP embeds a source override" >&2; exit 1; }
python3 - "$plugin_path/runtime" <<'PY'
from pathlib import Path
import json, sys
root = Path(sys.argv[1]).resolve()
links = json.loads((root / ".aiko-node-links.json").read_text())
assert links, "dependency topology is empty"
for row in links:
    link = root / row["path"]
    target = (link.parent / row["target"]).resolve(strict=False)
    assert target.is_relative_to(root), (link, target)
assert (root / "node_modules/.bun").is_dir()
print("ok packaged dependency bytes and closed topology are present")
PY

# Make the producing checkout mechanically unavailable. The trap restores it on
# every exit path. A poisoned bunx turns any registry/network fallback red.
mv "$FLOW" "$moved"
cat > "$tmp/poison/bunx" <<'SH'
#!/bin/sh
echo "bunx/network fallback is forbidden for an installed Smithers runtime" >&2
exit 97
SH
chmod 755 "$tmp/poison/bunx"
ln -s "$BUN" "$tmp/poison/bun"
ln -s "$NODE" "$tmp/poison/node"
export PATH="$tmp/poison:/usr/bin:/bin"
unset AIKO_SMITHERS_RUNTIME NODE_PATH CLAUDE_PLUGIN_ROOT
export GROK_PLUGIN_ROOT="$plugin_path"

# Resolve and boot the actual installed CLI from an unrelated cwd.
(
  cd "$tmp/empty"
  node "$plugin_path/bin/smithers.mjs" --help > "$tmp/cli.out" 2> "$tmp/cli.err"
)
grep -qi 'smithers\|workflow\|usage' "$tmp/cli.out" || { echo "FAIL smithers-relocatable-runtime: installed CLI did not boot" >&2; cat "$tmp/cli.err" >&2; exit 1; }
python3 - "$plugin_path/runtime" <<'PY'
from pathlib import Path
import json, sys
root = Path(sys.argv[1]).resolve()
for row in json.loads((root / ".aiko-node-links.json").read_text()):
    link = root / row["path"]
    assert link.is_symlink(), link
    assert link.resolve().is_relative_to(root), link
print("ok installed resolver reconstructed only packaged dependency links")
PY

# Drive JSON-RPC through the installed MCP launcher, not a source adapter.
(
  cd "$tmp/empty"
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"relocation-gate","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    | node "$plugin_path/bin/smithers.mjs" --mcp > "$tmp/mcp.jsonl" 2> "$tmp/mcp.err"
)
python3 - "$tmp/mcp.jsonl" <<'PY'
import json, sys
rows = {row.get("id"): row for line in open(sys.argv[1]) if (row := json.loads(line))}
assert rows[1]["result"]["serverInfo"]["name"] == "smithers", rows
names = {tool["name"] for tool in rows[2]["result"]["tools"]}
assert {"list_workflows", "run_workflow", "get_run", "watch_run"} <= names, names
print("ok installed CLI and MCP booted after checkout relocation")
PY

echo "PASS smithers-relocatable-runtime-gate"
