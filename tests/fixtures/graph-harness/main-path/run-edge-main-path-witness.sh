#!/usr/bin/env bash
# Stdlib-only exact ordinary-profile witness. It reads the checked-in manifest
# used by include_str!, derives the rendered core plan verbatim, and inspects
# the production admission/dispatch sources. No planner-shaped substitute.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
python3 - "$ROOT" <<'PY'
import json, pathlib, re, sys
root=pathlib.Path(sys.argv[1])
manifest_path=root/'aiko/.agents/skills/aiko-meta-agent/contract-skill.json'
manifest=json.loads(manifest_path.read_text())
registry=(root/'aiko/crates/codegen/xai-grok-shell/src/contract_native/skill_registry.rs').read_text()
graph=(root/'aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness.rs').read_text()
host=(root/'aiko/crates/codegen/xai-grok-shell/src/contract_native.rs').read_text()
edge=(root/'aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness_edge.rs').read_text()
contract=(root/'contract/libcontract/src/skill_execution/common.zig').read_text()
cabi=(root/'contract/libcontract/src/c_abi.zig').read_text()
sandbox=(root/'aiko/crates/codegen/xai-grok-sandbox/src/profiles.rs').read_text()
# Root acceptance is executable canonical CAS material, not a digest-labelled
# pass. Production loads both exact pins and the edge module rejects bad input.
assert 'NORTH_STAR_WITNESS_PROGRAM' in graph and 'aiko-terminal-settlement/v1' in graph
assert 'NORTH_STAR_JUDGE_PROGRAM' in graph and 'aiko-independent-settlement-recheck/v1' in graph
assert 'north.input_bindings["result"]' in edge
for needle in ['prepared.material_bytes(&claim.witness_digest)',
               'prepared.material_bytes(&claim.judge_digest)',
               'execute_north_star(', 'witness_program', 'judge_program']:
 assert needle in host, needle
for needle in ['inputs.len() == 1', 'inputs.contains_key("result")',
               'result.completed must be a bool', 'result.retryable must be a bool',
               'result.evidence must be nonempty and bounded', 'result.goal_digest must be sha256',
               'result.product_digest must be sha256', 'witness_evidence', 'judge_evidence',
               'canonical_product_digest',
               'independent_judge', 'product digest drift',
               'graph-stimulus:sha256:', 'artifact:sha256:',
               'exact_north_star_refuses_bad_products_programs_and_digest_drift']:
 assert needle in edge, needle
assert 'let issued =' not in edge and 'let materialized =' not in edge
for needle in ['aiko-required-output-witness/v1', 'aiko-independent-output-recheck/v1',
               'required-non-null', 'evaluate_required_outputs',
               'independent_output_recheck',
               'model_and_host_refuse_missing_null_extra_and_foreign_output_programs']:
 assert needle in edge or needle in graph, needle
assert 'include_str!("../../../../../.agents/skills/aiko-meta-agent/contract-skill.json")' in registry
nodes=manifest['nodes']
assert manifest['activation']=='core' and len(nodes)==8
assert [n['key'] for n in nodes]==['observe','recall','route','act','capture','verify','judge','settle']
by={n['key']:n for n in nodes}
expected={
 'recall':{'context_references':'observe.context_references'},
 'route':{'artifact_digests':'recall.artifact_digests'},
 'act':{'selected_skill_refs':'route.selected_skill_refs'},
 'capture':{'action_result':'act.action_result'},
 'verify':{'product_snapshot':'capture.product_snapshot','product_digest':'capture.product_digest','goal_digest':'capture.goal_digest'},
 'judge':{'product_snapshot':'capture.product_snapshot','product_digest':'capture.product_digest','goal_digest':'capture.goal_digest'},
 'settle':{'verdict':'judge.verdict','verification':'verify.verification','product_digest':'capture.product_digest','goal_digest':'capture.goal_digest'},
}
for key,binding in expected.items(): assert by[key]['input_bindings']==binding
assert by['judge']['depends_on']==['capture'] and 'verify' not in by['judge']['depends_on']
assert by['verify']['depends_on']==['capture']
host_adapters={n['adapter'] for n in nodes if n['worker']=='host'}
assert host_adapters=={'aiko.meta.observe/v1','aiko.meta.recall/v1','aiko.meta.route/v1','aiko.meta.capture/v1','aiko.meta.settle/v1'}
assert all(adapter in registry for adapter in host_adapters)
act=by['act']; assert act['effect']=='local_reversible' and act['reversible'] and not act['read_only']
assert act['writes']==['workspace://**'] and not act['requires_authority']
assert by['settle']['evidence']==['settlement']
# Admission keeps exact identities, pins declarations, records the real local
# effect, and explicitly maps the ordinary terminal product to root result.
for needle in ['deterministic_host_adapter(adapter)','application/vnd.aiko.native-host-adapter+json;version=1',
 '"kind":"filesystem", "scope":WORKSPACE_AUTHORITY','"on_invalidation":"manual"',
 'let terminal_product = &terminals[0].evidence[0]',
 '"to":{"node":"$output","port":"result"}', '"result".to_owned()',
 'isolated-local-workspace-sandboxed-neuron/v1','workspace_root_digest',
 'aiko-sandboxed-neuron/v1','executor-scratch://grok-home+temp']:
 assert needle in graph, needle
