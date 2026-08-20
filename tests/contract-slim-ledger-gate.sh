#!/usr/bin/env bash
# contract-slim-ledger-gate — the ledger-only artifact must not carry rank.
#
# Phase-2 decomposition witness: libcontract publishes slim artifacts
# (`zig build ledger-library` → libcontract_ledger.a and libcontract_ledger.so)
# whose ABI is c_abi.zig minus the four semantic-router exports. Those exports
# are the only path to bge.zig's 33.5MB @embedFile'd BERT weights, so their
# absence is checkable in bytes, not in prose: the BGEW blob magic must not
# appear in the slim artifacts. The shared slim library is what the portable
# install copies to ~/.aiko/lib/libcontract.so.
#
# Falsifier: registering the rank exports unconditionally in c_abi.zig (or
# re-coupling route/bge into any always-analyzed path) makes the BGEW check go
# red. The full library is asserted as the positive control so the witness
# cannot pass by looking at the wrong bytes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/contract/libcontract"

fail() { echo "FAIL contract-slim-ledger: $*" >&2; exit 1; }

(cd "$LIB" && zig build ledger-library -Doptimize=ReleaseFast) || fail "ledger-library build failed"
(cd "$LIB" && zig build -Doptimize=ReleaseFast) || fail "full library build failed"

SLIM="$LIB/zig-out/lib/libcontract_ledger.a"
SLIM_SO="$LIB/zig-out/lib/libcontract_ledger.dylib"
[ -f "$SLIM_SO" ] || SLIM_SO="$LIB/zig-out/lib/libcontract_ledger.so"
FULL="$LIB/zig-out/lib/libcontract.dylib"
[ -f "$FULL" ] || FULL="$LIB/zig-out/lib/libcontract.so"
[ -f "$SLIM" ] || fail "slim artifact missing: $SLIM"
[ -f "$SLIM_SO" ] || fail "slim shared artifact missing: $SLIM_SO"
[ -f "$FULL" ] || fail "full artifact missing: $FULL"

python3 - "$SLIM" "$SLIM_SO" "$FULL" <<'PY'
import sys

slim = open(sys.argv[1], "rb").read()
slim_so = open(sys.argv[2], "rb").read()
full = open(sys.argv[3], "rb").read()

# Positive control first: the FULL library must carry the weights and the
# rank symbols, or this gate is reading the wrong bytes and every "absent"
# assertion below would be vacuous.
assert full.count(b"BGEW") > 0, "full library lost the BGE weights (wrong bytes?)"
assert b"contract_recommend" in full, "full library lost contract_recommend"
assert b"contract_warm_router" in full, "full library lost contract_warm_router"

# The decomposition claims, in bytes — static and the installed shared form.
for label, blob in (("static", slim), ("shared", slim_so)):
    assert blob.count(b"BGEW") == 0, f"slim {label} artifact embeds the BGE weights"
    assert b"contract_recommend" not in blob, f"slim {label} artifact exports contract_recommend"
    assert b"contract_warm_router" not in blob, f"slim {label} artifact exports contract_warm_router"
    for symbol in (b"contract_declare", b"contract_free", b"contract_abandon_graph"):
        assert symbol in blob, f"slim {label} artifact lost {symbol.decode()}"

# The cut must be material. Weights alone are 33.5MB; a slim artifact within
# 90% of the full one means the decomposition silently stopped decomposing.
assert len(slim) < len(full) * 0.5, (
    f"slim ({len(slim)}) is not materially smaller than full ({len(full)})"
)
assert len(slim_so) < len(full) * 0.5, (
    f"slim shared ({len(slim_so)}) is not materially smaller than full ({len(full)})"
)
print(
    f"ok: slim {len(slim)} bytes, slim shared {len(slim_so)} bytes (rank-free), "
    f"full {len(full)} bytes (rank intact)"
)
PY

echo "contract-slim-ledger gate: PASS"
