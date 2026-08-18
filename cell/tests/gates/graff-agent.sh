#!/bin/bash
# codegraff (justrach/codegraff) as an agent inside the graph. The claim under
# test is the connection, not the model: the agent node reaches its target
# system only through an MCP server registered with graff, and the engine
# verifies BOTH halves of that before the agent is allowed to fire.
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; cd "$tmp"

GRAFF="$(command -v graff || command -v codegraff || true)"
if [ -z "$GRAFF" ]; then
  echo "SKIP graff-agent: codegraff not installed (curl -fsSL https://github.com/justrach/codegraff/releases/latest/download/install.sh | sh)"
  exit 0
fi

# 1) the primitive is a valid cell and declares a harness the engine understands
python3 "$CELL/run.py" build "$CELL/primitives/graff-agent.cell.yaml" >/dev/null 2>&1 \
  || { echo "FAIL graff-agent: primitive rejected by the engine"; exit 1; }
python3 - <<PY
import json, subprocess, sys
d = json.loads(subprocess.run([sys.executable, "$CELL/run.py", "inspect",
    "$CELL/primitives/graff-agent.cell.yaml"], capture_output=True, text=True, check=True).stdout)
h = d["harness"]
assert h["surface"] == "mcp", h
assert h["tools"], "an agent harness that exposes no operation is not a connection"
assert d["writes"] == [] and d["witness"] is None, "primitive must not pin a caller's write set"
PY

# 2) graff really answers the probe's first half — this is the live binary, not a stub
"$GRAFF" --version >/dev/null 2>&1 || { echo "FAIL graff-agent: graff on PATH does not answer --version"; exit 1; }
"$GRAFF" --schema 2>/dev/null | python3 -c "
import json,sys
s = json.load(sys.stdin)
assert s.get('harness'), 'graff --schema did not declare a harness'
assert s.get('providers'), 'graff --schema declared no providers'
" || { echo "FAIL graff-agent: graff does not publish a machine-readable interface to derive a harness from"; exit 1; }

# 3) THE refusal — no MCP server named `mcp-server` is registered, so the agent
#    must not fire. A probe that passed here would be certifying a reach the
#    agent does not have.
cat > flow.cell.yaml <<'YAML'
apiVersion: cell/v0
kind: Cell
metadata: {name: graff-flow, description: workflow whose agent is graff}
spec:
  membrane:
    inputs: {task: {schema: string}, system: {schema: string}}
    outputs: {answer: {schema: string}}
    caps: {exec: true}
  organelles:
    - {name: agent, cell: ./graff-agent.cell.yaml}
  wiring:
    - {from: membrane.task, to: agent.task}
    - {from: membrane.system, to: agent.system}
    - {from: agent.answer, to: membrane.answer}
YAML
cp "$CELL/primitives/graff-agent.cell.yaml" graff-agent.cell.yaml
mkdir -p neurons && cp "$CELL/primitives/neurons/graff_agent.exec.py" neurons/
echo '{"task":"list the open orders","system":"haulio-tms"}' > in.json
if python3 "$CELL/run.py" run flow.cell.yaml --inputs in.json --out out1 >log1 2>&1; then
  echo "FAIL graff-agent: agent fired with no MCP server registered — it claimed a reach it lacks"; exit 1
fi
grep -q "did not attach" log1 || { echo "FAIL graff-agent: refused, but not for a failed attachment"; cat log1; exit 1; }

# 4) the probe must not pass on an EMPTY system name. `grep -q ""` matches every
#    line, so a harness whose name never reached the probe would attach to
#    anything that printed output — the exact way this check fails open.
python3 - <<'PY'
import pathlib
p = pathlib.Path("graff-agent.cell.yaml"); t = p.read_text()
p.write_text(t.replace("    system: mcp-server\n", "    system: \"\"\n"))
PY
if python3 "$CELL/run.py" build graff-agent.cell.yaml >/dev/null 2>&1; then
  echo "FAIL graff-agent: harness with an empty system name admitted — its probe would match anything"; exit 1
fi

# 5) the control that makes step 3 mean something: the SAME probe must go green
#    once the server is registered. A probe that is always red refuses correctly
#    for the wrong reason and would keep refusing after a real attachment.
probe='graff --version >/dev/null && graff mcp 2>&1 | grep -q "$CELL_HARNESS_SYSTEM"'
CELL_HARNESS_SYSTEM=mcp-server sh -c "$probe" \
  && { echo "FAIL graff-agent: probe passed before any server was registered"; exit 1; }
"$GRAFF" mcp add mcp-server -- /bin/echo hello >/dev/null 2>&1 \
  || { echo "FAIL graff-agent: could not register a fixture MCP server with graff"; exit 1; }
CELL_HARNESS_SYSTEM=mcp-server sh -c "$probe" \
  || { echo "FAIL graff-agent: probe still red after the server was registered — it does not discriminate"; "$GRAFF" mcp; exit 1; }

echo "PASS graff-agent: codegraff is an admitted agent node whose reach is verified, not asserted"
