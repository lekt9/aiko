#!/bin/sh
set -eu

AIKO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEFAULT_CONTRACT_REPO=""
for _candidate in "$HOME/Unbrowse/contract-core" "$(CDPATH= cd -- "$AIKO_ROOT/.." && pwd)/contract-core" "$(CDPATH= cd -- "$AIKO_ROOT/.." && pwd)/contract"; do
    if [ -f "$_candidate/libcontract/build.zig" ]; then
        DEFAULT_CONTRACT_REPO="$_candidate"
        break
    fi
done
if [ -z "$DEFAULT_CONTRACT_REPO" ]; then
    DEFAULT_CONTRACT_REPO="$HOME/Unbrowse/contract-core"
fi
CONTRACT_REPO=${AIKO_CONTRACT_REPO:-"$DEFAULT_CONTRACT_REPO"}
CONTRACT_ROOT="$CONTRACT_REPO/libcontract"
# The CLI/MCP-server half of the Contract runtime, built and shipped with the
# dylib rather than assumed to be already on the operator's PATH.
CONTRACT_CLI_ROOT="$CONTRACT_REPO/zig"
TYPED_NEURON_ROOT="$CONTRACT_REPO/../neuron"
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
  cross-package   Cross-compile Aiko + Contract for a non-host target.
                   Requires AIKO_CROSS_TARGET (Rust triple), AIKO_ZIG_TARGET,
                   and AIKO_PLATFORM (e.g. linux-x86_64).
  install         Package, verify, and atomically install both runtime components.

Environment:
  AIKO_CONTRACT_REPO  Contract repository (default: ~/Unbrowse/contract-core, then ../contract-core, then ../contract)
                      Legacy sibling layout requires ../neuron; contract-core does not.
  AIKO_BUILD_PROFILE  Cargo profile (default: release)
  AIKO_CARGO_TARGET_DIR
                      Cargo target directory (default: ./target)
  CARGO_INCREMENTAL   Cargo incremental mode (default: 0 for reliable packages)
  AIKO_HOME           Runtime home (default: ~/.aiko)
  AIKO_BIN_DIR        Installed binary directory (default: ~/bin)
  AIKO_CROSS_TARGET   Rust target triple for cross-compilation (e.g. aarch64-unknown-linux-gnu)
  AIKO_ZIG_TARGET     Zig target for cross-compilation (e.g. aarch64-linux-gnu)
  AIKO_PLATFORM       Platform name for cross-compilation (e.g. linux-aarch64)
EOF
}

require_contract() {
    if [ ! -f "$CONTRACT_ROOT/build.zig" ]; then
        echo "Contract source not found at $CONTRACT_ROOT" >&2
        echo "Set AIKO_CONTRACT_REPO to the Contract repository." >&2
        exit 1
    fi
    # contract-core bundles contract + CLI in one repo (no sibling neuron).
    # Legacy sibling layout requires ../neuron; contract-core does not.
    if [ -f "$CONTRACT_REPO/libcontract/build.zig" ] && [ -f "$CONTRACT_REPO/zig/build.zig" ]; then
        return 0
    fi
    if [ ! -f "$TYPED_NEURON_ROOT/build.zig.zon" ] ||
       [ ! -f "$TYPED_NEURON_ROOT/src/wire.zig" ]; then
        echo "Typed Neuron package not found at $TYPED_NEURON_ROOT" >&2
        echo "Contract source builds require sibling contract/ and neuron/ repositories." >&2
        echo "For contract-core, ensure AIKO_CONTRACT_REPO points to a checkout with libcontract/ and zig/." >&2
        exit 1
    fi
}

build_contract() {
    require_contract
    ZIG_TARGET_ARG=""
    if [ -n "${AIKO_ZIG_TARGET:-}" ]; then
        ZIG_TARGET_ARG="-Dtarget=$AIKO_ZIG_TARGET"
        echo "Building Contract for $AIKO_ZIG_TARGET from $CONTRACT_ROOT"
    else
        echo "Building Contract from $CONTRACT_ROOT"
    fi
    (cd "$CONTRACT_ROOT" && zig build -Doptimize=ReleaseFast $ZIG_TARGET_ARG)
    CONTRACT_DYLIB=$(contract_dylib)
    if [ ! -f "$CONTRACT_DYLIB" ]; then
        echo "Contract build did not produce $CONTRACT_DYLIB" >&2
        exit 1
    fi
    build_contract_cli
}

