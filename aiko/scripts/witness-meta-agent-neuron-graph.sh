#!/usr/bin/env bash
# Witness: Aiko's default worker is an admitted typed Neuron Skill graph.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_ROOT="$(cd "$ROOT/../contract/libcontract" && pwd)"
SHELL_RS="$ROOT/crates/codegen/xai-grok-shell/src/contract_native.rs"
REGISTRY_RS="$ROOT/crates/codegen/xai-grok-shell/src/contract_native/skill_registry.rs"
GRAPH_RS="$ROOT/crates/codegen/xai-grok-shell/src/contract_native/skill_registry/graph.rs"
META_DIR="$ROOT/.agents/skills/aiko-meta-agent"
MANIFEST="$META_DIR/contract-skill.json"
GUIDANCE="$META_DIR/SKILL.md"
DOC="$ROOT/docs/CONTRACT-FRACTAL-CELL.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) CONTRACT_LIBRARY="$CONTRACT_ROOT/zig-out/lib/libcontract.dylib" ;;
  Linux) CONTRACT_LIBRARY="$CONTRACT_ROOT/zig-out/lib/libcontract.so" ;;
  *) fail "unsupported witness platform: $(uname -s)" ;;
esac

for path in \
  "$SHELL_RS" "$REGISTRY_RS" "$GRAPH_RS" "$MANIFEST" "$GUIDANCE" "$DOC"
do
  test -f "$path" || fail "missing $path"
done

# A — the embedded core is a bounded, typed, mechanically valid connectome.
(
  cd "$CONTRACT_ROOT"
  zig build test
  zig build
)
test -f "$CONTRACT_LIBRARY" || fail "A: missing native Contract library"
AIKO_SKILL_TEST_FAST=1 "$ROOT/scripts/test-contract-native-skills.sh"
python3 - "$MANIFEST" <<'PY' || fail "A: invalid Meta-Agent connectome"
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
assert manifest["id"] == "aiko-meta-agent"
assert manifest["activation"] == "core"
assert manifest["composition"] == {
    "attach_children_at": "route",
    "join_children_at": "verify",
}
nodes = manifest["nodes"]
assert [node["key"] for node in nodes] == [
    "observe", "recall", "route", "deliberate", "verify", "learn", "settle"
]
assert len(nodes) == 7
for key in ("deliberate", "learn"):
    node = next(node for node in nodes if node["key"] == key)
    assert node["effect"] == "local_reversible" and node["reversible"] is True
assert all(
    node["effect"] == "read_only"
    for node in nodes
    if node["key"] not in {"deliberate", "learn"}
)
host_nodes = [node for node in nodes if node["worker"] == "host"]
assert host_nodes and all(node.get("adapter") for node in host_nodes)
assert all("input_bindings" in node for node in nodes)
print("A: embedded typed Meta-Agent connectome")
PY

# B — production turns and durable claims consume that graph; no opaque center.
rg -q 'include_str!.*aiko-meta-agent' "$REGISTRY_RS" \
  || fail "B: core Skill is not build-embedded"
rg -q 'fn compose_ports' "$GRAPH_RS" || fail "B: typed limb composition missing"
rg -q 'skill_registry::plan_bounded' "$SHELL_RS" || fail "B: durable claim does not plan Skills"
rg -q 'skill_registry::core_guidance' "$SHELL_RS" || fail "B: live turn lacks admitted guidance"
rg -q 'typed_neuron_skill_graph' "$SHELL_RS" || fail "B: typed execution model missing"
if rg -q '"action"[[:space:]]*:[[:space:]]*"agent:aiko"' "$SHELL_RS" "$GRAPH_RS"; then
  fail "B: opaque agent:aiko action still exists"
fi
echo "B: live and durable paths use one admitted Skill graph"

# C — task limbs attach after route and rejoin at verify, with fail-closed bounds.
(
  cd "$ROOT"
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
    contract_native::skill_registry --lib
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
    contract_native::tests::default_connectome_is_the_admitted_meta_agent_skill \
    --lib -- --exact
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
    contract_native::tests::worker_claim_expands_into_germ_cell \
    --lib -- --exact
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
    contract_native::tests::meta_agent_graph_fails_closed_when_the_node_budget_cannot_fit_core \
    --lib -- --exact
  CARGO_INCREMENTAL=0 AIKO_CONTRACT_LIBRARY="$CONTRACT_LIBRARY" \
    cargo test -p xai-grok-shell \
      contract_native::skill_registry::graph::tests::native_contract_materializes_typed_skill_nodes_and_rejects_forgery \
      --lib -- --ignored --exact --test-threads=1
)
echo "C: dynamic limb ports, durable parity, and bounds"

# D — the generative rule is reusable, inert-before-admission, and rollback-aware.
rg -q 'Grow a generative limb' "$GUIDANCE" || fail "D: growth protocol missing"
rg -q 'provider-neutral generator' "$GUIDANCE" || fail "D: generator is provider-bound"
rg -q 'Keep generated code inert' "$GUIDANCE" || fail "D: admission gate missing"
rg -q 'retire or roll back by ledger event' "$GUIDANCE" || fail "D: rollback rule missing"
rg -q 'no second primitive' "$DOC" || fail "D: doctrine permits a side orchestrator"
echo "D: generative limb doctrine"

echo "meta-agent Neuron graph witness: PASS"
