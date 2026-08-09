#!/usr/bin/env bash
# Witness: the Contract graph kernel is deterministic and fail-closed at its
# public ABI. Desktop execution is deliberately not duplicated here: Aiko's
# host consumes contract_graph_plan, while the later composition gate owns UI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_ROOT="$(cd "$ROOT/../contract/libcontract" && pwd)"
GRAPH_PLAN_ZIG="$CONTRACT_ROOT/src/graph_plan.zig"
C_ABI_ZIG="$CONTRACT_ROOT/src/c_abi.zig"
HOST_RS="$ROOT/crates/codegen/xai-grok-shell/src/contract_native.rs"

fail() { echo "FAIL: $*" >&2; exit 1; }
for path in "$GRAPH_PLAN_ZIG" "$C_ABI_ZIG" "$HOST_RS"; do
  test -f "$path" || fail "missing $path"
done
for anchor in \
  'fn scopeOverlap' 'fn globMatch' 'write_collisions' 'model_tiers' \
  'verdict.waves' 'cycle_list' 'unknown_dependencies' 'grounding_gaps' \
  'gating_gaps'
do
  rg -q "$anchor" "$GRAPH_PLAN_ZIG" || fail "graph_plan.zig lacks $anchor"
done
rg -q 'graph_plan C ABI emits waves collisions and tiers' "$C_ABI_ZIG" \
  || fail "C ABI boundary test missing"
rg -q 'graph_plan C ABI refuses unknown statuses' "$C_ABI_ZIG" \
  || fail "unknown-status C ABI refusal test missing"
rg -q 'graph_plan C ABI conservatively reports broad glob collisions' "$C_ABI_ZIG" \
  || fail "broad-glob C ABI collision test missing"
rg -q 'contract_graph_plan' "$HOST_RS" || fail "Aiko host does not bind the Contract graph ABI"

(
  cd "$CONTRACT_ROOT"
  zig build test
  zig build
)

case "$(uname -s)" in
  Linux) LIB="$CONTRACT_ROOT/zig-out/lib/libcontract.so" ;;
  Darwin) LIB="$CONTRACT_ROOT/zig-out/lib/libcontract.dylib" ;;
  *) fail "unsupported platform for live ABI witness: $(uname -s)" ;;
esac
test -f "$LIB" || fail "real Contract dylib not built: $LIB"

# Exercise the installed dylib rather than accepting unit-test resemblance.
python3 - "$LIB" <<'PY'
import ctypes
import json
import sys

lib = ctypes.CDLL(sys.argv[1])
lib.contract_graph_plan.argtypes = [ctypes.c_char_p]
lib.contract_graph_plan.restype = ctypes.c_void_p
lib.contract_free.argtypes = [ctypes.c_void_p]
lib.contract_free.restype = None

def plan(value):
    raw = json.dumps(value, separators=(",", ":")).encode()
    ptr = lib.contract_graph_plan(raw)
    if not ptr:
        return None
    try:
        return json.loads(ctypes.string_at(ptr))
    finally:
        lib.contract_free(ptr)

fixture = {"nodes": [
    {"id":"f","plan":"fanout-c","depends_on":["c"],"status":"pending"},
    {"id":"a","plan":"root","depends_on":[],"status":"pending","writes":["src/"],
     "invoke_skills":["jesus-graph"],"witness":"true"},
    {"id":"e","plan":"fanout-b","depends_on":["c"],"status":"pending"},
    {"id":"b","plan":"left","depends_on":["a"],"status":"pending","writes":["src/ui.ts"]},
    {"id":"d","plan":"fanout-a","depends_on":["c"],"status":"pending"},
    {"id":"c","plan":"right","depends_on":["a"],"status":"pending","writes":["docs/"]},
]}
v = plan(fixture)
assert v is not None
assert v["waves"] == [["a"], ["b", "c"], ["d", "e", "f"]], v
assert v["ready"] == ["a"] and v["kind"] == "chain", v
assert v["peak_parallelism"] == 3 and v["total_agents"] == 6, v
assert v["write_collisions"] == [
    {"a":"a","b":"b","shared":["src/ <-> src/ui.ts"]}
], v
assert {x["id"]: x["tier"] for x in v["model_tiers"]}["c"] == "judgement", v
assert v["cycles"] == v["cycle_list"] == [], v
assert v["unknown_dependencies"] == [], v
assert v["grounding_gaps"] == v["ungrounded"] == ["b", "c", "d", "e", "f"], v
assert v["gating_gaps"] == v["ungated"] == ["b", "c", "d", "e", "f"], v

