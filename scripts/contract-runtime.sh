#!/bin/sh
set -eu

AIKO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# In the converged monorepo, contract and neuron live inside the repo root.
DEFAULT_CONTRACT_REPO="$AIKO_ROOT/contract"
CONTRACT_REPO=${AIKO_CONTRACT_REPO:-"$DEFAULT_CONTRACT_REPO"}
CONTRACT_ROOT="$CONTRACT_REPO/libcontract"
TYPED_NEURON_ROOT="$AIKO_ROOT/neuron"
case "$(uname -s)" in
    Darwin)
        CONTRACT_DYLIB="$CONTRACT_ROOT/zig-out/lib/libcontract.dylib"
        CONTRACT_INSTALL_NAME=libcontract.dylib
        ;;
    Linux)
        CONTRACT_DYLIB="$CONTRACT_ROOT/zig-out/lib/libcontract.so"
        CONTRACT_INSTALL_NAME=libcontract.so
        ;;
    *)
        CONTRACT_DYLIB="$CONTRACT_ROOT/zig-out/lib/libcontract.so"
        CONTRACT_INSTALL_NAME=libcontract.so
        ;;
esac
AIKO_PROFILE=${AIKO_BUILD_PROFILE:-release}
AIKO_TARGET_DIR=${AIKO_CARGO_TARGET_DIR:-"$AIKO_ROOT/target"}
PACKAGE_ROOT="$AIKO_ROOT/target/aiko-package"

usage() {
    cat <<'EOF'
Usage: scripts/contract-runtime.sh [command]

Commands:
  build-contract  Build libcontract.dylib from sibling Contract + Neuron repositories.
  build-aiko      Build Aiko + Contract and refresh the combined package (default).
  build-aiko-only Build only the Aiko binary without refreshing a package.
  dev-link        Build Contract and link ~/.aiko/lib to its live zig-out dylib.
  watch           Watch Contract sources, rebuild on edits, and keep dev-link active.
  sync            Copy the current Contract dylib into ~/.aiko/lib.
  package         Build Aiko + Contract and create a checksummed combined tarball.
  install         One-command full install: package, atomic install, SDK bootstrap.
  reinstall       Re-run install from the latest package (no rebuild) + SDK bootstrap.

Environment:
  AIKO_CONTRACT_REPO  Contract repository (default: ../contract)
                      Its sibling ../neuron supplies the typed_neuron package.
  AIKO_BUILD_PROFILE  Cargo profile (default: release)
  AIKO_CARGO_TARGET_DIR
                      Cargo target directory (default: ./target)
  CARGO_INCREMENTAL   Cargo incremental mode (default: 0 for reliable packages)
  AIKO_HOME           Runtime home (default: ~/.aiko) — SSOT in scripts/lib/aiko-env.sh
  AIKO_BIN_DIR        Binary dir (default: ~/.local/bin) — only install location
  GITEA_TOKEN         Optional; enables registry pull for neuron + limbs
EOF
}

require_contract() {
    if [ ! -f "$CONTRACT_ROOT/build.zig" ]; then
        echo "Contract source not found at $CONTRACT_ROOT" >&2
        echo "Set AIKO_CONTRACT_REPO to the Contract repository." >&2
        exit 1
    fi
    if [ ! -f "$TYPED_NEURON_ROOT/build.zig.zon" ] ||
       [ ! -f "$TYPED_NEURON_ROOT/src/wire.zig" ]; then
        echo "Typed Neuron package not found at $TYPED_NEURON_ROOT" >&2
        echo "Contract source builds require sibling contract/ and neuron/ repositories." >&2
        exit 1
    fi
}

build_contract() {
    require_contract
    echo "Building Contract from $CONTRACT_ROOT"
    (cd "$CONTRACT_ROOT" && zig build -Doptimize=ReleaseFast)
    if [ ! -f "$CONTRACT_DYLIB" ]; then
        echo "Contract build did not produce $CONTRACT_DYLIB" >&2
        exit 1
    fi
}

build_aiko_only() {
    echo "Building Aiko with Cargo profile $AIKO_PROFILE"
    (
        cd "$AIKO_ROOT/aiko"
        CARGO_INCREMENTAL=${CARGO_INCREMENTAL:-0} \
            CARGO_TARGET_DIR="$AIKO_TARGET_DIR" \
            cargo build --profile "$AIKO_PROFILE" -p xai-grok-pager-bin --bin aiko
    )
}

profile_dir() {
    if [ "$AIKO_PROFILE" = "dev" ]; then
        printf '%s\n' debug
    else
        printf '%s\n' "$AIKO_PROFILE"
    fi
}

aiko_binary() {
    printf '%s/%s/aiko\n' "$AIKO_TARGET_DIR" "$(profile_dir)"
}

runtime_lib_dir() {
    printf '%s/lib\n' "${AIKO_HOME:-"$HOME/.aiko"}"
}