# The `contract` CLI is part of the runtime, not an optional extra: it is the
# stdio MCP server behind `[mcp_servers.aiko]`, and `contract task begin/verify`
# is how work gets registered and proven. Shipping the dylib without it left a
# package whose own documented workflow could not run — the binary simply was
# not there. Built from the same source tree and optimisation level as the
# dylib so the pair cannot drift apart in a release.
build_contract_cli() {
    CONTRACT_CLI=""
    if [ -d "$CONTRACT_CLI_ROOT" ]; then
        (cd "$CONTRACT_CLI_ROOT" && zig build -Doptimize=ReleaseFast $ZIG_TARGET_ARG)
        for CANDIDATE in "$CONTRACT_CLI_ROOT/zig-out/bin/contract-zig" \
                         "$CONTRACT_CLI_ROOT/zig-out/bin/contract"; do
            if [ -x "$CANDIDATE" ]; then
                CONTRACT_CLI="$CANDIDATE"
                break
            fi
        done
    fi
    # Fall back to the signed artifact committed alongside the sources, so a
    # tree without the CLI build still packages a working `contract`.
    if [ -z "$CONTRACT_CLI" ] && [ -x "$CONTRACT_REPO/scripts/contract" ]; then
        CONTRACT_CLI="$CONTRACT_REPO/scripts/contract"
        echo "Using the committed Contract CLI at $CONTRACT_CLI"
    fi
    if [ -z "$CONTRACT_CLI" ]; then
        echo "No Contract CLI found: built none and $CONTRACT_REPO/scripts/contract is absent" >&2
        exit 1
    fi
}

build_aiko_only() {
    CROSS_ARGS=""
    if [ -n "${AIKO_CROSS_TARGET:-}" ]; then
        CROSS_ARGS="--target $AIKO_CROSS_TARGET"
        echo "Building Aiko for $AIKO_CROSS_TARGET with Cargo profile $AIKO_PROFILE"
    else
        echo "Building Aiko with Cargo profile $AIKO_PROFILE"
    fi
    (
        cd "$AIKO_ROOT"
        CARGO_INCREMENTAL=${CARGO_INCREMENTAL:-0} \
            CARGO_TARGET_DIR="$AIKO_TARGET_DIR" \
            cargo build --profile "$AIKO_PROFILE" -p xai-grok-pager-bin --bin aiko $CROSS_ARGS
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
    if [ -n "${AIKO_CROSS_TARGET:-}" ]; then
        printf '%s/%s/%s/aiko\n' "$AIKO_TARGET_DIR" "$AIKO_CROSS_TARGET" "$(profile_dir)"
    else
        printf '%s/%s/aiko\n' "$AIKO_TARGET_DIR" "$(profile_dir)"
    fi
}

runtime_lib_dir() {
    printf '%s/lib\n' "${AIKO_HOME:-"$HOME/.aiko"}"
}

dev_link() {
    build_contract
    LIB_DIR=$(runtime_lib_dir)
    mkdir -p "$LIB_DIR"
    ln -sfn "$CONTRACT_DYLIB" "$LIB_DIR/libcontract.dylib"
    echo "Linked $LIB_DIR/libcontract.dylib"
    echo "    -> $CONTRACT_DYLIB"
    echo "Rebuild Contract and the next Aiko process will load it automatically."
}

sync_contract() {
    build_contract
    LIB_DIR=$(runtime_lib_dir)
    mkdir -p "$LIB_DIR"
    TMP="$LIB_DIR/.libcontract.dylib.sync.$$"
    trap 'rm -f "$TMP"' EXIT HUP INT TERM
    install -m 755 "$CONTRACT_DYLIB" "$TMP"
    if [ "$(uname -s)" = "Darwin" ]; then
        codesign --force --sign - "$TMP"
    fi
    mv -f "$TMP" "$LIB_DIR/libcontract.dylib"
    trap - EXIT HUP INT TERM
    echo "Synced Contract runtime to $LIB_DIR/libcontract.dylib"
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
    if [ -n "${AIKO_PLATFORM:-}" ]; then
        printf '%s\n' "$AIKO_PLATFORM"
        return
    fi
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

contract_lib_extension() {
    case "${AIKO_PLATFORM:-$(uname -s)}" in
        macos*|Darwin) printf '.dylib' ;;
        linux*|Linux) printf '.so' ;;
        windows*) printf '.dll' ;;
        *) printf '.dylib' ;;
    esac
}

