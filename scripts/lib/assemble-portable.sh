# assemble-portable.sh — assemble the complete Aiko portable product from prebuilt inputs.
# shellcheck shell=sh

_aiko_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

# Hash names, kinds, link targets, and bytes so a directory cannot be changed
# while retaining the manifest's claim about it.
_aiko_tree_sha256() {
    command -v python3 >/dev/null 2>&1 || {
        echo "assemble-portable: python3 is required to package Cell" >&2
        return 1
    }
    python3 - "$1" <<'PY'
import hashlib, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
h = hashlib.sha256()
for path in sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix()):
    rel = path.relative_to(root).as_posix().encode()
    if path.is_symlink():
        kind, payload = b"L", os.readlink(path).encode()
    elif path.is_file():
        kind, payload = b"F", path.read_bytes()
    else:
        continue
    h.update(kind + b"\0" + rel + b"\0" + payload + b"\0")
print(h.hexdigest())
PY
}

_aiko_lib_is_native() {
    aiko_contract_lib_is_native "$1"
}

resolve_portable_contract_lib() {
    aiko_env_init
    if [ -n "${AIKO_PORTABLE_CONTRACT_LIB:-}" ] && [ -f "$AIKO_PORTABLE_CONTRACT_LIB" ]; then
        printf '%s\n' "$AIKO_PORTABLE_CONTRACT_LIB"; return 0
    fi
    _name=${AIKO_CONTRACT_LIB_NAME:-libcontract.so}
    set -- "${AIKO_CONTRACT_LIBRARY:-}" "$AIKO_LIB_DIR/$_name"         "$AIKO_ROOT/contract/libcontract/zig-out/lib/$_name"         "$AIKO_ROOT/../commons/contract/libcontract/zig-out/lib/$_name"         "$HOME/work/commons/contract/libcontract/zig-out/lib/$_name"
    for _p in "$@"; do
        [ -n "$_p" ] && [ -f "$_p" ] && _aiko_lib_is_native "$_p" || continue
        printf '%s\n' "$_p"; return 0
    done
    return 1
}

resolve_portable_aiko_bin() {
    aiko_env_init
    if [ -n "${AIKO_PORTABLE_AIKO_BIN:-}" ] && [ -x "$AIKO_PORTABLE_AIKO_BIN" ]; then
        printf '%s\n' "$AIKO_PORTABLE_AIKO_BIN"; return 0
    fi
    set -- "$AIKO_ROOT/aiko/target/release/aiko" "$AIKO_ROOT/target/release/aiko" "$AIKO_BIN_DIR/aiko"
    for _p in "$@"; do [ -x "$_p" ] && { printf '%s\n' "$_p"; return 0; }; done
    return 1
}

resolve_portable_neuron_bin() {
    aiko_env_init
    if [ -n "${AIKO_PORTABLE_NEURON_BIN:-}" ] && [ -x "$AIKO_PORTABLE_NEURON_BIN" ]; then
        printf '%s\n' "$AIKO_PORTABLE_NEURON_BIN"; return 0
    fi
    set -- "$AIKO_BIN_DIR/neuron" "$AIKO_ROOT/neuron/zig-out/bin/neuron"         "$AIKO_ROOT/../commons/neuron/zig-out/bin/neuron" "$HOME/work/commons/neuron/zig-out/bin/neuron"
    for _p in "$@"; do [ -x "$_p" ] && { printf '%s\n' "$_p"; return 0; }; done
    return 1
}

resolve_portable_limbs_dir() {
    aiko_env_init
    if [ -n "${AIKO_PORTABLE_LIMBS_DIR:-}" ] && [ -d "$AIKO_PORTABLE_LIMBS_DIR" ]; then
        printf '%s\n' "$AIKO_PORTABLE_LIMBS_DIR"; return 0
    fi
    set -- "$AIKO_ROOT/neuron/limbs" "$AIKO_ROOT/../commons/neuron/limbs" "$HOME/work/commons/neuron/limbs"
    for _p in "$@"; do
        [ -d "$_p" ] && [ -n "$(ls -A "$_p" 2>/dev/null || true)" ] || continue
        printf '%s\n' "$_p"; return 0
    done
    return 1
}

resolve_portable_cell_dir() {
    aiko_env_init
    _cell=${AIKO_PORTABLE_CELL_DIR:-"$AIKO_ROOT/cell"}
    [ -f "$_cell/run.py" ] && [ -f "$_cell/helpers.py" ] && [ -f "$_cell/SKILL.md" ] || return 1
    for _dir in primitives patterns schemas system; do [ -d "$_cell/$_dir" ] || return 1; done
    printf '%s\n' "$_cell"
}

