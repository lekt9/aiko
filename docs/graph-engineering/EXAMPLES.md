# Runnable graph-engineering examples

Run these commands from the Aiko repository root. They use temporary directories and do not modify repository state.

## Setup

```sh
zig build
DOCTOR=./zig-out/bin/aiko-doctor
```

`graph-plan` prints JSON. It analyzes only; it does not execute a node, run its witness, or settle Contract state.

## 1. A chain

The second node really reads the first node’s product, so splitting it buys nothing.

```sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/chain.json" <<'JSON'
{"nodes":[
 {"id":"collect","plan":"collect input","depends_on":[],"status":"pending","writes":["out/input.json"],
  "invoke_skills":["cell"],"witness":"test -s out/input.json"},
 {"id":"render","plan":"render collected input","depends_on":["collect"],"status":"pending","writes":["out/report.md"],
  "invoke_skills":["copywriting"],"witness":"test -s out/report.md"}
]}
JSON
"$DOCTOR" graph-plan "$tmp/chain.json" >"$tmp/verdict.json"
python3 - "$tmp/verdict.json" <<'PY'
import json, sys
v=json.load(open(sys.argv[1]))
assert v["kind"] == "chain"
assert v["ready"] == ["collect"]
assert v["waves"] == [["collect"], ["render"]]
print("chain, not a graph:", v["ready"])
PY
```

## 2. Independent fan-out and join

The roots do not read each other. Synthesis depends on both.

```sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/fanout.json" <<'JSON'
{"nodes":[
 {"id":"right","plan":"right branch","depends_on":[],"status":"pending","writes":["work/right.json"],"invoke_skills":["cell"],"witness":"true"},
 {"id":"join","plan":"join products","depends_on":["left","right"],"status":"pending","writes":["out/joined.json"],"invoke_skills":["cell"],"witness":"true"},
 {"id":"left","plan":"left branch","depends_on":[],"status":"pending","writes":["work/left.json"],"invoke_skills":["cell"],"witness":"true"}
]}
JSON
"$DOCTOR" graph-plan "$tmp/fanout.json" >"$tmp/verdict.json"
python3 - "$tmp/verdict.json" <<'PY'
import json, sys
v=json.load(open(sys.argv[1]))
assert v["kind"] == "graph"
assert v["ready"] == ["left", "right"]       # lexical, not JSON order
assert v["waves"] == [["left", "right"], ["join"]]
assert v["write_collisions"] == []
print("safe declared frontier:", *v["ready"])
PY
```

To execute a real typed Cell frontier with two Python siblings, lexical serial execution, a canonical join, and Merkle movement after child-code mutation:

```sh
bash cell/tests/gates/frontier-runtime.sh
```

The gate also proves unknown ports and undeclared root inputs are refused. The multi-node frontier demonstrates topological readiness, not concurrency: Python/exec caps are audit metadata, so siblings serialize until a kind has portable, witnessed mechanical confinement.

## 3. A write collision

No dependency edge exists, but both nodes declare overlapping scopes. The planner reports the collision and still returns both ready; launch policy must isolate/serialize them.

```sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/collision.json" <<'JSON'
{"nodes":[
 {"id":"broad","plan":"write source tree","depends_on":[],"status":"pending","writes":["src/"],"invoke_skills":["cell"],"witness":"true"},
 {"id":"file","plan":"write one source file","depends_on":[],"status":"pending","writes":["src/ui/app.ts"],"invoke_skills":["cell"],"witness":"true"}
]}
JSON
"$DOCTOR" graph-plan "$tmp/collision.json" >"$tmp/verdict.json"
python3 - "$tmp/verdict.json" <<'PY'
import json, sys
v=json.load(open(sys.argv[1]))
assert v["ready"] == ["broad", "file"]
assert v["write_collisions"] == [
 {"a":"broad","b":"file","shared":["src/ <-> src/ui/app.ts"]}
]
print("reported, not auto-isolated:", v["write_collisions"])
PY
```

Correct remedies are separate worktrees plus a named reconcile node, or an explicit dependency that serializes the writes. Renaming the declaration while retaining the actual collision is not a remedy.

## 4. Cycle refusal

A cycle is a structured refusal: the command can return a JSON verdict, but there is no executable frontier anywhere in it.

```sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/cycle.json" <<'JSON'
{"nodes":[
 {"id":"a","depends_on":["b"],"status":"pending","writes":[],"invoke_skills":["cell"],"witness":"true"},
 {"id":"b","depends_on":["a"],"status":"pending","writes":[],"invoke_skills":["cell"],"witness":"true"}
]}
JSON
"$DOCTOR" graph-plan "$tmp/cycle.json" >"$tmp/verdict.json"
python3 - "$tmp/verdict.json" <<'PY'
import json, sys
v=json.load(open(sys.argv[1]))
assert v["ready"] == [] and v["waves"] == []
assert v["cycle_list"] == v["cycles"] == ["a", "b"]
print("cycle refused:", v["cycle_list"])
PY
```