dev_link() {
    build_contract
    LIB_DIR=$(runtime_lib_dir)
    mkdir -p "$LIB_DIR"
    ln -sfn "$CONTRACT_DYLIB" "$LIB_DIR/$CONTRACT_INSTALL_NAME"
    # Keep alternate extension so older package layouts still resolve.
    if [ "$CONTRACT_INSTALL_NAME" = "libcontract.so" ]; then
        ln -sfn libcontract.so "$LIB_DIR/libcontract.dylib"
    fi
    echo "Linked $LIB_DIR/$CONTRACT_INSTALL_NAME"
    echo "    -> $CONTRACT_DYLIB"
    echo "Rebuild Contract and the next Aiko process will load it automatically."
}

sync_contract() {
    build_contract
    LIB_DIR=$(runtime_lib_dir)
    mkdir -p "$LIB_DIR"
    TMP="$LIB_DIR/.${CONTRACT_INSTALL_NAME}.sync.$$"
    trap 'rm -f "$TMP"' EXIT HUP INT TERM
    install -m 755 "$CONTRACT_DYLIB" "$TMP"
    if [ "$(uname -s)" = "Darwin" ]; then
        codesign --force --sign - "$TMP"
    fi
    mv -f "$TMP" "$LIB_DIR/$CONTRACT_INSTALL_NAME"
    if [ "$CONTRACT_INSTALL_NAME" = "libcontract.so" ]; then
        ln -sfn libcontract.so "$LIB_DIR/libcontract.dylib"
    fi
    trap - EXIT HUP INT TERM
    echo "Synced Contract runtime to $LIB_DIR/$CONTRACT_INSTALL_NAME"
}

watch_contract() {
    dev_link
    STATE_DIR="${AIKO_HOME:-"$HOME/.aiko"}/dev"
    STAMP="$STATE_DIR/contract-watch.stamp"
    mkdir -p "$STATE_DIR"
    touch "$STAMP"
    echo "Watching $CONTRACT_ROOT/src, data, and build.zig (Ctrl-C to stop)"
    while :; do
        if find "$CONTRACT_ROOT/src" "$CONTRACT_ROOT/data" "$CONTRACT_ROOT/build.zig" \
            -type f -newer "$STAMP" -print -quit 2>/dev/null | grep -q .; then
            echo "Contract source changed; rebuilding..."
            if build_contract; then
                touch "$STAMP"
                echo "Contract updated. New Aiko processes will use this build."
            else
                echo "Contract rebuild failed; keeping the previous dylib." >&2
            fi
        fi
        sleep 1
    done
}

sha256_file() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        sha256sum "$1" | awk '{print $1}'
    fi
}

platform_name() {
    case "$(uname -s)" in
        Darwin) OS=macos ;;
        Linux) OS=linux ;;
        *) echo "Unsupported packaging OS: $(uname -s)" >&2; exit 1 ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) ARCH=aarch64 ;;
        x86_64|amd64) ARCH=x86_64 ;;
        *) echo "Unsupported packaging architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    printf '%s-%s\n' "$OS" "$ARCH"
}

package_runtime() {
    # Sequential by default — parallel cargo+zig often OOMs on small hosts
    # (Steam Deck). Opt in with AIKO_PARALLEL_BUILD=1 when RAM is ample.
    # Prefer assembling a full portable stack when binaries already exist and
    # AIKO_PACKAGE_ONLY=1, or after build.
    if [ "${AIKO_PACKAGE_ONLY:-0}" != "1" ]; then
        if [ "${AIKO_PARALLEL_BUILD:-0}" = "1" ]; then
            echo "Building Contract and Aiko in parallel (AIKO_PARALLEL_BUILD=1)..."
            build_contract &
            pid_contract=$!
            build_aiko_only &
            pid_aiko=$!
            wait "$pid_contract" || {
                wait "$pid_aiko" 2>/dev/null || true
                echo "Contract build failed" >&2
                exit 1
            }
            wait "$pid_aiko" || {
                echo "Aiko build failed" >&2
                exit 1
            }
        else
            # On small hosts, skip rebuild if a release aiko already exists.
            if [ "${AIKO_SKIP_BUILD_IF_PRESENT:-1}" = "1" ] && [ -x "$(aiko_binary)" ]; then
                echo "Using existing Aiko binary at $(aiko_binary) (AIKO_SKIP_BUILD_IF_PRESENT=1)"
            else
                # Prefer full-ABI contract from commons when sibling is legacy.
                if ! command -v nm >/dev/null 2>&1 || \
                   ! nm -D "$CONTRACT_DYLIB" 2>/dev/null | grep -q contract_declare_turn; then
                    echo "Sibling Contract lib is not full-ABI; will resolve via assemble-portable" >&2
                else
                    build_contract
                fi
                build_aiko_only
            fi
        fi
    fi

    # One portable stack: aiko + contract + neuron + limbs
    # shellcheck source=lib/aiko-env.sh
    . "$AIKO_ROOT/scripts/lib/aiko-env.sh"
    # shellcheck source=lib/assemble-portable.sh
    . "$AIKO_ROOT/scripts/lib/assemble-portable.sh"
    aiko_env_init
    export AIKO_PORTABLE_AIKO_BIN="${AIKO_PORTABLE_AIKO_BIN:-$(aiko_binary)}"
    if [ ! -x "$AIKO_PORTABLE_AIKO_BIN" ] && [ -x "$HOME/.local/bin/aiko" ]; then
        AIKO_PORTABLE_AIKO_BIN="$HOME/.local/bin/aiko"
    fi
    ARCHIVE=$(assemble_portable_tarball) || {
        echo "Portable package assembly failed" >&2
        exit 1
    }
    DEST=${ARCHIVE%.tar.gz}
    echo "Created package directory: $DEST"
    echo "Created package archive:   $ARCHIVE"
}

