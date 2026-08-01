# assemble-portable.sh — build one portable Aiko stack package.
#
# Layout (single product):
#   aiko-<version>-<platform>/
#     bin/aiko
#     bin/neuron              (when available)
#     lib/libcontract.{so,dylib}
#     limbs/                  (when available)
#     skills/
#     sdk/registry/
#     manifest.json           (format 2 — aiko + contract + neuron hashes)
#     install.sh
#
# Source (POSIX sh or bash) after aiko-env.sh:
#   . "$AIKO_ROOT/scripts/lib/aiko-env.sh"
#   . "$AIKO_ROOT/scripts/lib/assemble-portable.sh"
#   aiko_env_init
#   assemble_portable_package   # prints package dir path on stdout (last line)
#   assemble_portable_tarball   # also writes .tar.gz; prints archive path
#
# Resolve inputs via env overrides or discovery (no rebuild):
#   AIKO_PORTABLE_AIKO_BIN
#   AIKO_PORTABLE_CONTRACT_LIB
#   AIKO_PORTABLE_NEURON_BIN
#   AIKO_PORTABLE_LIMBS_DIR

# shellcheck shell=sh

_aiko_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

_aiko_lib_is_native() {
    aiko_contract_lib_is_native "$1"
}

# Prefer full-ABI Contract libraries (declare_turn) over legacy stubs.
resolve_portable_contract_lib() {
    aiko_env_init
    if [ -n "${AIKO_PORTABLE_CONTRACT_LIB:-}" ] && [ -f "$AIKO_PORTABLE_CONTRACT_LIB" ]; then
        printf '%s\n' "$AIKO_PORTABLE_CONTRACT_LIB"
        return 0
    fi
    _name=${AIKO_CONTRACT_LIB_NAME:-libcontract.so}
    set -- \
        "${AIKO_CONTRACT_LIBRARY:-}" \
        "$AIKO_LIB_DIR/$_name" \
        "$AIKO_LIB_DIR/libcontract.so" \
        "$AIKO_LIB_DIR/libcontract.dylib" \
        "$AIKO_ROOT/contract/libcontract/zig-out/lib/$_name" \
        "$AIKO_ROOT/../work/commons/contract/libcontract/zig-out/lib/$_name" \
        "$HOME/work/commons/contract/libcontract/zig-out/lib/$_name" \
        "$AIKO_ROOT/../commons/contract/libcontract/zig-out/lib/$_name" \
        "$AIKO_ROOT/../contract/libcontract/zig-out/lib/$_name" \
        "$AIKO_ROOT/../contract/libcontract/zig-out/lib/libcontract.so" \
        "$AIKO_ROOT/../contract/libcontract/zig-out/lib/libcontract.dylib"
    _native=""
    _any=""
    for _p in "$@"; do
        [ -n "$_p" ] && [ -f "$_p" ] || continue
        [ -z "$_any" ] && _any=$_p
        if _aiko_lib_is_native "$_p"; then
            _native=$_p
            break
        fi
    done
    if [ -n "$_native" ]; then
        printf '%s\n' "$_native"
        return 0
    fi
    if [ -n "$_any" ]; then
        echo "assemble-portable: warning: no full-ABI Contract lib found; using $_any (tools may hold)" >&2
        printf '%s\n' "$_any"
        return 0
    fi
    return 1
}

resolve_portable_aiko_bin() {
    aiko_env_init
    if [ -n "${AIKO_PORTABLE_AIKO_BIN:-}" ] && [ -x "$AIKO_PORTABLE_AIKO_BIN" ]; then
        printf '%s\n' "$AIKO_PORTABLE_AIKO_BIN"
        return 0
    fi
    set -- \
        "$AIKO_ROOT/target/release/aiko" \
        "$AIKO_BIN_DIR/aiko" \
        "$HOME/.local/bin/aiko"
    # newest package binary
    for _p in "$AIKO_PACKAGE_ROOT"/aiko-*/bin/aiko; do
        [ -x "$_p" ] || continue
        set -- "$@" "$_p"
    done
    for _p in "$@"; do
        if [ -x "$_p" ]; then
            printf '%s\n' "$_p"
            return 0
        fi
    done
    return 1
}

resolve_portable_neuron_bin() {
    aiko_env_init
    if [ -n "${AIKO_PORTABLE_NEURON_BIN:-}" ] && [ -x "$AIKO_PORTABLE_NEURON_BIN" ]; then
        printf '%s\n' "$AIKO_PORTABLE_NEURON_BIN"
        return 0
    fi
    set -- \
        "$AIKO_BIN_DIR/neuron" \
        "$HOME/.local/bin/neuron" \
        "$AIKO_ROOT/neuron/zig-out/bin/neuron" \
        "$AIKO_ROOT/../neuron/zig-out/bin/neuron" \
        "$HOME/work/commons/neuron/zig-out/bin/neuron" \
        "$AIKO_ROOT/../work/commons/neuron/zig-out/bin/neuron" \
        "$AIKO_ROOT/../commons/neuron/zig-out/bin/neuron"
    for _p in "$@"; do
        if [ -x "$_p" ]; then
            printf '%s\n' "$_p"
            return 0
        fi
    done
    return 1
}