Unknown dependencies behave the same way:

```sh
printf '%s\n' '{"nodes":[{"id":"a","depends_on":["missing"],"status":"pending"}]}' >"$tmp/unknown.json"
"$DOCTOR" graph-plan "$tmp/unknown.json" | python3 -c \
 'import json,sys; v=json.load(sys.stdin); assert v["ready"]==[]; assert v["unknown_dependencies"]==[{"node":"a","dependency":"missing"}]; print(v["unknown_dependencies"])'
```

Malformed shape is a process-level refusal with structured output:

```sh
printf '%s\n' '{"nodes":{}}' >"$tmp/bad.json"
if "$DOCTOR" graph-plan "$tmp/bad.json" >"$tmp/bad.out"; then exit 1; fi
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))=={"error":"invalid_walk"}' "$tmp/bad.out"
```

## 5. Grounding and gating gaps

Presence, not truth, is checked here. An honest capability gap counts as grounding; a witness counts as gating only when non-empty.

```sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/gaps.json" <<'JSON'
{"nodes":[
 {"id":"none","plan":"unbounded freestyle","depends_on":[],"status":"pending","writes":[]},
 {"id":"method-only","plan":"has method, no check","depends_on":[],"status":"pending","writes":[],"invoke_skills":["cell"]},
 {"id":"gate-only","plan":"has check, no method","depends_on":[],"status":"pending","writes":[],"witness":"true"},
 {"id":"honest-gap","plan":"method unavailable","depends_on":[],"status":"pending","writes":[],"capability_gaps":["special-device"],"witness":"true"}
]}
JSON
"$DOCTOR" graph-plan "$tmp/gaps.json" >"$tmp/verdict.json"
python3 - "$tmp/verdict.json" <<'PY'
import json, sys
v=json.load(open(sys.argv[1]))
assert v["grounding_gaps"] == v["ungrounded"] == ["gate-only", "none"]
assert v["gating_gaps"] == v["ungated"] == ["method-only", "none"]
assert v["ready"] == ["gate-only", "honest-gap", "method-only", "none"]
print("grounding:", v["grounding_gaps"], "gating:", v["gating_gaps"])
PY
```

The last assertion is load-bearing documentation: current Contract analysis **reports** these gaps but does not block the frontier. A safe launcher closes them before execution. It must also resolve `honest-gap`; reporting a capability gap is honest grounding, not a working capability.

## 6. Reactive invalidation

The standalone Neuron acceptance creates committed derivations, moves cited inputs/occurrences, and proves the three redrive routes through durable state:

```sh
bash neuron/tests/redrive-gate.sh
```

To inspect the live, redacted provenance projection—including committed `cites` and `produces` edges, loopback protection, compaction behavior, and another-process commits—run:

```sh
bash neuron/tests/observe-live-gate.sh
```

The observer shows facts from the journal. It does not classify effect safety or choose a redrive case because it never opens the topology.

## 7. Cell case-3 compensation

This example runs `cell/system/redrive.cell.yaml` directly. The first product is stale. The second was already read back as sent, so it is removed from `stale` and becomes compensation.

```sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/in.json" <<'JSON'
{"manifests":{"notice":"new123abc456abc1"},
 "prior":{"notice":"old123abc456abc1"},
 "prior_sent":["old123abc456abc1"]}
JSON
python3 cell/run.py run cell/system/redrive.cell.yaml \
  --inputs "$tmp/in.json" --out "$tmp/out" >/dev/null
python3 - "$tmp/out/stale.json" "$tmp/out/compensation.json" <<'PY'
import json, sys
stale=json.load(open(sys.argv[1])); compensation=json.load(open(sys.argv[2]))
assert not any("new123abc456abc1" in str(x) for x in stale), stale
assert any(x.get("action") == "diff_superseded_product" for x in compensation), compensation
assert any(x.get("reason") == "ALREADY_SENT" for x in compensation), compensation
print("never refire:", compensation)
PY
```

Run all four Cell redrive cases (new, changed, already-sent, and changed-after-send):

```sh
bash cell/tests/gates/redrive-case3.sh
```

`prior_sent` must come from durable boundary read-back in a real integration. Passing a guessed digest to this organelle does not make the effect independently proven.

## 8. Cross-layer acceptance

```sh
bash aiko/scripts/witness-graph-frontier.sh
bash cell/tests/gate.sh
bash neuron/tests/observe-live-gate.sh
bash tests/graph-engineering-gate.sh
```

The final command already invokes the first three as part of the aggregate; they are listed separately for diagnosis. The root gate checks the real Contract ABI, Cell runtime, standalone Neuron, and dependency directions. Its Rust-host checks are source anchors only; they do not claim that the host compiles or that the live path executes.

## Source vs. synthesis

The lecture’s intent → plan → tools → reflect flow motivates these examples only at a conceptual level. The speakers did not present these JSON fields, Cell YAML, Kahn frontiers, collision policy, citations, or compensation rules. Those behaviors are project code and are accepted by the commands above, not by the video.