contract_lib_basename() {
    case "${AIKO_PLATFORM:-$(uname -s)}" in
        windows*) printf 'contract' ;;
        *) printf 'libcontract' ;;
    esac
}

contract_dylib() {
    printf '%s/zig-out/lib/%s%s\n' \
        "$CONTRACT_ROOT" \
        "$(contract_lib_basename)" \
        "$(contract_lib_extension)"
}

package_lib_name() {
    printf '%s%s\n' "$(contract_lib_basename)" "$(contract_lib_extension)"
}

package_runtime() {
    build_contract
    build_aiko_only
    BIN=$(aiko_binary)
    if [ ! -x "$BIN" ]; then
        echo "Aiko build did not produce $BIN" >&2
        exit 1
    fi

    VERSION=$(sed -n -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
        "$AIKO_ROOT/crates/codegen/xai-grok-pager-bin/Cargo.toml" | head -1)
    PLATFORM=$(platform_name)
    NAME="aiko-$VERSION-$PLATFORM"
    DEST="$PACKAGE_ROOT/$NAME"
    if [ -e "$DEST" ]; then
        mv "$DEST" "$DEST.previous.$(date +%Y%m%d%H%M%S)"
    fi
    mkdir -p "$DEST/bin" "$DEST/lib" "$DEST/skills" "$DEST/sdk/registry/bin"
    install -m 755 "$BIN" "$DEST/bin/aiko"
    install -m 755 "$CONTRACT_CLI" "$DEST/bin/contract"
    LIB_NAME=$(package_lib_name)
    install -m 755 "$CONTRACT_DYLIB" "$DEST/lib/$LIB_NAME"
    if [ "$(uname -s)" = "Darwin" ] && [ "${AIKO_PLATFORM:-}" = macos* ] || [ -z "${AIKO_PLATFORM:-}" ] && [ "$(uname -s)" = "Darwin" ]; then
        codesign --force --sign - "$DEST/lib/$LIB_NAME"
    fi
    install -m 755 "$AIKO_ROOT/scripts/install-aiko-package.sh" "$DEST/install.sh"
    # Default post-install self-check: contract-shaped graph written to
    # ~/.aiko/postmortem/ so a failed install is postmortem-able, not a claim.
    if [ -f "$AIKO_ROOT/scripts/aiko-install-selfcheck.sh" ]; then
        install -m 755 "$AIKO_ROOT/scripts/aiko-install-selfcheck.sh" "$DEST/selfcheck.sh"
    fi
    install -m 755 "$AIKO_ROOT/scripts/witness-contract-native-compatibility.sh" \
        "$DEST/contract-selfcheck.sh"
    # SDK registry — self-bootstrapping installer for contract + neuron + limbs
    if [ -d "$AIKO_ROOT/sdk/registry" ]; then
        cp -R "$AIKO_ROOT/sdk/registry/bin" "$DEST/sdk/registry/"
        cp "$AIKO_ROOT/sdk/registry/setup.sh" "$DEST/sdk/registry/"
        cp "$AIKO_ROOT/sdk/registry/versions.lock" "$DEST/sdk/registry/"
        cp "$AIKO_ROOT/sdk/registry/package.json" "$DEST/sdk/registry/"
        chmod 755 "$DEST/sdk/registry/setup.sh"
        chmod 755 "$DEST/sdk/registry/bin/aiko-install"
        chmod 755 "$DEST/sdk/registry/bin/aiko-publish"
    fi
    for SKILL_DIR in "$AIKO_ROOT"/.agents/skills/*; do
        if [ -f "$SKILL_DIR/contract-skill.json" ]; then
            cp -R "$SKILL_DIR" "$DEST/skills/"
        fi
    done

    AIKO_SHA=$(sha256_file "$DEST/bin/aiko")
    CONTRACT_SHA=$(sha256_file "$DEST/lib/$LIB_NAME")
    CONTRACT_CLI_SHA=$(sha256_file "$DEST/bin/contract")
    AIKO_COMMIT=$(git -C "$AIKO_ROOT" rev-parse HEAD 2>/dev/null || printf unknown)
    if [ -n "$(git -C "$AIKO_ROOT" status --porcelain 2>/dev/null || true)" ]; then
        AIKO_DIRTY=true
    else
        AIKO_DIRTY=false
    fi
    CONTRACT_COMMIT=$(git -C "$CONTRACT_REPO" rev-parse HEAD 2>/dev/null || printf unknown)
    if [ -n "$(git -C "$CONTRACT_REPO" status --porcelain 2>/dev/null || true)" ]; then
        CONTRACT_DIRTY=true
    else
        CONTRACT_DIRTY=false
    fi
    BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    {
        printf '{\n'
        printf '  "format": 1,\n'
        printf '  "version": "%s",\n' "$VERSION"
        printf '  "platform": "%s",\n' "$PLATFORM"
        printf '  "contract_abi": 13,\n'
        printf '  "application_runtime": "aiko-native-cdp-v1",\n'
        printf '  "aiko_sha256": "%s",\n' "$AIKO_SHA"
        printf '  "aiko_commit": "%s",\n' "$AIKO_COMMIT"
        printf '  "aiko_dirty": %s,\n' "$AIKO_DIRTY"
        printf '  "contract_sha256": "%s",\n' "$CONTRACT_SHA"
        printf '  "contract_cli_sha256": "%s",\n' "$CONTRACT_CLI_SHA"
        printf '  "contract_commit": "%s",\n' "$CONTRACT_COMMIT"
        printf '  "contract_dirty": %s,\n' "$CONTRACT_DIRTY"
        printf '  "built_at": "%s"\n' "$BUILT_AT"
        printf '}\n'
    } > "$DEST/manifest.json"

    ARCHIVE="$PACKAGE_ROOT/$NAME.tar.gz"
    if [ -e "$ARCHIVE" ]; then
        mv "$ARCHIVE" "$ARCHIVE.previous.$(date +%Y%m%d%H%M%S)"
    fi
    (cd "$PACKAGE_ROOT" && tar -czf "$ARCHIVE" "$NAME")
    echo "Created package directory: $DEST"
    echo "Created package archive:   $ARCHIVE"
    # Prove the package is installable without a second full cargo build.
    if [ "${AIKO_SKIP_PACKAGE_WITNESS:-0}" != "1" ] && \
       [ -x "$AIKO_ROOT/scripts/package-installable-witness.sh" ]; then
        if ! "$AIKO_ROOT/scripts/package-installable-witness.sh" "$DEST"; then
            echo "Package installable witness failed for $DEST" >&2
            exit 1
        fi
    fi
}

cross_package() {
    if [ -z "${AIKO_CROSS_TARGET:-}" ] || [ -z "${AIKO_ZIG_TARGET:-}" ] || [ -z "${AIKO_PLATFORM:-}" ]; then
        echo "cross-package requires AIKO_CROSS_TARGET (Rust triple)," >&2
        echo "AIKO_ZIG_TARGET, and AIKO_PLATFORM to be set." >&2
        echo "Example: AIKO_CROSS_TARGET=aarch64-unknown-linux-gnu \\" >&2
        echo "         AIKO_ZIG_TARGET=aarch64-linux-gnu \\" >&2
        echo "         AIKO_PLATFORM=linux-aarch64 \\" >&2
        echo "         scripts/contract-runtime.sh cross-package" >&2
        exit 1
    fi
    package_runtime
}

install_runtime() {
    package_runtime
    VERSION=$(sed -n -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
        "$AIKO_ROOT/crates/codegen/xai-grok-pager-bin/Cargo.toml" | head -1)
    "$PACKAGE_ROOT/aiko-$VERSION-$(platform_name)/install.sh"
}

case "${1:-}" in
    build-contract) build_contract ;;
    build-aiko) package_runtime ;;
    build-aiko-only) build_aiko_only ;;
    dev-link) dev_link ;;
    watch) watch_contract ;;
    sync) sync_contract ;;
    package) package_runtime ;;
    cross-package) cross_package ;;
    install) install_runtime ;;
    -h|--help|help) usage ;;
    "") package_runtime ;;
    *) echo "Unknown command: $1" >&2; usage >&2; exit 2 ;;
esac