resolve_portable_yaml_dir() {
    if [ -n "${AIKO_PORTABLE_YAML_DIR:-}" ] && [ -f "$AIKO_PORTABLE_YAML_DIR/__init__.py" ]; then
        printf '%s\n' "$AIKO_PORTABLE_YAML_DIR"; return 0
    fi
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - <<'PY'
import pathlib, yaml
print(pathlib.Path(yaml.__file__).resolve().parent)
PY
}

assemble_portable_package() {
    aiko_env_init
    _aiko_bin=$(resolve_portable_aiko_bin) || { echo "assemble-portable: bin/aiko source missing" >&2; return 1; }
    _contract_lib=$(resolve_portable_contract_lib) || { echo "assemble-portable: full-ABI Contract library missing" >&2; return 1; }
    _neuron_bin=$(resolve_portable_neuron_bin) || { echo "assemble-portable: bin/neuron source missing" >&2; return 1; }
    _limbs_dir=$(resolve_portable_limbs_dir) || { echo "assemble-portable: Neuron limbs missing" >&2; return 1; }
    _cell_dir=$(resolve_portable_cell_dir) || { echo "assemble-portable: canonical Cell runtime missing" >&2; return 1; }
    _yaml_dir=$(resolve_portable_yaml_dir) || { echo "assemble-portable: PyYAML missing (install it or set AIKO_PORTABLE_YAML_DIR)" >&2; return 1; }
    [ -f "$_yaml_dir/__init__.py" ] || { echo "assemble-portable: invalid PyYAML directory" >&2; return 1; }
    _yaml_version=$(PYTHONPATH=$(dirname "$_yaml_dir") python3 -S -c 'import yaml; print(yaml.__version__)') || {
        echo "assemble-portable: vendored PyYAML version probe failed" >&2
        return 1
    }

    _ver=$(aiko_cargo_version)
    _plat=$(aiko_platform)
    _name="aiko-${_ver}-${_plat}"
    _dest="$AIKO_PACKAGE_ROOT/$_name"
    _lib_name=$AIKO_CONTRACT_LIB_NAME

    mkdir -p "$AIKO_PACKAGE_ROOT"
    [ ! -e "$_dest" ] || mv "$_dest" "$_dest.previous.$(date +%Y%m%d%H%M%S)"
    mkdir -p "$_dest/bin" "$_dest/lib" "$_dest/skills" "$_dest/sdk/registry/bin"         "$_dest/limbs" "$_dest/share/cell/vendor"

    install -m 755 "$_aiko_bin" "$_dest/bin/aiko"
    install -m 755 "$_neuron_bin" "$_dest/bin/neuron"
    install -m 755 "$_contract_lib" "$_dest/lib/$_lib_name"
    if [ "$_lib_name" = libcontract.so ]; then
        ln -sfn libcontract.so "$_dest/lib/libcontract.dylib"
    else
        ln -sfn libcontract.dylib "$_dest/lib/libcontract.so"
    fi

    # Cell's canonical executable surface and the folders referenced by shipped cells.
    install -m 755 "$_cell_dir/run.py" "$_dest/share/cell/run.py"
    install -m 644 "$_cell_dir/helpers.py" "$_dest/share/cell/helpers.py"
    for _file in SKILL.md SPEC.md README.md; do
        [ ! -f "$_cell_dir/$_file" ] || install -m 644 "$_cell_dir/$_file" "$_dest/share/cell/$_file"
    done
    for _dir in primitives patterns schemas system skills docs example; do
        [ ! -d "$_cell_dir/$_dir" ] || cp -R "$_cell_dir/$_dir" "$_dest/share/cell/$_dir"
    done
    cp -R "$_yaml_dir" "$_dest/share/cell/vendor/yaml"
    find "$_dest/share/cell/vendor/yaml" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
    find "$_dest/share/cell/vendor/yaml" -type f \( -name '*.pyc' -o -name '*.so' -o -name '*.dylib' \) -delete 2>/dev/null || true

    cat > "$_dest/bin/cell" <<'CELL'
#!/bin/sh
set -eu
_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$_here/../share/cell/run.py" ]; then
    _cell=$(CDPATH= cd -- "$_here/../share/cell" && pwd)
else
    _cell=${AIKO_CELL_HOME:-"${AIKO_HOME:-$HOME/.aiko}/cell"}
fi
[ -f "$_cell/run.py" ] || { echo "cell: runtime missing at $_cell" >&2; exit 1; }
PYTHONPATH="$_cell/vendor${PYTHONPATH:+:$PYTHONPATH}" export PYTHONPATH
PYTHONDONTWRITEBYTECODE=1 export PYTHONDONTWRITEBYTECODE
exec python3 -S "$_cell/run.py" "$@"
CELL
    chmod 755 "$_dest/bin/cell"

    cp -R "$_limbs_dir/." "$_dest/limbs/"
    install -m 755 "$AIKO_ROOT/scripts/install-aiko-package.sh" "$_dest/install.sh"

    if [ -d "$AIKO_ROOT/sdk/registry" ]; then
        cp -R "$AIKO_ROOT/sdk/registry/bin/." "$_dest/sdk/registry/bin/" 2>/dev/null || true
        for _f in setup.sh versions.lock package.json; do [ ! -f "$AIKO_ROOT/sdk/registry/$_f" ] || cp "$AIKO_ROOT/sdk/registry/$_f" "$_dest/sdk/registry/"; done
    fi

    # Skills live below the Rust host's aiko/.agents tree, not repository-root .agents.
    for _skill in "$AIKO_ROOT"/aiko/.agents/skills/*; do
        [ -f "$_skill/contract-skill.json" ] && [ -f "$_skill/SKILL.md" ] || continue
        cp -R "$_skill" "$_dest/skills/"
    done

    _abi=$(python3 - "$_dest/lib/$_lib_name" <<'PY'
import ctypes, sys
lib = ctypes.CDLL(sys.argv[1])
for symbol in ("contract_abi_version", "contract_declare_turn"):
    if not hasattr(lib, symbol): raise SystemExit("missing " + symbol)
lib.contract_abi_version.restype = ctypes.c_uint
print(int(lib.contract_abi_version()))
PY
) || { echo "assemble-portable: Contract ABI probe failed" >&2; rm -rf "$_dest"; return 1; }
    [ "$_abi" -ge 2 ] || { echo "assemble-portable: Contract ABI $_abi is unsupported" >&2; rm -rf "$_dest"; return 1; }

    _aiko_sha=$(_aiko_sha256 "$_dest/bin/aiko")
    _contract_sha=$(_aiko_sha256 "$_dest/lib/$_lib_name")
    _neuron_sha=$(_aiko_sha256 "$_dest/bin/neuron")
    _cell_sha=$(_aiko_sha256 "$_dest/share/cell/run.py")
    _cell_launcher_sha=$(_aiko_sha256 "$_dest/bin/cell")
    _cell_runtime_sha=$(_aiko_tree_sha256 "$_dest/share/cell")
    _limbs_sha=$(_aiko_tree_sha256 "$_dest/limbs")
    _commit=$(git -C "$AIKO_ROOT" rev-parse HEAD 2>/dev/null || printf unknown)
    [ -z "$(git -C "$AIKO_ROOT" status --porcelain 2>/dev/null || true)" ] && _dirty=false || _dirty=true
    _built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    cat > "$_dest/manifest.json" <<EOF
{
  "format": 3,
  "product": "aiko-portable-stack",
  "version": "$_ver",
  "platform": "$_plat",
  "contract_abi": $_abi,
  "application_runtime": "aiko-native-cdp-v1",
  "components": {
    "aiko": true,
    "contract": true,
    "neuron": true,
    "cell": true,
    "limbs": true
  },
  "aiko_sha256": "$_aiko_sha",
  "contract_sha256": "$_contract_sha",
  "contract_lib_name": "$_lib_name",
  "neuron_sha256": "$_neuron_sha",
  "cell_sha256": "$_cell_sha",
  "cell_launcher_sha256": "$_cell_launcher_sha",
  "cell_runtime_sha256": "$_cell_runtime_sha",
  "cell_yaml_version": "$_yaml_version",
  "limbs_sha256": "$_limbs_sha",
  "aiko_commit": "$_commit",
  "aiko_dirty": $_dirty,
  "built_at": "$_built_at",
  "source": "portable-stack"
}
EOF
    echo "assemble-portable: package dir $_dest" >&2
    printf '%s\n' "$_dest"
}

assemble_portable_tarball() {
    _dest=$(assemble_portable_package) || return 1
    _name=$(basename "$_dest")
    _archive="$AIKO_PACKAGE_ROOT/${_name}.tar.gz"
    [ ! -e "$_archive" ] || mv "$_archive" "$_archive.previous.$(date +%Y%m%d%H%M%S)"
    (cd "$AIKO_PACKAGE_ROOT" && tar -czf "$_archive" "$_name")
    echo "assemble-portable: archive $_archive" >&2
    printf '%s\n' "$_archive"
}
