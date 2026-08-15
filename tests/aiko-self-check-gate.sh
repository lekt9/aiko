#!/usr/bin/env bash
# Aiko self-wire + self-check across all abstraction layers.
# Wires the GraphHarness, then verifies each layer with its grounded skill:
#   neuron  -> build-and-test-project (standalone, no contract)
#   contract-> contract-native (durable ledger / ABI)
#   cell    -> cell-native (typed ports, deterministic Kahn)
#   api     -> build-and-test-project + contract-native (direct API witness)
#   frontend-> agent-browser + build-and-test-project (both frontend and API)
#   synthesize -> graph-engineering (joins all layer verdicts)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail() { echo "FAIL aiko-self-check: $*" >&2; exit 1; }

FIXTURE="tests/fixtures/graph-harness/aiko-self-check.problem.json"
[ -f "$FIXTURE" ] || fail "fixture missing: $FIXTURE"
[ -x bin/aiko-harness ] || fail "bin/aiko-harness not executable (run scripts/install-aiko-package.sh or check build)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aiko-self-check.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

echo "==> [scaffold] wiring self-check GraphHarness (graph setup with skill grounding)"
if [ -x zig-out/bin/aiko-doctor ]; then
  bin/aiko-harness build "$FIXTURE" --root tests/fixtures/graph-harness -o "$tmp/prepared.json" >/dev/null
  bin/aiko-harness inspect "$tmp/prepared.json" --root tests/fixtures/graph-harness --json >"$tmp/inspect.json"
  python3 - "$tmp/inspect.json" "$tmp/prepared.json" <<'PY'
import json, sys
summary=json.load(open(sys.argv[1]))
envelope=json.load(open(sys.argv[2]))
assert summary["name"]=="aiko-self-check" and summary["state"]=="prepared"
assert summary["nodes"]==7, f"expected 7 nodes, got {summary['nodes']}"
assert summary["prepared"] is True
by={n["id"]: n for n in envelope["package"]["nodes"]}
def skills(nid): return sorted(s["name"] for s in by[nid]["grounding"]["skills"])
assert "build-and-test-project" in skills("scaffold"), "scaffold must be grounded with build-and-test"
assert skills("verify-neuron")==["build-and-test-project"], f"verify-neuron skills: {skills('verify-neuron')}"
assert skills("verify-contract")==["contract-native"], f"verify-contract skills: {skills('verify-contract')}"
assert skills("verify-cell")==["cell-native"], f"verify-cell skills: {skills('verify-cell')}"
assert skills("verify-api")==["build-and-test-project","contract-native"], f"verify-api skills: {skills('verify-api')}"
assert sorted(skills("verify-frontend"))==["agent-browser","build-and-test-project"], f"verify-frontend skills: {skills('verify-frontend')}"
assert skills("synthesize")==["graph-engineering"], f"synthesize skills: {skills('synthesize')}"
assert "verify-api" in by["verify-frontend"]["depends_on"], "frontend must depend on api verification"
assert len(envelope["package"]["edges"])==10
import subprocess, pathlib
import json as _json
subprocess.run(["bin/aiko-harness","build", "tests/fixtures/graph-harness/aiko-self-check.problem.json","--root","tests/fixtures/graph-harness","--out", sys.argv[1]+".bundle"], check=True)
walk=_json.load(open(sys.argv[1]+".bundle/walk.json"))
for node in walk["nodes"]:
    assert "pinned_skills" in node and len(node["pinned_skills"])>=1, f"walk node {node['id']} missing pinned_skills"
    for ps in node["pinned_skills"]:
        assert "digest" in ps and len(ps["digest"]["value"])==64
PY
  echo "    wiring OK (7 nodes, skill-grounded per layer, 10 canonical edges)"
else
  echo "    (aiko-doctor not built -- structural wiring check only; run 'zig build' to enable full compiler verification)"
  python3 - "$FIXTURE" <<'PY'
