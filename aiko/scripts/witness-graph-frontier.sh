#!/usr/bin/env bash
# Witness: jesus-graph machinery is native to the Contract graph path.
#
# Exit 0 only when every section passes:
#   A. graph_plan.zig computes Kahn frontier waves, write-set collisions,
#      fan-based model tiers, and surfaces dependency cycles — proven at the
#      public C ABI boundary, not only in unit shape.
#   B. The Skill planner turns declared capabilities/research gaps into
#      deduplicated discovery nodes with real dependency edges and artifact
#      bindings (jesus-graph discovery-as-data), inside the node budget.
#   C. Settlement is gated on declared witnesses: green settles, red reopens
#      as a bounded retry, and discovery artifacts validate against
#      aiko.discovery/v1 at settlement time.
#   D. Manifest validation accepts the new contract fields and the whole
#      contract-native skills suite stays green.
#   E. The desktop frontend is interfaced: native.ts binds contract_graph_plan
#      over bun:ffi, neurons.ts partitions waves by declared write collisions
#      and refuses cycles, the whole app typechecks, the vitest suite passes,
#      and the binding is proven against the REAL dylib (not a mock).
#
# Falsifier: delete any one mechanism and the matching section must go red.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_ROOT="$(cd "$ROOT/../contract/libcontract" && pwd)"
GRAPH_PLAN_ZIG="$CONTRACT_ROOT/src/graph_plan.zig"
C_ABI_ZIG="$CONTRACT_ROOT/src/c_abi.zig"
GRAPH_RS="$ROOT/crates/codegen/xai-grok-shell/src/contract_native/skill_registry/graph.rs"
SHELL_RS="$ROOT/crates/codegen/xai-grok-shell/src/contract_native.rs"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

for path in "$GRAPH_PLAN_ZIG" "$C_ABI_ZIG" "$GRAPH_RS" "$SHELL_RS"; do
  test -f "$path" || fail "missing $path"
done

# A — the analytic core: waves, collisions, tiers, cycles, honest agent count.
for anchor in \
  'fn scopeOverlap' 'fn globMatch' 'write_collisions' 'model_tiers' \
  'verdict.waves' 'cycle_list'
do
  rg -q "$anchor" "$GRAPH_PLAN_ZIG" || fail "A: graph_plan.zig lacks $anchor"
done
rg -q 'graph_plan C ABI emits waves collisions and tiers' "$C_ABI_ZIG" \
  || fail "A: C ABI boundary test missing"
(
  cd "$CONTRACT_ROOT"
  zig build test
  zig build
)
echo "A: graph_plan waves/collisions/tiers/cycles green at the C ABI"

# B — discovery-as-data in the planner.
rg -q 'fn inject_discovery_nodes' "$GRAPH_RS" || fail "B: discovery injection missing"
rg -q 'DISCOVERY_SCHEMA' "$GRAPH_RS" || fail "B: discovery schema missing"
(
  cd "$ROOT"
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
    contract_native::skill_registry::graph::tests --lib
)
echo "B: discovery generation deduplicated, wired, and budget-bounded"

# C — the wheel at settlement: witness gating and artifact validation.
for anchor in \
  'fn run_node_witness' 'fn validate_discovery_artifact' \
  'fn settlement_rejection' 'settlement witness red'
do
  rg -q "$anchor" "$SHELL_RS" || fail "C: executor lacks $anchor"
done
(
  cd "$ROOT"
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
    contract_native::tests::settlement_gate_reopens_red_witnesses_and_passes_green \
    --lib -- --exact
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
    contract_native::tests::discovery_artifact_validation_enforces_the_schema_at_settlement \
    --lib -- --exact
)
echo "C: settlement gated on witnesses and discovery artifacts"

# D — the manifest contract accepts the new fields and stays adversarial.
rg -q 'node-witness' "$ROOT/scripts/test-contract-native-skills.py" \
  || fail "D: skills validation does not pin the new fields"
AIKO_SKILL_TEST_FAST=1 "$ROOT/scripts/test-contract-native-skills.sh"
echo "D: manifest contract fields validated, adversarial suite green"

# E — the frontend is interfaced, not merely typechecked around.
DESKTOP="$ROOT/apps/desktop"
for anchor in \
  'contract_graph_plan' 'GraphPlanVerdict' 'export function graphPlan'
do
  rg -q "$anchor" "$DESKTOP/src/contract/native.ts" || fail "E: native.ts lacks $anchor"
done
for anchor in \
  'partitionWaveByCollisions' 'planNeuronWaves' 'dependency_cycle'
do
  rg -q "$anchor" "$DESKTOP/src/contract/neurons.ts" || fail "E: neurons.ts lacks $anchor"
done
(
  cd "$DESKTOP"
  bun install --silent
  ./node_modules/.bin/tsc -b --force
  ./node_modules/.bin/vitest run
  bun scripts/graph-plan-ffi-check.ts
)
echo "E: frontend binding, collision-aware executor, and live-dylib proof green"

echo "graph frontier witness: PASS"