latest_package_dir() {
    if [ -f "$AIKO_ROOT/VERSION" ]; then VERSION=$(tr -d " \t\r\n" < "$AIKO_ROOT/VERSION"); else VERSION=$(sed -n -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$AIKO_ROOT/aiko/Cargo.toml" | head -1); fi
    printf '%s\n' "$PACKAGE_ROOT/aiko-$VERSION-$(platform_name)"
}

# After binary/dylib land, bootstrap neuron + limbs when possible.
# Real edge: place_files → sdk_bootstrap. No interactive prompt on reinstall.
bootstrap_sdk() {
    AIKO_HOME_DIR=${AIKO_HOME:-"$HOME/.aiko"}
    REGISTRY="$AIKO_HOME_DIR/sdk/registry"
    INSTALLER=""
    if [ -x "$REGISTRY/bin/aiko-install" ]; then
        INSTALLER="$REGISTRY/bin/aiko-install"
    elif [ -x "$AIKO_ROOT/sdk/registry/bin/aiko-install" ]; then
        INSTALLER="$AIKO_ROOT/sdk/registry/bin/aiko-install"
    fi

    # Prefer aiko-install (full stack, non-interactive) when token or cache works.
    if [ -n "$INSTALLER" ] && [ -n "${GITEA_TOKEN:-}" ]; then
        echo "Bootstrapping neuron + limbs via aiko-install..."
        # Fan-out lives inside aiko-install (independent package downloads).
        "$INSTALLER" neuron || true
        "$INSTALLER" limbs || true
        return 0
    fi

    # Already have the stack — reinstall of aiko binary alone is enough.
    if command -v neuron >/dev/null 2>&1 && [ -d "$AIKO_HOME_DIR/limbs" ] && \
       [ -n "$(ls -A "$AIKO_HOME_DIR/limbs" 2>/dev/null || true)" ]; then
        echo "SDK already present (neuron + limbs); skipping registry pull."
        return 0
    fi

    if [ -n "$INSTALLER" ]; then
        echo "Neuron/limbs not fully present. With registry access:"
        echo "  GITEA_TOKEN=... $INSTALLER"
        echo "Or: curl -sL <gitea>/Unbrowse/aiko/raw/branch/main/sdk/registry/setup.sh | bash"
    fi
}

verify_install() {
    # shellcheck source=lib/aiko-env.sh
    . "$AIKO_ROOT/scripts/lib/aiko-env.sh"
    aiko_env_init
    aiko_path_export
    aiko_verify_path || return 1
    if [ -f "$AIKO_LIB_DIR/libcontract.dylib" ] || [ -f "$AIKO_LIB_DIR/libcontract.so" ]; then
        echo "Verify: Contract runtime present under $AIKO_LIB_DIR/"
    else
        echo "Verify warning: Contract library missing under $AIKO_LIB_DIR/" >&2
    fi
    if command -v neuron >/dev/null 2>&1; then
        echo "Verify: PATH neuron → $(command -v neuron)"
        echo "Verify: $(neuron --version 2>/dev/null | head -1 || echo neuron present)"
    fi
    if [ -d "$AIKO_HOME/limbs" ]; then
        echo "Verify: limbs=$(ls -1 "$AIKO_HOME/limbs" 2>/dev/null | wc -l | tr -d ' ')"
    fi
    aiko_assert_version_sync || true
}

install_runtime() {
    package_runtime
    DEST=$(latest_package_dir)
    "$DEST/install.sh"
    bootstrap_sdk
    verify_install
}

# Reinstall from the latest built package without rebuilding (same destinations).
reinstall_runtime() {
    DEST=$(latest_package_dir)
    if [ ! -x "$DEST/bin/aiko" ] || [ ! -f "$DEST/manifest.json" ]; then
        echo "No package at $DEST — running full install instead." >&2
        install_runtime
        return
    fi
    # Always use the repo's current installer so PATH resolution stays current.
    install -m 755 "$AIKO_ROOT/scripts/install-aiko-package.sh" "$DEST/install.sh"
    echo "Reinstalling from $DEST (no rebuild)..."
    "$DEST/install.sh"
    bootstrap_sdk
    verify_install
}

case "${1:-}" in
    build-contract) build_contract ;;
    build-aiko) package_runtime ;;
    build-aiko-only) build_aiko_only ;;
    dev-link) dev_link ;;
    watch) watch_contract ;;
    sync) sync_contract ;;
    package) package_runtime ;;
    install) install_runtime ;;
    reinstall) reinstall_runtime ;;
    -h|--help|help) usage ;;
    "") package_runtime ;;
    *) echo "Unknown command: $1" >&2; usage >&2; exit 2 ;;
esac
