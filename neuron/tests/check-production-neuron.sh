#!/usr/bin/env bash
set -euo pipefail

NEURON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNBROWSE_ROOT="$(cd "${NEURON_ROOT}/.." && pwd)"
CONTRACT_ROOT="${UNBROWSE_ROOT}/contract/libcontract"
AIKO_ROOT="${UNBROWSE_ROOT}/aiko"

fail() {
  echo "[production-neuron] FAIL: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) CONTRACT_LIBRARY="${CONTRACT_ROOT}/zig-out/lib/libcontract.dylib" ;;
  Linux) CONTRACT_LIBRARY="${CONTRACT_ROOT}/zig-out/lib/libcontract.so" ;;
  *) fail "unsupported native Contract witness platform" ;;
esac

test -x "${NEURON_ROOT}/tools/generate_wire_bindings.py" ||
  fail "canonical wire binding generator is missing"
python3 "${NEURON_ROOT}/tools/generate_wire_bindings.py" --check
python3 "${NEURON_ROOT}/tests/check_production_neuron.py"

(
  cd "${NEURON_ROOT}"
  zig fmt --check build.zig src
  zig build test
  zig build
)

(
  cd "${CONTRACT_ROOT}"
  zig fmt --check build.zig src/neuron.zig src/artifact.zig \
    src/c_abi.zig src/skill_execution/settle.zig src/ledger.zig
  zig build test
  zig build
)

(
  cd "${AIKO_ROOT}"
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
    contract_native::neuron_bridge::tests::generated_wire_binding_matches_canonical_vectors \
    --lib -- --exact
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
    contract_native::tests::admitted_script_runs_directly_and_crosses_the_exact_type_boundary \
    --lib -- --exact
  AIKO_CONTRACT_LIBRARY="${CONTRACT_LIBRARY}" CARGO_INCREMENTAL=0 \
    cargo test -p xai-grok-shell \
    contract_native::neuron_bridge::tests::neuron_native_ffi_commits_replays_and_rejects_contradiction \
    --lib -- --ignored --exact --test-threads=1
)

echo "[production-neuron] PASS — one canonical contract, generated bindings, and atomic settlement are green"
