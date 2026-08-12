#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
module="$repo/aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness_orchestration.rs"
python3 - "$module" "$repo/aiko/crates/codegen/xai-grok-shell/src/contract_native.rs" <<'PY'
import pathlib, sys
orchestration=pathlib.Path(sys.argv[1]).read_text()
host=pathlib.Path(sys.argv[2]).read_text()
# Exact tail remains Contract-owned; the host neither invents issuance booleans
# nor bypasses authentication/materialization after a completed wave.
for needle in ['.issue_terminal(request).await', '.authenticate_terminal(',
               '.materialize_terminal(', '.commit_neuron(', '.settle_node(']:
    assert needle in orchestration, needle
for needle in ['issue_graph_harness_attestation(request).await',
               'DeploymentVerifier::from_environment()',
               'graph_harness::materialize_admitted']:
    assert needle in host, needle
assert 'PreparedGraph::load_persisted' in host
assert 'prepared.material_bytes(&claim.witness_digest)' in host
assert 'prepared.material_bytes(&claim.judge_digest)' in host
assert 'node.inputs["result"]["completed"]' in orchestration
assert 'north-star consumes the actual terminal settlement product' in orchestration
PY
if [ "${AIKO_STATIC_ONLY:-0}" = 1 ]; then
  exit 0
fi
tmp="$(mktemp -d "${TMPDIR:-/tmp}/aiko-graph-harness-orchestration.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/Cargo.toml" <<'EOF'
[package]
name = "aiko-graph-harness-orchestration-witness"
version = "0.0.0"
edition = "2024"

[dependencies]
serde_json = "1"
EOF
mkdir -p "$tmp/src"
ln -s "$module" "$tmp/src/lib.rs"
ln -s "$module" "$tmp/src/graph_harness_orchestration.rs"
# The isolated crate compiles and tests the exact production state-machine file;
# no xai-grok-shell dependency or full-host linker can hide a missing proof.
cargo test --manifest-path "$tmp/Cargo.toml" --quiet
