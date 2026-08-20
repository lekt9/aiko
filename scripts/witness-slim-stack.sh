#!/usr/bin/env bash
# witness-slim-stack — installed runtime is the rank-free ledger, binaries run.
set -euo pipefail
fail() { echo "FAIL slim-stack: $*" >&2; exit 1; }

LIB="${AIKO_HOME:-$HOME/.aiko}/lib/libcontract.so"
[ -f "$LIB" ] || LIB="${AIKO_HOME:-$HOME/.aiko}/lib/libcontract.dylib"
[ -f "$LIB" ] || fail "installed contract library missing"

python3 - "$LIB" <<'PY' || fail "installed library still carries rank/BGE"
import sys
blob = open(sys.argv[1], "rb").read()
assert blob.count(b"BGEW") == 0, "installed libcontract embeds BGE weights"
assert b"contract_recommend" not in blob, "installed libcontract still exports contract_recommend"
assert b"contract_declare_turn" in blob, "installed libcontract lost contract_declare_turn"
assert b"contract_abi_version" in blob, "installed libcontract lost contract_abi_version"
print(f"ok: installed ledger {len(blob)} bytes, rank-free")
PY

command -v aiko >/dev/null || fail "aiko not on PATH"
command -v neuron >/dev/null || fail "neuron not on PATH"
aiko --version >/dev/null || fail "aiko --version failed"
neuron --version >/dev/null || fail "neuron --version failed"

file "$(command -v aiko)" | grep -qi "not stripped" && fail "installed aiko still not stripped" || true
file "$(command -v neuron)" | grep -qi "not stripped" && fail "installed neuron still not stripped" || true
file "$LIB" | grep -qi "not stripped" && fail "installed libcontract still not stripped" || true

echo "witness-slim-stack: PASS"
