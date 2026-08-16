#!/usr/bin/env bash
# The installed Smithers control limb is a pinned, closed artifact. It remains
# operational without its checkout and refuses drift without sacrificing the
# last known-good version during an update.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOW="$ROOT/aiko-flow"
AIKO_BIN="${AIKO_BIN:-$ROOT/aiko/target/debug/aiko}"
[ -x "$AIKO_BIN" ] || { echo "FAIL smithers-control-package: missing Aiko binary" >&2; exit 1; }
command -v bun >/dev/null
command -v node >/dev/null
python3 "$ROOT/scripts/aiko-packages.py" check >/dev/null

tmp=$(mktemp -d "${TMPDIR:-/tmp}/smithers-control-package.XXXXXX")
moved="$ROOT/.aiko-flow.control-package.$$"
cleanup() {
  rc=$?
  if [ -d "$moved" ] && [ ! -e "$FLOW" ]; then mv "$moved" "$FLOW"; fi
  rm -rf "$tmp"
  exit "$rc"
}
trap cleanup EXIT HUP INT TERM
export HOME="$tmp/empty-home"
export AIKO_HOME="$HOME/.aiko"
export GROK_HOME="$HOME/.grok"
unset AIKO_SMITHERS_RUNTIME NODE_PATH CLAUDE_PLUGIN_ROOT GROK_PLUGIN_ROOT
mkdir -p "$HOME" "$tmp/cwd" "$tmp/poison"

python3 "$ROOT/scripts/aiko-packages.py" install --with-control --aiko-bin "$AIKO_BIN" >"$tmp/install.out"
"$AIKO_BIN" plugin list --json >"$tmp/plugins.json"
plugin_path=$(python3 -c 'import json,sys; print(next(p["path"] for p in json.load(open(sys.argv[1])) if p["name"]=="smithers"))' "$tmp/plugins.json")
control_current="$AIKO_HOME/packages/control/current"
[ -f "$plugin_path/.aiko-control-integrity.json" ]
[ -f "$plugin_path/runtime/bun.lock" ]
[ -L "$control_current" ]
python3 - "$ROOT/sdk/registry/stack.lock.json" "$FLOW/aiko-package.json" "$plugin_path/.aiko-control-integrity.json" <<'PY'
import hashlib, json, sys
lock, manifest, receipt = (json.load(open(p)) for p in sys.argv[1:])
pin = lock["packages"]["control"]
assert manifest["version"] == pin["version"] == receipt["version"]
assert manifest["abi"] == pin["abi"] == receipt["abi"] == "smithers-control/v1"
assert manifest["dependency_lock_sha256"] == pin["dependency_lock_sha256"] == receipt["dependency_lock_sha256"]
assert {"ContractCell", "createContractDriver", "ContractLifecycleClient", "createExecutionRecovery", "recoveryDecision"} <= set(manifest["exports"])
print("ok version ABI dependency lock and public surface are pinned")
PY

# Make the producing checkout unavailable and clear every development resolver.
mv "$FLOW" "$moved"
export GROK_PLUGIN_ROOT="$plugin_path"
unset AIKO_SMITHERS_RUNTIME NODE_PATH CLAUDE_PLUGIN_ROOT
(
  cd "$tmp/cwd"
  node "$plugin_path/bin/smithers.mjs" --help >"$tmp/cli.out" 2>"$tmp/cli.err"
)
grep -Eqi 'smithers|workflow|usage' "$tmp/cli.out"

