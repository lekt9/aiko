#!/usr/bin/env bash
# GraphHarness main-path acceptance. This gate deliberately combines executable
# public/native tests with mutation-sensitive ownership checks: a green compiler
# test alone is not evidence that structured work cannot take the old planner.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail() { echo "FAIL graph-harness-main-path: $*" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aiko-graph-main-path.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
export TMPDIR="$tmp/tmp"
mkdir -p "$TMPDIR" "$tmp/state"

HOST=aiko/crates/codegen/xai-grok-shell/src/contract_native.rs
GH=aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness.rs
CELL=aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness_cell.rs
ORCH=aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness_orchestration.rs
MCP=aiko/crates/codegen/xai-grok-mcp/src/graph_harness_tools.rs
ABI=contract/libcontract/src/c_abi.zig
ISSUER=contract/libcontract/src/graph_harness_attestation.zig

# This checker owns the two mandatory bypass falsifiers. It extracts balanced
# Rust function bodies rather than matching adjacent lines, and requires the
# only planner sample to live in ground_turn_with_facts_and_prepared. The self-mutations below prove
# that restoring expansion-time or claim-time planning makes this gate red.
cat >"$tmp/check-main-path.py" <<'PY'
import pathlib, re, sys
p=pathlib.Path(sys.argv[1]); s=p.read_text(encoding="utf-8")
o=pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
def body(name, source=s):
    m=re.search(r"(?m)^\s*(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+"+re.escape(name)+r"(?:<[^({]+>)?\s*\(",source)
    if not m: raise AssertionError(f"missing function {name}")
    start=source.find("{",m.end())
    if start < 0: raise AssertionError(f"missing body {name}")
    depth=0
    for i in range(start,len(source)):
        if source[i]=="{": depth+=1
        elif source[i]=="}":
            depth-=1
            if depth==0:return source[start:i+1]
    raise AssertionError(f"unbalanced body {name}")
ground=body("ground_turn_with_facts_and_prepared")
expand=body("expand_turn_root")
claim=body("execute_claim_neuron_graph")
strict=body("execute_graph_harness_claim_with", o)
needle="skill_registry::plan_bounded("
assert ground.count(needle)==1, "new authoring must sample the bounded planner exactly once"
assert ground.index("if let Some(prepared) = prepared_reuse") < ground.index(needle), "prepared reuse must branch before planner sampling"
assert needle not in expand, "structured expansion re-plans instead of consuming PreparedGraph"
assert needle not in strict, "strict GraphHarness claim execution re-plans instead of loading pins"
dispatch=claim.index("return Some(execute_graph_harness_claim(executable, cwd, owner, claim, policy).await)")
first_plan=claim.find(needle)
assert first_plan < 0 or first_plan > dispatch, "Primary claim can re-plan before immutable GraphHarness dispatch"
assert "TurnGraphSource::GraphHarness(prepared)" in expand
assert ".load_bundle(" in strict and ".execute_node(" in strict
assert ".commit_neuron(" in strict and ".settle_node(" in strict
assert ".issue_terminal(" in strict and ".authenticate_terminal(" in strict
assert "PreparedGraph::load_persisted" in s and "CellSidecar::from_environment" in s
assert "graph_harness_node_verdict" in s and "graph_harness_north_star_verdict" in s
assert "mod graph_harness_edge" in s and "graph_harness_edge::execute_pinned_edge" in s
assert "ProductionNeuronEdgeExecutor" in s, "production Neuron adapter is not wired to exact edge module"
proof=body("exact_order_pins_evidence_and_terminal_authentication", o)
for required in ["claim(true)", "exec-producer", "exec-north-star",
                 "neuron_firing", "producer_output", "sidecar_init", "materialize"]:
    assert required in proof, f"orchestration proof no longer binds {required}"
PY
python3 "$tmp/check-main-path.py" "$HOST" "$ORCH" || fail "main-path ownership check"
python3 - "$HOST" "$tmp/expand-mut.rs" "$tmp/claim-mut.rs" <<'PY'
import pathlib,sys
s=pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
a='async fn expand_turn_root('
i=s.index('{',s.index(a)); pathlib.Path(sys.argv[2]).write_text(s[:i+1]+'\n let _bypass = skill_registry::plan_bounded("mutant", cwd, 1);'+s[i+1:])
a='pub async fn execute_claim_neuron_graph('
i=s.index('{',s.index(a)); pathlib.Path(sys.argv[3]).write_text(s[:i+1]+'\n let _replan = skill_registry::plan_bounded("mutant", &cwd, 1);'+s[i+1:])
PY
if python3 "$tmp/check-main-path.py" "$tmp/expand-mut.rs" "$ORCH" >/dev/null 2>&1; then
  fail "direct expand-time plan_bounded mutation survived"
