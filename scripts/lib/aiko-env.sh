# aiko-env.sh — single source of truth for install paths and version pins.
#
# Source from any installer (POSIX sh or bash):
#   . "$AIKO_ROOT/scripts/lib/aiko-env.sh"
#   aiko_env_init   # optional if AIKO_ROOT already set
#
# Truth table:
#   AIKO_HOME     → ~/.aiko
#   AIKO_BIN_DIR  → ~/.local/bin   (only place binaries land; must be on PATH)
#   AIKO_LIB_DIR  → $AIKO_HOME/lib
#   aiko version  → VERSION file (was Cargo.toml in the Rust host repo)
#   SDK pins      → sdk/registry/versions.lock (aiko= must match VERSION)

# Do not `set -e` here — this file is sourced.

aiko_env_root() {
    if [ -n "${AIKO_ROOT:-}" ] && [ -d "$AIKO_ROOT" ]; then
        printf '%s\n' "$AIKO_ROOT"
        return
    fi
    # When sourced from scripts/* or scripts/lib/*
    _here=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd) || _here=
    if [ -n "$_here" ]; then
        case "$_here" in
            */scripts/lib) CDPATH= cd -- "$_here/../.." && pwd; return ;;
            */scripts)     CDPATH= cd -- "$_here/.." && pwd; return ;;
        esac
    fi
    printf '%s\n' "${AIKO_ROOT:-.}"
}

aiko_env_init() {
    AIKO_ROOT=$(aiko_env_root)
    # Fixed destinations — not "guess from PATH". PATH must include AIKO_BIN_DIR.
    AIKO_HOME=${AIKO_HOME:-"$HOME/.aiko"}
    AIKO_BIN_DIR=${AIKO_BIN_DIR:-"$HOME/.local/bin"}
    AIKO_LIB_DIR=${AIKO_LIB_DIR:-"$AIKO_HOME/lib"}
    AIKO_PACKAGE_ROOT=${AIKO_PACKAGE_ROOT:-"$AIKO_ROOT/target/aiko-package"}
    AIKO_VERSIONS_LOCK=${AIKO_VERSIONS_LOCK:-"$AIKO_ROOT/sdk/registry/versions.lock"}
    AIKO_VERSION_FILE=${AIKO_VERSION_FILE:-"$AIKO_ROOT/VERSION"}
    # Platform-correct Contract library name (what aiko actually dlopens).
    case "$(uname -s)" in
        Darwin) AIKO_CONTRACT_LIB_NAME=libcontract.dylib ;;
        Linux)  AIKO_CONTRACT_LIB_NAME=libcontract.so ;;
        *)      AIKO_CONTRACT_LIB_NAME=libcontract.so ;;
    esac
    AIKO_CONTRACT_LIBRARY=${AIKO_CONTRACT_LIBRARY:-"$AIKO_LIB_DIR/$AIKO_CONTRACT_LIB_NAME"}
    export AIKO_ROOT AIKO_HOME AIKO_BIN_DIR AIKO_LIB_DIR AIKO_PACKAGE_ROOT
    export AIKO_CONTRACT_LIB_NAME AIKO_CONTRACT_LIBRARY
}

# True if path exports the symbols Aiko needs to auto-declare turn roots.
aiko_contract_lib_is_native() {
    _lib="${1:-}"
    [ -f "$_lib" ] || return 1
    # Prefer loading the ABI symbol (works for huge libs where nm can be slow/odd).
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$_lib" <<'PY' 2>/dev/null
import ctypes, sys
lib = ctypes.CDLL(sys.argv[1])
if not hasattr(lib, "contract_abi_version"):
    raise SystemExit(1)
if not hasattr(lib, "contract_declare_turn"):
    raise SystemExit(1)
lib.contract_abi_version.restype = ctypes.c_uint
v = int(lib.contract_abi_version())
raise SystemExit(0 if v >= 2 else 1)
PY
        return $?
    fi
    if command -v nm >/dev/null 2>&1; then
        nm -D "$_lib" 2>/dev/null | grep -q 'contract_abi_version' || return 1
        nm -D "$_lib" 2>/dev/null | grep -q 'contract_declare_turn' || return 1
        return 0
    fi
    return 0
}