resolve_portable_limbs_dir() {
    aiko_env_init
    if [ -n "${AIKO_PORTABLE_LIMBS_DIR:-}" ] && [ -d "$AIKO_PORTABLE_LIMBS_DIR" ]; then
        printf '%s\n' "$AIKO_PORTABLE_LIMBS_DIR"
        return 0
    fi
    set -- \
        "$AIKO_HOME/limbs" \
        "$AIKO_ROOT/neuron/limbs" \
        "$AIKO_ROOT/../neuron/limbs" \
        "$HOME/work/commons/neuron/limbs" \
        "$AIKO_ROOT/../work/commons/neuron/limbs" \
        "$AIKO_ROOT/../commons/neuron/limbs"
    for _p in "$@"; do
        if [ -d "$_p" ] && [ -n "$(ls -A "$_p" 2>/dev/null || true)" ]; then
            printf '%s\n' "$_p"
            return 0
        fi
    done
    return 1
}

# Assemble package directory. Echoes DEST path as the last line of stdout.
assemble_portable_package() {
    aiko_env_init
    _aiko_bin=$(resolve_portable_aiko_bin) || {
        echo "assemble-portable: aiko binary not found (set AIKO_PORTABLE_AIKO_BIN)" >&2
        return 1
    }
    _contract_lib=$(resolve_portable_contract_lib) || {
        echo "assemble-portable: Contract library not found (set AIKO_PORTABLE_CONTRACT_LIB)" >&2
        return 1
    }
    _neuron_bin=""
    resolve_portable_neuron_bin >/dev/null 2>&1 && _neuron_bin=$(resolve_portable_neuron_bin) || true
    _limbs_dir=""
    resolve_portable_limbs_dir >/dev/null 2>&1 && _limbs_dir=$(resolve_portable_limbs_dir) || true

    _ver=$(aiko_cargo_version)
    _plat=$(aiko_platform)
    _name="aiko-${_ver}-${_plat}"
    _dest="$AIKO_PACKAGE_ROOT/$_name"
    _lib_name=${AIKO_CONTRACT_LIB_NAME}

    echo "assemble-portable: aiko     ← $_aiko_bin" >&2
    echo "assemble-portable: contract ← $_contract_lib" >&2
    if [ -n "$_neuron_bin" ]; then
        echo "assemble-portable: neuron   ← $_neuron_bin" >&2
    else
        echo "assemble-portable: neuron   (missing — package without neuron CLI)" >&2
    fi
    if [ -n "$_limbs_dir" ]; then
        echo "assemble-portable: limbs    ← $_limbs_dir" >&2
    else
        echo "assemble-portable: limbs    (missing)" >&2
    fi

    if ! _aiko_lib_is_native "$_contract_lib"; then
        echo "assemble-portable: ERROR: Contract lib lacks declare_turn/abi_version" >&2
        echo "  Use commons full-ABI build or set AIKO_PORTABLE_CONTRACT_LIB" >&2
        return 1
    fi

    mkdir -p "$AIKO_PACKAGE_ROOT"
    if [ -e "$_dest" ]; then
        mv "$_dest" "$_dest.previous.$(date +%Y%m%d%H%M%S)"
    fi
    mkdir -p "$_dest/bin" "$_dest/lib" "$_dest/skills" "$_dest/sdk/registry/bin" "$_dest/limbs"

    install -m 755 "$_aiko_bin" "$_dest/bin/aiko"
    install -m 755 "$_contract_lib" "$_dest/lib/$_lib_name"
    if [ "$_lib_name" = "libcontract.so" ]; then
        ln -sfn libcontract.so "$_dest/lib/libcontract.dylib"
    elif [ "$_lib_name" = "libcontract.dylib" ]; then
        ln -sfn libcontract.dylib "$_dest/lib/libcontract.so" 2>/dev/null || true
    fi
    if [ -n "$_neuron_bin" ]; then
        install -m 755 "$_neuron_bin" "$_dest/bin/neuron"
    fi
    if [ -n "$_limbs_dir" ]; then
        # Copy limb packages; avoid nesting limbs/limbs
        if [ -d "$_limbs_dir/preemptor" ] || [ -d "$_limbs_dir/shared" ]; then
            cp -R "$_limbs_dir/." "$_dest/limbs/"
        else
            cp -R "$_limbs_dir" "$_dest/limbs/"
        fi
    fi

    install -m 755 "$AIKO_ROOT/scripts/install-aiko-package.sh" "$_dest/install.sh"

    if [ -d "$AIKO_ROOT/sdk/registry" ]; then
        cp -R "$AIKO_ROOT/sdk/registry/bin" "$_dest/sdk/registry/" 2>/dev/null || true
        cp "$AIKO_ROOT/sdk/registry/setup.sh" "$_dest/sdk/registry/" 2>/dev/null || true
        cp "$AIKO_ROOT/sdk/registry/versions.lock" "$_dest/sdk/registry/" 2>/dev/null || true
        cp "$AIKO_ROOT/sdk/registry/package.json" "$_dest/sdk/registry/" 2>/dev/null || true
        chmod 755 "$_dest/sdk/registry/setup.sh" 2>/dev/null || true
        chmod 755 "$_dest/sdk/registry/bin/aiko-install" 2>/dev/null || true
        chmod 755 "$_dest/sdk/registry/bin/aiko-publish" 2>/dev/null || true
    fi

    for _skill in "$AIKO_ROOT"/.agents/skills/*; do
        if [ -f "$_skill/contract-skill.json" ]; then
            cp -R "$_skill" "$_dest/skills/"
        fi
    done
    mkdir -p "$_dest/skills"

    _aiko_sha=$(_aiko_sha256 "$_dest/bin/aiko")
    _contract_sha=$(_aiko_sha256 "$_dest/lib/$_lib_name")
    _neuron_sha=""
    if [ -x "$_dest/bin/neuron" ]; then
        _neuron_sha=$(_aiko_sha256 "$_dest/bin/neuron")
    fi
    _abi=12
    if command -v python3 >/dev/null 2>&1; then
        _abi=$(python3 - "$_dest/lib/$_lib_name" <<'PY' 2>/dev/null || echo 12
import ctypes, sys
lib = ctypes.CDLL(sys.argv[1])
lib.contract_abi_version.restype = ctypes.c_uint
print(lib.contract_abi_version())
PY
)
    fi
    _aiko_commit=$(git -C "$AIKO_ROOT" rev-parse HEAD 2>/dev/null || printf unknown)
    if [ -n "$(git -C "$AIKO_ROOT" status --porcelain 2>/dev/null || true)" ]; then
        _aiko_dirty=true
    else
        _aiko_dirty=false
    fi
    _built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    _has_neuron=false
    [ -n "$_neuron_sha" ] && _has_neuron=true
    _has_limbs=false
    [ -n "$(ls -A "$_dest/limbs" 2>/dev/null || true)" ] && _has_limbs=true

    {
        printf '{\n'
        printf '  "format": 2,\n'
        printf '  "product": "aiko-portable-stack",\n'
        printf '  "version": "%s",\n' "$_ver"
        printf '  "platform": "%s",\n' "$_plat"
        printf '  "contract_abi": %s,\n' "$_abi"
        printf '  "application_runtime": "aiko-native-cdp-v1",\n'
        printf '  "components": {\n'
        printf '    "aiko": true,\n'
        printf '    "contract": true,\n'
        printf '    "neuron": %s,\n' "$_has_neuron"
        printf '    "limbs": %s\n' "$_has_limbs"
        printf '  },\n'
        printf '  "aiko_sha256": "%s",\n' "$_aiko_sha"
        printf '  "aiko_commit": "%s",\n' "$_aiko_commit"
        printf '  "aiko_dirty": %s,\n' "$_aiko_dirty"
        printf '  "contract_sha256": "%s",\n' "$_contract_sha"
        printf '  "contract_lib_name": "%s",\n' "$_lib_name"
        if [ -n "$_neuron_sha" ]; then
            printf '  "neuron_sha256": "%s",\n' "$_neuron_sha"
        fi
        printf '  "built_at": "%s",\n' "$_built_at"
        printf '  "source": "portable-stack"\n'
        printf '}\n'
    } > "$_dest/manifest.json"

    # Keep versions.lock in package in sync with this product version
    if [ -f "$_dest/sdk/registry/versions.lock" ]; then
        if [ "$(uname -s)" = "Darwin" ]; then
            sed -i '' "s/^aiko=.*/aiko=${_ver}/" "$_dest/sdk/registry/versions.lock"
        else
            sed -i "s/^aiko=.*/aiko=${_ver}/" "$_dest/sdk/registry/versions.lock"
        fi
    fi

    echo "assemble-portable: package dir $_dest" >&2
    printf '%s\n' "$_dest"
}

assemble_portable_tarball() {
    _dest=$(assemble_portable_package) || return 1
    _name=$(basename "$_dest")
    _archive="$AIKO_PACKAGE_ROOT/${_name}.tar.gz"
    if [ -e "$_archive" ]; then
        mv "$_archive" "$_archive.previous.$(date +%Y%m%d%H%M%S)"
    fi
    (cd "$AIKO_PACKAGE_ROOT" && tar -czf "$_archive" "$_name")
    echo "assemble-portable: archive $_archive" >&2
    printf '%s\n' "$_archive"
}