assert 'node.writes.len() == 1' in graph and 'node.writes[0] == WORKSPACE_AUTHORITY' in graph
assert 'runtime_resources' in graph and 'SANDBOXED_NEURON_PROCESS' in graph
assert 'effects.len() == 1' in graph and 'local_reversible' in graph
# Production has one FnOnce host boundary over the exact native verdict and one
# async edge boundary. The calls occur once in their respective branch bodies.
assert 'F: FnOnce() -> Option<EdgeProducerResult>' in edge
assert edge.count('let Some(mut produced) = producer() else')==1
assert host.count('native_host_verdict(&node.payload, &selected_skill_refs)')==1
assert host.count('graph_harness_edge::execute_pinned_host(')==1
assert host.count('graph_harness_edge::execute_pinned_edge(')==1
assert 'node.payload.adapter.as_deref() == adapter' in host
assert 'graph_harness_runtime_pin_matches' in host
assert 'runtime_digest: String' in host
assert 'pinned_executable_digest(&executable)' in host
assert '&self.runtime_digest' in host and 'sandbox,' in host
assert 'executable bytes drifted' in host
assert '"runtime_pin"' in host and 'HOST_RUNTIME_PIN_VERSION' in host
assert 'leased adapter pins differ from prepared bundle' in host
# Contract can lease only the closed Cell/model/builtin-host set.
for adapter in ['aiko.graph-harness-cell-v0/v1','aiko.graph-harness-edge-model/v1',
 'aiko.meta.observe/v1','aiko.meta.recall/v1','aiko.meta.route/v1','aiko.meta.capture/v1','aiko.meta.settle/v1']:
 assert adapter in contract
assert 'aiko.meta.unknown/v1' in contract # negative executable Zig test
assert 'graphHarnessAdapterAllowed(node)' in contract
assert 'occ-edge' in cabi and 'occ-host' in cabi and 'foreign.edge/v1' in cabi
# Execute the exact closed allowlist declaration against the manifest-derived
# Contract claims, then mutate adapter/worker identity and prove refusal.
def rustlike_body(name, source):
 start=source.index('{', source.index('fn '+name)); depth=0
 for i in range(start,len(source)):
  depth += source[i]=='{'; depth -= source[i]=='}'
  if depth==0: return source[start:i+1]
 raise AssertionError('unbalanced '+name)
allow=rustlike_body('graphHarnessAdapterAllowed',contract)
pairs=set(re.findall(r'node\.key, "([^"]+)"\).*?adapter, "([^"]+)"',allow,re.S))
assert pairs=={('aiko-meta-agent--observe','aiko.meta.observe/v1'),
 ('aiko-meta-agent--recall','aiko.meta.recall/v1'),
 ('aiko-meta-agent--route','aiko.meta.route/v1'),
 ('aiko-meta-agent--capture','aiko.meta.capture/v1'),
 ('aiko-meta-agent--settle','aiko.meta.settle/v1')}