# Input order cannot alter the durable plan.
reordered = {"nodes": list(reversed(fixture["nodes"]))}
assert plan(reordered) == v

independent = plan({"nodes":[
    {"id":"y","depends_on":[],"status":"pending"},
    {"id":"x","depends_on":[],"status":"pending"},
]})
assert independent["kind"] == "graph" and independent["ready"] == ["x", "y"], independent

cycle = plan({"nodes":[
    {"id":"b","depends_on":["a"],"status":"pending"},
    {"id":"a","depends_on":["b"],"status":"pending"},
]})
assert cycle["waves"] == [] and cycle["cycle_list"] == ["a", "b"], cycle

unknown = plan({"nodes":[
    {"id":"a","depends_on":["missing"],"status":"pending"},
]})
assert unknown["waves"] == [], unknown
assert unknown["unknown_dependencies"] == [{"node":"a","dependency":"missing"}], unknown

# Unknown and future statuses cannot silently masquerade as settled nodes.
assert plan({"nodes":[
    {"id":"a","depends_on":[],"status":"pendng"},
    {"id":"b","depends_on":["a"],"status":"pending"},
]}) is None
assert plan({"nodes":[
    {"id":"a","depends_on":[],"status":"future"},
]}) is None

# Broad globs with no literal stem can intersect. Report them conservatively,
# and keep the durable report invariant under input order.
broad_nodes = [
    {"id":"b","depends_on":[],"status":"pending","writes":["**/foo.*"]},
    {"id":"a","depends_on":[],"status":"pending","writes":["**/*.zig"]},
]
broad = plan({"nodes": broad_nodes})
assert broad["write_collisions"] == [{
    "a":"a", "b":"b", "shared":["**/*.zig <-> **/foo.*"]
}], broad
assert plan({"nodes": list(reversed(broad_nodes))}) == broad

# Malformed shape is refused at the ABI instead of being treated as empty.
assert plan({"nodes": {}}) is None

# Expansion is append-only, so a failure after the first child declaration must
# terminalize that partial child before returning NULL.
import os, pathlib, tempfile
with tempfile.TemporaryDirectory() as directory:
    pathlib.Path(directory, ".claude").mkdir()
    prior = os.getcwd()
    os.chdir(directory)
    try:
        lib.contract_declare.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p]
        lib.contract_declare.restype = ctypes.c_void_p
        lib.contract_expand_json.argtypes = [ctypes.c_char_p]
        lib.contract_expand_json.restype = ctypes.c_void_p
        root_ptr = lib.contract_declare(b"partial expansion witness", b"neuron", None, None)
        assert root_ptr
        try:
            root = ctypes.string_at(root_ptr).decode()
        finally:
            lib.contract_free(root_ptr)
        def child(key):
            return {
                "key": key, "plan": key,
                "action": "skill:witness@1.0.0:aiko", "depends_on": [],
                "input_bindings": {}, "requires_authorization": False,
                "authorization": "approved", "effect_scope": "read_only",
                "read_only": True, "reversible": False, "timeout_ms": 30000,
                "skill_id": "witness", "skill_version": "1.0.0",
                "worker": "aiko", "adapter": None, "script": None,
                "script_digest": None, "evidence": ["result"],
                "activation": "matched", "admission": "embedded",
            }
        first, second = child("first"), child("second")
        second["input_bindings"] = []  # validated only after first is durable
        request = {"root_id": root, "plan": "partial", "children": [first, second]}
        assert not lib.contract_expand_json(json.dumps(request).encode())
        rows = [json.loads(line) for line in pathlib.Path(".claude/contracts.jsonl").read_text().splitlines()]
        partial = [row["id"] for row in rows if row.get("event") == "declared" and row.get("parent_id") == root]
        assert len(partial) == 1, rows
        assert any(row.get("event") == "died" and row.get("id") == partial[0] for row in rows), rows
    finally:
        os.chdir(prior)
print("live contract_graph_plan ABI: PASS")
PY

echo "graph frontier witness: PASS"