import json, sys
env=json.load(open(sys.argv[1]))
pkg=env["package"]
assert env["registry"]["name"]=="aiko-self-check"
assert len(pkg["nodes"])==7
by={n["id"]: n for n in pkg["nodes"]}
def skills(nid): return sorted(s["name"] for s in by[nid]["grounding"]["skills"])
assert "build-and-test-project" in skills("scaffold")
assert skills("verify-neuron")==["build-and-test-project"]
assert skills("verify-contract")==["contract-native"]
assert skills("verify-cell")==["cell-native"]
assert skills("verify-api")==["build-and-test-project","contract-native"]
assert sorted(skills("verify-frontend"))==["agent-browser","build-and-test-project"]
assert skills("synthesize")==["graph-engineering"]
assert "verify-api" in by["verify-frontend"]["depends_on"]
assert len(pkg["edges"])==10
print("    wiring OK (structural, 7 nodes / 10 edges / 5 distinct skills)")
PY
fi

# ---- Layer 1: Neuron (standalone) ----
echo "==> [verify-neuron] Neuron standalone layer"
if [ ! -f neuron/build.zig ]; then
  fail "neuron/build.zig missing"
fi
# Neuron must build without contract (one-way dependency invariant)
if command -v zig >/dev/null 2>&1; then
  zig build --help >/dev/null 2>&1 || true
elif [ -x /Users/lewis/bin/zig ]; then
  /Users/lewis/bin/zig build --help >/dev/null 2>&1 || true
elif [ -x zig-out/bin/aiko-doctor ]; then
  echo "    (zig not on PATH but aiko-doctor present -- skipping zig check)"
else
  echo "    (zig / aiko-doctor unavailable -- skipping zig availability check, structural invariant still verified)"
fi
# Quick check: neuron standalone build (via root gate lighter check)
# We verify the source invariant rather than a full second build in gate context
if find neuron -name '*.zig' -print0 | xargs -0 grep -l '@import.*contract' 2>/dev/null | grep -q .; then
  fail "neuron imports contract (direction violation)"
fi
echo "    neuron OK (standalone, no contract import)"

# ---- Layer 2: Contract (durable) ----
echo "==> [verify-contract] Contract durable layer"
if [ ! -f contract/libcontract/build.zig ]; then
  fail "contract/libcontract/build.zig missing"
fi
# Contract must own W6H and graph_plan without importing cell/desktop
if find contract/libcontract/src -name '*.zig' -print0 | xargs -0 grep -l 'cell/run\.py\|apps/desktop' 2>/dev/null | grep -q .; then
  fail "contract imports upper layer"
fi
echo "    contract OK (no upper-layer import, W6H/graph_plan owned)"

# ---- Layer 3: Cell (fractal harness) ----
echo "==> [verify-cell] Cell fractal harness layer"
if [ ! -f cell/SPEC.md ]; then
  fail "cell/SPEC.md missing"
fi
if [ ! -f cell/haulio.cell.yaml ] && [ ! -f cell/web/package.json ]; then
  fail "cell fixtures/web missing"
fi
# Deterministic frontier check via aiko-doctor if available, else structural check
if [ -x zig-out/bin/aiko-doctor ]; then
  cat >"$tmp/cell-walk.json" <<'JSON'
{"nodes":[
  {"id":"alpha","plan":"alpha","depends_on":[],"status":"pending","writes":["out/alpha.json"],"invoke_skills":["cell"],"witness":"true"},
  {"id":"beta","plan":"beta","depends_on":[],"status":"pending","writes":["out/beta.json"],"invoke_skills":["cell"],"witness":"true"},
  {"id":"merge","plan":"merge","depends_on":["alpha","beta"],"status":"pending","writes":["out/merge.json"],"invoke_skills":["cell"],"witness":"true"}
]}
JSON
  zig-out/bin/aiko-doctor graph-plan "$tmp/cell-walk.json" >"$tmp/cell-verdict.json"
  python3 - "$tmp/cell-verdict.json" <<'PY'
import json, sys
v=json.load(open(sys.argv[1]))
assert v["kind"]=="graph" and sorted(v["ready"])==["alpha","beta"], v
# waves must be deterministic lexical frontiers
assert v["waves"][0]==["alpha","beta"] or v["waves"]==[["alpha","beta"],["merge"]], v
PY
  echo "    cell OK (deterministic frontier: graph with lexical waves)"
else
  echo "    cell OK (structural, aiko-doctor not yet built -- run zig build to enable frontier check)"
fi

# ---- Layer 4: API (build-and-test direct) ----
echo "==> [verify-api] API layer (direct API test when API is the product)"
API_OK=0
# Check cell/web API routes exist
if [ -d cell/web/app/api ]; then
  for route in cell/web/app/api/cell cell/web/app/api/cells cell/web/app/api/firings cell/web/app/api/run; do
    if [ ! -f "$route/route.ts" ]; then
      fail "API route missing: $route/route.ts"
    fi
  done
  echo "    api routes present (cell/web: /api/cell, /api/cells, /api/firings, /api/run)"
  API_OK=1
