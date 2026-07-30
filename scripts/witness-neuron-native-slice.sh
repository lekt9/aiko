#!/usr/bin/env bash
set -euo pipefail

WITNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIKO_ROOT="$(cd "${WITNESS_DIR}/.." && pwd)"
CONTRACT_ROOT="$(cd "${AIKO_ROOT}/../contract/libcontract" && pwd)"
NEURON_ROOT="$(cd "${AIKO_ROOT}/../neuron" && pwd)"
CONTRACT_NEURON="${CONTRACT_ROOT}/src/neuron.zig"

fail() {
  echo "neuron-native witness failed: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) CONTRACT_LIBRARY="${CONTRACT_ROOT}/zig-out/lib/libcontract.dylib" ;;
  Linux) CONTRACT_LIBRARY="${CONTRACT_ROOT}/zig-out/lib/libcontract.so" ;;
  *)
    echo "unsupported witness platform: $(uname -s)" >&2
    exit 2
    ;;
esac

test -f "${NEURON_ROOT}/src/wire.zig" || fail "canonical typed_neuron wire module missing"
rg -q '\.path = "../../neuron"' "${CONTRACT_ROOT}/build.zig.zon" ||
  fail "Contract no longer depends on the sibling typed_neuron package"
rg -q 'addImport\("typed_neuron"' "${CONTRACT_ROOT}/build.zig" ||
  fail "Contract build does not inject the typed_neuron module"
rg -q 'const core = @import\("typed_neuron"\)' "${CONTRACT_NEURON}" ||
  fail "Contract Neuron adapter no longer imports the canonical core"
rg -q 'pub const validate = core\.validate' "${CONTRACT_NEURON}" ||
  fail "Contract Neuron validation is not delegated to the canonical core"
rg -q 'pub const firingId = core\.firingId' "${CONTRACT_NEURON}" ||
  fail "Contract firing identity is not delegated to the canonical core"
rg -q 'pub const decisionDigest = core\.decisionDigest' "${CONTRACT_NEURON}" ||
  fail "Contract decision identity is not delegated to the canonical core"
if rg -q '^pub fn (validate|firingId|decisionDigest)\(' "${CONTRACT_NEURON}"; then
  fail "Contract reintroduced a duplicate Neuron validator or digest implementation"
fi

(
  cd "${NEURON_ROOT}"
  zig build test
)

(
  cd "${CONTRACT_ROOT}"
  zig build test
  zig build
)

test -f "${CONTRACT_LIBRARY}"

run_exact_test() {
  local test_name="$1"
  shift
  local output
  if ! output="$(
    CARGO_INCREMENTAL=0 AIKO_CONTRACT_LIBRARY="${CONTRACT_LIBRARY}" \
      cargo test -p xai-grok-shell "${test_name}" --lib -- "$@" 2>&1
  )"; then
    printf '%s\n' "${output}" >&2
    return 1
  fi
  printf '%s\n' "${output}"
  if [[ "${output}" != *"test ${test_name} ... ok"* ]]; then
    echo "witness selected no passing test: ${test_name}" >&2
    return 1
  fi
}

(
  cd "${AIKO_ROOT}"
  run_exact_test \
    'contract_native::neuron_bridge::tests::neuron_abi_rollout_preserves_legacy_compatibility' \
    --exact
  run_exact_test \
    'contract_native::neuron_bridge::tests::turn_terminal_adapter_is_typed_grounded_bounded_and_private' \
    --exact
  run_exact_test \
    'contract_native::neuron_bridge::tests::neuron_native_ffi_commits_replays_and_rejects_contradiction' \
    --ignored --exact --test-threads=1
)

echo "neuron-native slice witness: PASS"
