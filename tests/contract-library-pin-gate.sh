#!/bin/sh
# Falsifier: NativeContract::candidates must treat AIKO_CONTRACT_LIBRARY as a
# pin (no fall-through) and must not load sibling zig-out on release seats.
# Removing either refusal from contract_native.rs makes this gate go red.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC="$ROOT/aiko/crates/codegen/xai-grok-shell/src/contract_native.rs"
INSTALL="$ROOT/scripts/install-aiko-package.sh"

fail() { echo "FAIL contract-library-pin: $*" >&2; exit 1; }

[ -f "$SRC" ] || fail "missing $SRC"
[ -f "$INSTALL" ] || fail "missing $INSTALL"

# Explicit env is the only candidate — fall-through is the Gbear skew.
grep -q 'A pin is a pin' "$SRC" || fail "explicit-library pin comment missing"
grep -q 'fn explicit_library' "$SRC" || fail "explicit_library helper missing"
grep -q 'if let Some(path) = Self::explicit_library' "$SRC" || fail "candidates() does not short-circuit on AIKO_CONTRACT_LIBRARY"
grep -q 'return vec!\[path\]' "$SRC" || fail "explicit library is not the sole candidate"

# Dev-tree zig-out is opt-in, not a silent production fallback.
grep -q 'fn dev_contract_lib_allowed' "$SRC" || fail "dev_contract_lib_allowed missing"
grep -q 'AIKO_ALLOW_DEV_CONTRACT_LIB' "$SRC" || fail "dev-tree fallback is not gated"
grep -q 'if Self::dev_contract_lib_allowed()' "$SRC" || fail "zig-out candidates are not behind the gate"

# Loaded path must be observable. A library with no path is how skew hid.
grep -q 'loaded native Contract library' "$SRC" || fail "load() does not log the winning path"
grep -q 'Library::new(&path)' "$SRC" || fail "load() still moves path into Library::new; cannot log the winner"

# Seat install must not treat SSH launchd failure as a failed stack install.
grep -q 'AIKO_SKIP_BACKGROUND_WORKER' "$INSTALL" || fail "install.sh lost the worker skip"
grep -q 'no GUI session' "$INSTALL" || fail "install.sh still fail-closes on launchctl bootstrap error 5"

# One BIN_DIR. ~/bin as default is the shadow that drifted 0.2.116 vs 0.2.118.
grep -q 'AIKO_BIN_DIR:-"\$HOME/.local/bin"' "$INSTALL" || fail "portable install.sh is not ~/.local/bin"
HOST_INSTALL="$ROOT/aiko/scripts/install-aiko-package.sh"
[ -f "$HOST_INSTALL" ] || fail "missing $HOST_INSTALL"
grep -q 'AIKO_BIN_DIR:-"\$HOME/.local/bin"' "$HOST_INSTALL" || fail "host install.sh still defaults to ~/bin"
grep -q 'AIKO_BIN_DIR" != "\$HOME/.local/bin"' "$HOST_INSTALL" || fail "host worker skip still keys off ~/bin"

echo "PASS contract-library-pin-gate"
