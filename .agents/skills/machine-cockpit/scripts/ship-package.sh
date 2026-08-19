#!/bin/sh
# Ship one already-assembled portable Aiko stack to a seat and install it.
# Refuses a lone-binary copy: the package is aiko + libcontract + neuron + cell.
set -eu

usage() {
    echo "usage: ship-package.sh <ssh-host> [tarball]" >&2
    echo "  default tarball: <repo>/target/aiko-package/aiko-*-macos-aarch64.tar.gz (newest)" >&2
    exit 2
}

HOST="${1:-}"
[ -n "$HOST" ] || usage
shift

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../../.." && pwd)
PKG_ROOT="$REPO/target/aiko-package"

if [ -n "${1:-}" ]; then
    TARBALL=$1
else
    TARBALL=$(ls -t "$PKG_ROOT"/aiko-*-macos-aarch64.tar.gz 2>/dev/null | head -1 || true)
fi
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || {
    echo "ship-package: no portable tarball at $PKG_ROOT" >&2
    echo "  assemble first: AIKO_PACKAGE_ONLY=1 bash -c 'source scripts/lib/aiko-env.sh; aiko_env_init; source scripts/lib/assemble-portable.sh; assemble_portable_tarball'" >&2
    exit 1
}

NAME=$(basename "$TARBALL" .tar.gz)
DIR=$PKG_ROOT/$NAME
MANIFEST=$DIR/manifest.json
[ -f "$MANIFEST" ] || {
    echo "ship-package: unpacked package missing $MANIFEST" >&2
    exit 1
}
expected_aiko=$(sed -n -E 's/.*"aiko_sha256"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$MANIFEST" | head -1)
expected_lib=$(sed -n -E 's/.*"contract_sha256"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$MANIFEST" | head -1)
[ -n "$expected_aiko" ] && [ -n "$expected_lib" ] || {
    echo "ship-package: manifest missing aiko_sha256 / contract_sha256" >&2
    exit 1
}
echo "ship-package: $TARBALL -> $HOST:/tmp/aiko-package.tar.gz"
echo "ship-package: expect aiko=$expected_aiko"
echo "ship-package: expect lib =$expected_lib"

# One scp in this process, then one ssh. No ControlMaster multiplex with the
# admitting shell — isolate the transfer fds from ledger admission.
scp -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=20 \
    "$TARBALL" "$HOST:/tmp/aiko-package.tar.gz"

ssh -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=20 "$HOST" \
    "set -eu
     mkdir -p \$HOME/src/aiko-package
     rm -rf \$HOME/src/aiko-package/$NAME
     tar -xzf /tmp/aiko-package.tar.gz -C \$HOME/src/aiko-package
     AIKO_SKIP_BACKGROUND_WORKER=1 bash \$HOME/src/aiko-package/$NAME/install.sh
     echo ---WITNESS---
     \$HOME/.local/bin/aiko --version
     python3 - \$HOME/.aiko/lib/libcontract.dylib \$HOME/.local/bin/aiko $expected_aiko $expected_lib <<'PY'
import ctypes, hashlib, pathlib, sys
lib_path, bin_path, expect_aiko, expect_lib = sys.argv[1:5]
def sha(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
got_aiko, got_lib = sha(bin_path), sha(lib_path)
print('aiko_sha256', got_aiko)
print('contract_sha256', got_lib)
if got_aiko != expect_aiko:
    raise SystemExit('aiko digest mismatch: installed != package manifest')
if got_lib != expect_lib:
    raise SystemExit('libcontract digest mismatch: installed != package manifest')
lib = ctypes.CDLL(lib_path)
lib.contract_abi_version.restype = ctypes.c_uint
abi = int(lib.contract_abi_version())
print('abi', abi)
print('declare_turn', hasattr(lib, 'contract_declare_turn'))
if abi < 13:
    raise SystemExit('ABI %s < 13' % abi)
print('PIN_OK')
PY
     rm -f /tmp/aiko-package.tar.gz
    "