# Boot the installed Gateway and drive a tiny ContractCell through the public
# driver/lifecycle/recovery exports. No workspace link or checkout participates.
cat >"$tmp/installed-surface.mjs" <<'JS'
import { pathToFileURL } from "node:url";
const root = process.env.GROK_PLUGIN_ROOT + "/runtime";
const api = await import(pathToFileURL(root + "/packages/smithers/src/index.js"));
for (const name of ["ContractCell", "createContractDriver", "ContractLifecycleClient", "createExecutionRecovery", "recoveryDecision", "Gateway"]) {
  if (typeof api[name] !== "function") throw new Error(`missing installed export ${name}`);
}
const gateway = new api.Gateway({ heartbeatMs: 60000, outOfProcessEventBridge: false });
if (!gateway || !(gateway.workflows instanceof Map)) throw new Error("installed Gateway did not boot");
const calls = [];
const lifecycle = new api.ContractLifecycleClient({ rpcRaw: async (method, params) => (calls.push({ method, params }), { method, params }) });
await lifecycle.pause("run-1", 3);
if (calls[0]?.method !== "contractLifecycle.pause" || calls[0]?.params?.expectedGeneration !== 3) throw new Error("lifecycle client did not dispatch");
const driver = api.createContractDriver({
  owner: "package-gate",
  contract: { readFrontier: async () => [] },
  graphHarnessCell: async () => ({ effects: [] }),
});
const element = api.ContractCell({ id: "package-cell", driver, signal: { commitOrdinal: 1 } });
const result = await element.props.children({});
if (!result?.reread || !Array.isArray(result.results) || result.results.length !== 0) throw new Error("ContractCell did not traverse the installed driver");
const decision = api.recoveryDecision("retryable", { tenantId: "t", rootId: "r", operationId: "op", attempt: 1 });
if (!decision || typeof decision.action !== "string") throw new Error("recovery policy did not boot");
console.log("ok installed Gateway ContractCell lifecycle and recovery surface booted");
JS
(
  cd "$tmp/cwd"
  bun "$tmp/installed-surface.mjs" >"$tmp/surface.out"
)

# Drive real JSON-RPC through the installed MCP launcher.
(
  cd "$tmp/cwd"
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"control-package-gate","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    | node "$plugin_path/bin/smithers.mjs" --mcp >"$tmp/mcp.jsonl" 2>"$tmp/mcp.err"
)
python3 - "$tmp/mcp.jsonl" <<'PY'
import json, sys
rows = {row.get("id"): row for line in open(sys.argv[1]) if (row := json.loads(line))}
assert rows[1]["result"]["serverInfo"]["name"] == "smithers"
assert {"list_workflows", "run_workflow", "get_run"} <= {x["name"] for x in rows[2]["result"]["tools"]}
print("ok installed MCP booted")
PY

# Tamper and version/ABI drift fail before CLI execution. Restore exact bytes so
# the same artifact proves recovery, rather than silently installing another.
pinned="$plugin_path/runtime/packages/smithers/src/index.js"
cp "$pinned" "$tmp/index.js"
printf '\n// tampered\n' >>"$pinned"
if node "$plugin_path/bin/smithers.mjs" --help >"$tmp/tamper.out" 2>"$tmp/tamper.err"; then
  echo "FAIL smithers-control-package: modified control bytes were accepted" >&2; exit 1
fi
grep -q 'pinned file was modified' "$tmp/tamper.err"
cp "$tmp/index.js" "$pinned"
cp "$plugin_path/.aiko-control-integrity.json" "$tmp/receipt.json"
python3 - "$plugin_path/.aiko-control-integrity.json" <<'PY'
import json, sys
p=sys.argv[1]; d=json.load(open(p)); d["abi"]="smithers-control/v999"; open(p,"w").write(json.dumps(d))
PY
if node "$plugin_path/bin/smithers.mjs" --help >"$tmp/drift.out" 2>"$tmp/drift.err"; then
  echo "FAIL smithers-control-package: ABI drift was accepted" >&2; exit 1
fi
grep -Eq 'receipt digest mismatch|version/ABI receipt is incompatible' "$tmp/drift.err"
cp "$tmp/receipt.json" "$plugin_path/.aiko-control-integrity.json"
node "$plugin_path/bin/smithers.mjs" --help >/dev/null

# Restore the checkout only after all installed-only checks are complete.
mv "$moved" "$FLOW"
unset GROK_PLUGIN_ROOT

# A failed update stages and validates first. It cannot replace current or make
# the previous package unbootable.
before_target=$(readlink "$control_current")
before_digest=$(shasum -a 256 "$control_current/.aiko-control-integrity.json" | awk '{print $1}')
cat >"$tmp/poison/aiko" <<'SH'
#!/bin/sh
exit 93
SH
chmod 755 "$tmp/poison/aiko"
if python3 "$ROOT/scripts/aiko-packages.py" update --with-control --aiko-bin "$tmp/poison/aiko" >"$tmp/update.out" 2>"$tmp/update.err"; then
  echo "FAIL smithers-control-package: deliberately failed update succeeded" >&2; exit 1
fi
[ "$(readlink "$control_current")" = "$before_target" ]
[ "$(shasum -a 256 "$control_current/.aiko-control-integrity.json" | awk '{print $1}')" = "$before_digest" ]
export GROK_PLUGIN_ROOT="$control_current"
(
  cd "$tmp/cwd"
  node "$control_current/bin/smithers.mjs" --help >/dev/null
)

echo "PASS smithers-control-package-gate"
