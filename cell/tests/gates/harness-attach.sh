#!/bin/bash
# The vertical slice: a SYSTEM, a graph WORKFLOW, an AGENT node inside it, and a
# HARNESS that is the only way the agent reaches the system. The claim under
# test is that attachment is verified against the live system before the agent
# fires — never asserted by the node that wants to use it.
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
cd "$tmp"

# ---- the system: a real server with a health surface and an orders surface ----
mkdir -p sys && cd sys
printf '{"status":"up"}' > health
printf '{"orders":[{"id":"ORD-7","containers":3}]}' > orders
PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
python3 -m http.server "$PORT" --bind 127.0.0.1 > "$tmp/sys.log" 2>&1 &
SYS_PID=$!
cd "$tmp"
trap 'kill $SYS_PID 2>/dev/null || true; rm -rf "$tmp"' EXIT
export SYS_URL="http://127.0.0.1:$PORT"
for _ in $(seq 1 60); do curl -sf "$SYS_URL/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "$SYS_URL/health" >/dev/null || { echo "FAIL harness-attach: fixture system not answering"; exit 1; }

# ---- the agent: reaches the system, cites what it read ----
cat > agent.py <<'PY'
import json, os, urllib.request
def run(inputs, ctx):
    # The agent only ever touches the system through the harness's declared surface.
    body = json.loads(urllib.request.urlopen(os.environ["SYS_URL"] + "/orders").read())
    order = body["orders"][0]
    decision = f"{order['id']}:staff:{order['containers']}"
    # The node's declared write is also what its witness checks — a node that
    # fired without producing it has not settled, whatever its exit status said.
    with open(os.path.join(os.path.dirname(__file__), "roster.json"), "w") as fh:
        json.dump({"decision": decision, "source": "haulio-tms"}, fh, sort_keys=True)
    return {"decision": decision}
PY

harness_cell() { # harness_cell <attach-command>
  cat > agent.cell.yaml <<YAML
apiVersion: cell/v0
kind: Cell
metadata: {name: dispatch-agent, description: agent that staffs an order from the TMS}
spec:
  membrane:
    inputs: {trigger: {schema: string}}
    outputs: {decision: {schema: string}}
    caps: {}
  harness:
    system: haulio-tms
    surface: mcp
    attach: "$1"
    tools: [list_orders]
  policy:
    writes: [roster.json]
    witness: "grep -q ORD-7 roster.json"
  run: {kind: python, entry: ./agent.py}
YAML
}
cat > graph.cell.yaml <<'YAML'
apiVersion: cell/v0
kind: Cell
metadata: {name: dispatch-flow, description: workflow whose agent reaches a system through a harness}
spec:
  membrane:
    inputs: {trigger: {schema: string}}
    outputs: {decision: {schema: string}}
    caps: {}
  organelles:
    - {name: agent, cell: ./agent.cell.yaml}
  wiring:
    - {from: membrane.trigger, to: agent.trigger}
    - {from: agent.decision, to: membrane.decision}
YAML
echo '{"trigger":"go"}' > in.json

# 1) system reachable -> harness attaches, agent fires, attachment is recorded
harness_cell "curl -sf \$SYS_URL/health > /dev/null"
python3 "$CELL/run.py" run graph.cell.yaml --inputs in.json --out out1 >log1 2>&1 \
  || { echo "FAIL harness-attach: agent refused while its system was up"; cat log1; exit 1; }
python3 - <<'PY'
import json
m = json.load(open("out1/_work_agent/manifest.json"))
h = m.get("harness")
assert h, "no harness recorded — a downstream reader cannot tell which system this came from"
assert h["system"] == "haulio-tms" and h["surface"] == "mcp" and h["tools"] == ["list_orders"], h
assert h["attached"] is True and h["exit"] == 0, h
assert m["witness"]["settled"] is True, m.get("witness")
PY
grep -q "ORD-7" roster.json || { echo "FAIL harness-attach: agent's declared write does not cite what it read from the system"; exit 1; }

# 2) THE refusal: system down -> the agent must not fire AT ALL. A node that fired
#    against an absent system still hands a value downstream, and every consumer
#    then treats that value as if the system had produced it.
rm -f roster.json
kill $SYS_PID 2>/dev/null || true
wait $SYS_PID 2>/dev/null || true
if python3 "$CELL/run.py" run graph.cell.yaml --inputs in.json --out out2 >log2 2>&1; then
  echo "FAIL harness-attach: agent ran green against a system that was down"; exit 1
fi
grep -q "did not attach" log2 || { echo "FAIL harness-attach: refused, but not for a failed attachment"; cat log2; exit 1; }
if [ -f roster.json ]; then echo "FAIL harness-attach: agent fired and wrote its roster though its harness never attached"; exit 1; fi
if [ -f out2/manifest.json ]; then echo "FAIL harness-attach: unattached run still produced a root manifest"; exit 1; fi

# 3) the declaration fails closed — an unverifiable or empty harness is not a harness
bad() { if python3 "$CELL/run.py" build agent.cell.yaml >/dev/null 2>&1; then echo "FAIL harness-attach: $1"; exit 1; fi; }
harness_cell "curl -sf \$SYS_URL/health"
python3 - <<'PY'
import pathlib
p = pathlib.Path("agent.cell.yaml"); t = p.read_text()
pathlib.Path("_ok.yaml").write_text(t)
p.write_text(t.replace('    attach: "curl -sf $SYS_URL/health"\n', ''))
PY
bad "harness with no attach probe admitted — attachment would be self-asserted"
python3 -c "
import pathlib; t=pathlib.Path('_ok.yaml').read_text()
pathlib.Path('agent.cell.yaml').write_text(t.replace('tools: [list_orders]','tools: []'))"
bad "harness exposing no tools admitted"
python3 -c "
import pathlib; t=pathlib.Path('_ok.yaml').read_text()
pathlib.Path('agent.cell.yaml').write_text(t.replace('surface: mcp','surface: telepathy'))"
bad "harness with an unknown surface admitted"
python3 -c "
import pathlib; t=pathlib.Path('_ok.yaml').read_text()
pathlib.Path('agent.cell.yaml').write_text(t.replace('tools: [list_orders]','tools: [list_orders]\n    trusted: true'))"
bad "unknown harness field admitted"

echo "PASS harness-attach: agent reaches its system only through a harness verified live before it fires"
