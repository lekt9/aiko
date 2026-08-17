#!/usr/bin/env bash
# contract-slim-ledger-gate — the ledger-only artifact must not carry rank.
#
# Phase-2 decomposition witness: libcontract publishes a slim static library
# (`zig build ledger-library` → libcontract_ledger.a) whose ABI is c_abi.zig
# minus the four semantic-router exports. Those exports are the only path to
# bge.zig's 33.5MB @embedFile'd BERT weights, so their absence is checkable in
# bytes, not in prose: the BGEW blob magic must not appear in the slim
# artifact.
#
# Falsifier: registering the rank exports unconditionally in c_abi.zig (or
# re-coupling route/bge into any always-analyzed path) makes the BGEW check go
# red. The full library is asserted as the positive control so the witness
# cannot pass by looking at the wrong bytes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/contract/libcontract"

fail() { echo "FAIL contract-slim-ledger: $*" >&2; exit 1; }

(cd "$LIB" && zig build ledger-library) || fail "ledger-library build failed"
(cd "$LIB" && zig build) || fail "full library build failed"

SLIM="$LIB/zig-out/lib/libcontract_ledger.a"
FULL="$LIB/zig-out/lib/libcontract.dylib"
[ -f "$FULL" ] || FULL="$LIB/zig-out/lib/libcontract.so"
[ -f "$SLIM" ] || fail "slim artifact missing: $SLIM"
[ -f "$FULL" ] || fail "full artifact missing: $FULL"

python3 - "$SLIM" "$FULL" <<'PY'
import sys

slim = open(sys.argv[1], "rb").read()
full = open(sys.argv[2], "rb").read()

# Positive control first: the FULL library must carry the weights and the
# rank symbols, or this gate is reading the wrong bytes and every "absent"
# assertion below would be vacuous.
assert full.count(b"BGEW") > 0, "full library lost the BGE weights (wrong bytes?)"
assert b"contract_recommend" in full, "full library lost contract_recommend"
assert b"contract_warm_router" in full, "full library lost contract_warm_router"

# The decomposition claims, in bytes.
assert slim.count(b"BGEW") == 0, "slim ledger artifact embeds the BGE weights"
assert b"contract_recommend" not in slim, "slim ledger artifact exports contract_recommend"
assert b"contract_warm_router" not in slim, "slim ledger artifact exports contract_warm_router"

# The slim artifact is a LEDGER, not an empty shell: the core verbs must
# survive the cut.
for symbol in (b"contract_declare", b"contract_free", b"contract_abandon_graph"):
    assert symbol in slim, f"slim ledger artifact lost {symbol.decode()}"

# The cut must be material. Weights alone are 33.5MB; a slim artifact within
# 90% of the full one means the decomposition silently stopped decomposing.
assert len(slim) < len(full) * 0.5, (
    f"slim ({len(slim)}) is not materially smaller than full ({len(full)})"
)
print(f"ok: slim {len(slim)} bytes (rank-free), full {len(full)} bytes (rank intact)")
PY

echo "contract-slim-ledger gate: PASS"