# Version from VERSION file — the build-time version for the aiko binary.
aiko_cargo_version() {
    aiko_env_init
    cat "$AIKO_VERSION_FILE" 2>/dev/null | tr -d '[:space:]'
}

# Pinned version from versions.lock (registry/publish).
aiko_lock_version() {
    aiko_env_init
    local pkg="${1:-aiko}"
    grep "^${pkg}=" "$AIKO_VERSIONS_LOCK" 2>/dev/null | cut -d= -f2
}

# Ensure versions.lock aiko= matches VERSION file (fail or warn).
aiko_assert_version_sync() {
    aiko_env_init
    local ver lock
    ver=$(aiko_cargo_version)
    lock=$(aiko_lock_version aiko)
    if [ -z "$ver" ]; then
        echo "aiko-env: cannot read version from $AIKO_VERSION_FILE" >&2
        return 1
    fi
    if [ -z "$lock" ]; then
        echo "aiko-env: cannot read aiko= from $AIKO_VERSIONS_LOCK" >&2
        return 1
    fi
    if [ "$ver" != "$lock" ]; then
        echo "aiko-env: version drift — VERSION=$ver versions.lock aiko=$lock" >&2
        echo "  Fix: set aiko=$ver in sdk/registry/versions.lock (single source of truth)" >&2
        return 1
    fi
    return 0
}

# Platform triple used in package names: linux-x86_64, macos-aarch64, …
aiko_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os=macos ;;
        Linux)  os=linux ;;
        *) echo "aiko-env: unsupported OS $(uname -s)" >&2; return 1 ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch=aarch64 ;;
        x86_64|amd64)  arch=x86_64 ;;
        *) echo "aiko-env: unsupported arch $(uname -m)" >&2; return 1 ;;
    esac
    printf '%s-%s\n' "$os" "$arch"
}

# Ensure AIKO_BIN_DIR is on PATH for this process (does not edit shell rc).
aiko_path_export() {
    aiko_env_init
    case ":${PATH:-}:" in
        *:"$AIKO_BIN_DIR":*) ;;
        *) PATH="$AIKO_BIN_DIR:$PATH"; export PATH ;;
    esac
}

# Remove non-SSOT shadow binaries so only AIKO_BIN_DIR/aiko is authoritative.
aiko_remove_shadow_bins() {
    aiko_env_init
    local shadow
    for shadow in "$HOME/bin/aiko" /usr/local/bin/aiko; do
        [ -e "$shadow" ] || [ -L "$shadow" ] || continue
        # Never delete the SSOT path
        case "$shadow" in
            "$AIKO_BIN_DIR/aiko") continue ;;
        esac
        # Skip if same inode as SSOT (hardlink)
        if [ -e "$AIKO_BIN_DIR/aiko" ] && [ "$shadow" -ef "$AIKO_BIN_DIR/aiko" ]; then
            continue
        fi
        echo "aiko-env: removing shadow binary $shadow (SSOT is $AIKO_BIN_DIR/aiko)" >&2
        rm -f "$shadow"
    done
}

# After install: verify command -v aiko is the SSOT path.
aiko_verify_path() {
    aiko_env_init
    aiko_path_export
    if ! command -v aiko >/dev/null 2>&1; then
        echo "aiko-env: aiko not on PATH (expected $AIKO_BIN_DIR/aiko)" >&2
        echo "  Add: export PATH=\"$AIKO_BIN_DIR:\$PATH\"" >&2
        return 1
    fi
    local hit
    hit=$(command -v aiko)
    if [ "$hit" != "$AIKO_BIN_DIR/aiko" ]; then
        echo "aiko-env: PATH resolves aiko → $hit (SSOT is $AIKO_BIN_DIR/aiko)" >&2
        return 1
    fi
    echo "aiko-env: PATH aiko → $hit ($("$hit" --version 2>/dev/null || true))"
}