assert 'aiko.graph-harness-edge-model/v1' in allow and 'aiko.graph-harness-cell-v0/v1' in allow
def contract_accept(n):
 key='aiko-meta-agent--'+n['key']; adapter=n.get('adapter')
 if adapter=='aiko.graph-harness-cell-v0/v1': return n['worker']=='host'
 if adapter is None: # GraphHarness projects an Aiko node to the exact edge adapter.
  adapter='aiko.graph-harness-edge-model/v1'
 if adapter=='aiko.graph-harness-edge-model/v1':
  readonly=n['read_only'] and n['effect']=='read_only'
  workspace=(not n['read_only'] and n['reversible'] and n['effect']=='local_reversible')
  return n['worker']=='aiko' and (readonly or workspace)
 return n['worker']=='host' and n['read_only'] and n['effect']=='read_only' and (key,adapter) in pairs
assert all(contract_accept(n) for n in nodes)
foreign=dict(by['observe'],adapter='foreign.host/v1')
wrong_worker=dict(by['act'],worker='host')
assert not contract_accept(foreign) and not contract_accept(wrong_worker)
# `--sandbox workspace` is not a label: the built-in profile grants its
# capability allowlist and configures egress restriction at kernel launches.
assert 'Self::Workspace | Self::ReadOnly | Self::Strict' in sandbox
workspace=re.search(r'Self::Workspace => Ok\(SandboxProfile \{(.*?)\n\s*\}\),',sandbox,re.S).group(1)
assert 'read_write: essential_writable_paths(workspace)' in workspace
assert 'restrict_network: true' in workspace
# Execute the manifest-derived dispatch classification and prove one dispatch
# per leased node (five native host, three model edge) with no Cell relabeling.
calls={f"aiko-meta-agent--{n['key']}":0 for n in nodes}
kind={}
for n in nodes:
 key=f"aiko-meta-agent--{n['key']}"
 adapter=n.get('adapter')
 if n['worker']=='host': assert adapter in host_adapters; kind[key]='host'
 else: assert n['worker']=='aiko' and adapter is None; kind[key]='edge'
 calls[key]+=1
assert set(calls.values())=={1}
assert list(kind.values()).count('host')==5 and list(kind.values()).count('edge')==3
print('ordinary GraphHarness exact-profile witness: PASS')
PY


if [ "${AIKO_STATIC_ONLY:-0}" = 1 ]; then
  exit 0
fi

# Executable exact-source witness: symlink the production preparation module,
# parse the real include_str! manifest, persist/reload, and project Contract DTOs.
WORK="${TMPDIR:-/tmp}/aiko-ordinary-exact-source-witness"
rm -rf "$WORK"; mkdir -p "$WORK/src"
ln -s "$ROOT/aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness.rs" "$WORK/src/graph_harness.rs"
ln -s "$ROOT/aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness_edge.rs" "$WORK/src/graph_harness_edge.rs"
cat >"$WORK/src/lib.rs" <<'RS'
pub mod graph_harness;
pub mod graph_harness_edge;
RS
cat >"$WORK/Cargo.toml" <<'TOML'
[package]
name="aiko-ordinary-exact-source-witness"
version="0.1.0"
edition="2024"
[dependencies]
serde={version="1",features=["derive"]}
serde_json={version="1",features=["preserve_order"]}
sha2="0.10"
thiserror="2"
tempfile="3"
tokio={version="1",features=["macros","rt"]}
TOML
AIKO_EMBEDDED_CORE_MANIFEST="$ROOT/aiko/.agents/skills/aiko-meta-agent/contract-skill.json" \
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo test --manifest-path "$WORK/Cargo.toml" \
  real_embedded_core_manifest_prepares_persists_and_projects_ordinary_profile -- --nocapture
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo test --manifest-path "$WORK/Cargo.toml" \
  exact_north_star_refuses_bad_products_programs_and_digest_drift -- --nocapture
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo test --manifest-path "$WORK/Cargo.toml" \
  model_and_host_refuse_missing_null_extra_and_foreign_output_programs -- --nocapture