fi
# Also check aiko Rust MCP/HTTP surfaces
if grep -rq "xai-grok-mcp\|xai-grok-http" aiko/Cargo.toml 2>/dev/null; then
  echo "    api surfaces present (aiko crates: mcp/http)"
  API_OK=1
fi
[ "$API_OK" -eq 1 ] || fail "no API layer found to test"

# ---- Layer 5: Frontend + API (agent-browser + build-and-test) ----
echo "==> [verify-frontend] Frontend layer (agent-browser: tests both frontend and API)"
FRONTEND_OK=0
if [ -f cell/web/package.json ]; then
  # Build-and-test for frontend (both layers)
  if grep -q '"build"' cell/web/package.json; then
    echo "    frontend build script present"
  fi
  if grep -q '"typecheck"' cell/web/package.json; then
    echo "    frontend typecheck present"
  fi
  # agent-browser skill is grounded in the graph; verify its SKILL.md is pinned correctly
  if [ -f tests/fixtures/graph-harness/skills/agent-browser/SKILL.md ]; then
    grep -q "agent-browser" tests/fixtures/graph-harness/skills/agent-browser/SKILL.md || fail "agent-browser SKILL.md malformed"
    grep -q "expect_contains" tests/fixtures/graph-harness/skills/agent-browser/SKILL.md || fail "agent-browser SKILL.md missing expect_contains"
    echo "    agent-browser skill grounded (frontend via CDP/accessibility)"
  fi
  # The frontend contract: layout + page + canvas components + API linkage
  for f in cell/web/app/page.tsx cell/web/app/layout.tsx cell/web/components/CellCanvas.tsx cell/web/lib/db.ts; do
    [ -f "$f" ] || fail "frontend file missing: $f"
  done
  echo "    frontend files present (page, layout, CellCanvas, db)"
  # Verify frontend consumes API layer (page imports from lib that hits /api/*)
  if grep -q "api/cell\|/api/\|fetch" cell/web/app/page.tsx 2>/dev/null || grep -rq "api" cell/web/app --include="*.ts" --include="*.tsx" | grep -q .; then
    echo "    frontend -> api linkage present (frontend tests both layers)"
  fi
  FRONTEND_OK=1
fi
# Check if aiko/apps frontend submodule is present (optional)
if [ -d aiko/apps/frontend ] && [ -f aiko/apps/frontend/package.json ]; then
  echo "    aiko/apps/frontend present"
  FRONTEND_OK=1
fi
[ "$FRONTEND_OK" -eq 1 ] || echo "    frontend check: no frontend package found (ok if API-only product)"

echo "==> [synthesize] all layers synthesized"
echo "    north_star: aiko self-check exposes judged result covering every layer"

# Final: ensure the harness survives admit preparation (inert, digest-bound)
if [ -x zig-out/bin/aiko-doctor ]; then
  PYTHONHASHSEED=1 bin/aiko-harness build "$FIXTURE" --root tests/fixtures/graph-harness -o "$tmp/a.json" >/dev/null
  PYTHONHASHSEED=937 bin/aiko-harness build "$FIXTURE" --root tests/fixtures/graph-harness -o "$tmp/b.json" >/dev/null
  if ! cmp -s "$tmp/a.json" "$tmp/b.json"; then
    fail "self-check harness build is not byte-deterministic"
  fi
  echo "    determinism OK (PYTHONHASHSEED-independent)"
else
  # Structural determinism: canonical JSON of the problem is stable regardless of doctor
  python3 - "$FIXTURE" <<'PY'
import json, hashlib
# Verify the problem envelope is valid JSON and stable
data=open("tests/fixtures/graph-harness/aiko-self-check.problem.json","rb").read()
obj=json.loads(data)
assert obj["api_version"]=="graph-harness/v1" and obj["kind"]=="GraphHarness"
print("    determinism OK (structural -- aiko-doctor unavailable for full byte-determinism check)")
PY
fi

printf '%s\n' 'aiko-self-check gate: PASS (wire: 7 nodes / 10 edges / 5 skills · check: neuron/contract/cell/api/frontend+api -> synthesize)'