fi
if python3 "$tmp/check-main-path.py" "$tmp/claim-mut.rs" "$ORCH" >/dev/null 2>&1; then
  fail "claim-time plan_bounded mutation survived"
fi

# Compile the public shell/MCP test surfaces, then execute dependency-minimal
# witnesses over the exact production files. The full xai-grok-shell unit-test
# binary exceeds the repository's documented 16GB link ceiling; treating a
# SIGKILL as a pass would be dishonest, and copying the algorithm would drift.
(
  cd aiko
  CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo check -q -p xai-grok-shell --lib
  cargo test -q -p xai-grok-mcp catalog_matches_public_operations_and_has_closed_schemas -- --nocapture
  cargo test -q -p xai-grok-mcp dispatch_rejects_request_selected_authority_before_service -- --nocapture
  cargo test -q -p xai-grok-mcp all_tools_converge_on_one_service_request_shape -- --nocapture
  cargo test -q -p xai-grok-mcp rmcp_transport_lists_and_calls_production_server -- --nocapture

  # The full pager test binary can exceed the host link ceiling. Compile and
  # execute the exact std-only production parser/typed dispatch module instead.
  cli_witness="$tmp/workflow-cli-witness"
  rustc --edition 2024 --test crates/codegen/xai-grok-pager-bin/src/workflow_cli.rs -o "$cli_witness"
  "$cli_witness" --nocapture
)

# These standalone crates symlink the exact production modules: pure compiler
# and identity, strict Cell adapter, and the sole orchestration state machine.
# They execute real Rust tests without an impossible duplicate full-host link.
bash tests/fixtures/graph-harness/main-path/run-rust-core-witness.sh
bash tests/fixtures/graph-harness/main-path/run-cell-adapter-witness.sh
bash tests/fixtures/graph-harness/main-path/run-orchestration-witness.sh
bash tests/fixtures/graph-harness/main-path/run-edge-main-path-witness.sh

# Native Contract tests exercise the actual ABI expansion/claim projection and
# issuer implementation (including terminal coverage and canonical statement),
# not a JSON fixture attester or stdout resemblance.
(
  cd contract/libcontract
  zig build test >/dev/null
)

# Public composition witness from an empty directory. A prepared bundle is
# submitted twice through the installed product; the second call reuses only
# immutable authoring bytes and must return the exact idempotent Contract root.
workflow_bin="${AIKO_WORKFLOW_BIN:-$(command -v aiko || true)}"
[ -n "$workflow_bin" ] && [ -x "$workflow_bin" ] || fail "installed aiko workflow binary is unavailable"
public="$tmp/public-product"
mkdir -p "$public"
goal='Return a concise greeting without modifying files'
(
  cd "$public"
  if "$workflow_bin" workflow submit --goal 'Return exact JSON output' >objective-missing.json 2>&1; then
    exit 91
  fi
  grep -q 'workflow_cli_usage' objective-missing.json
  if "$workflow_bin" workflow submit --goal 'Compute 2 + 2 exactly' --acceptance objective-artifact/v1 >objective-unsupported.json 2>&1; then
    exit 92
  fi
  grep -q 'workflow_cli_usage' objective-unsupported.json
  "$workflow_bin" workflow submit --goal "$goal" --acceptance subjective-independent-edge-review/v1 >novel.json
)
bundle_ref="$(python3 - "$public/novel.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1])); assert v['ok'] is True
r=v['result']; assert r['state']=='submitted' and r['owner']=='contract_native'
assert r['bundle_ref'].startswith('cas:') and len(r['bundle_ref'])==68
assert r['acceptance_profile']=='subjective-independent-edge-review/v1'
assert len(r['root_id'])>0 and len(r['graph_digest'])==64
print(r['bundle_ref'])
PY
)"
(
  cd "$public"
  "$workflow_bin" workflow submit --goal "$goal" --acceptance subjective-independent-edge-review/v1 --bundle-ref "$bundle_ref" >reuse.json
  "$workflow_bin" workflow status "$bundle_ref" >status.json
  "$workflow_bin" workflow inspect "$bundle_ref" >inspect.json
)
# A separate process judges durable product bytes rather than CLI resemblance.
python3 - "$public" "$goal" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); goal=sys.argv[2]
novel=json.loads((root/'novel.json').read_text())['result']
reuse=json.loads((root/'reuse.json').read_text())['result']
assert reuse['state']=='submitted' and reuse['bundle_ref']==novel['bundle_ref']
assert reuse['acceptance_profile']=='subjective-independent-edge-review/v1'
assert reuse['root_id']==novel['root_id']
status=json.loads((root/'status.json').read_text())['result']
inspect=json.loads((root/'inspect.json').read_text())['result']
assert status['state']=='submitted' and status['reuse_policy']=='contract_revalidation_no_admission_shortcut'
assert status['acceptance_profile']=='subjective-independent-edge-review/v1'
assert status['root_ids']==[novel['root_id']]
assert inspect['root_ids']==status['root_ids'] and inspect['bundle_digest']==status['bundle_digest']
state=root/'.aiko/graph-harness'
digest=novel['bundle_ref'].split(':',1)[1]
envelope=json.loads((state/'prepared'/digest/'envelope.json').read_text())
assert envelope['package']['north_star']['claim']==goal
for submitted in (novel,reuse):
 receipt=json.loads((state/'roots'/f"{submitted['root_id']}.json").read_text())
 assert receipt['bundle_digest']==digest and receipt['graph_digest']==submitted['graph_digest']
 assert receipt['identity']==submitted['identity']
PY

# Negative production probes. They bind the deployment-only trust/executor seam
# and the exact evidence chain while executable tests above prove byte rehash,
# transitive drift, unsupported profile refusal, and manifest output validation.
rg -q 'contract_issue_graph_harness_attestation_json' "$ABI" || fail "native Contract issuer export missing"
rg -q 'GraphHarness expand claim projects immutable root and child pins' "$ABI" || fail "native exact-pin ABI witness missing"
rg -q 'coverage refuses incomplete self-judged and stale durable rows' "$ISSUER" || fail "issuer terminal coverage witness missing"
rg -q 'Primary profile requires an active kernel-enforced strict host sandbox' "$CELL" || fail "unconfined runner is not refused"
rg -q 'pub fn from_environment\(\) -> Result<Self>' "$CELL" || fail "executor is not deployment-owned"
if rg -q 'bin/aiko-harness|cell/run\.py' "$HOST" "$GH" "$CELL"; then
  fail "Rust primary path contains a repository-relative fallback"
fi
rg -q 'cell_manifest' "$GH" || fail "Contract request omits Cell manifest evidence"
rg -q 'neuron_firing' "$GH" || fail "Contract request omits Neuron citation evidence"
rg -q 'witness_verdict' "$GH" || fail "Contract request omits witness evidence"
rg -q 'judge_verdict' "$GH" || fail "Contract request omits independent judge evidence"
rg -q '__graph_harness_north_star' "$GH" || fail "acceptance edge is missing"
rg -q 'bundle_persistence_is_atomic_and_never_overwrites' "$GH" || fail "prepared immutable persistence witness missing"
rg -q 'workflow_operation_not_supported' aiko/crates/codegen/xai-grok-shell/src/lib.rs || fail "unsupported prepare/find are not honest stable refusals"
rg -q 'impl ServerHandler for GraphHarnessMcpServer' "$MCP" || fail "workflow catalog is not mounted as an MCP server"
rg -q 'pub fn mcp_server' aiko/crates/codegen/xai-grok-shell/src/lib.rs || fail "MCP server callback is not bound to shell service"
rg -q 'mod workflow_cli' aiko/crates/codegen/xai-grok-pager-bin/src/main.rs || fail "aiko workflow namespace is not mounted"
rg -q 'workflow_bundle_not_inspectable' aiko/crates/codegen/xai-grok-shell/src/lib.rs || fail "status/inspect do not report rehash refusal"

printf '%s\n' 'graph-harness-main-path gate: PASS (single authoring sample · stable prepared identity · MCP/service · exact Contract pins/issuer · strict Cell refusals)'
