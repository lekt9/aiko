#!/bin/sh
set -eu

AIKO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEFAULT_CONTRACT_REPO=$(CDPATH= cd -- "$AIKO_ROOT/.." && pwd)/contract
CONTRACT_REPO=${AIKO_CONTRACT_REPO:-"$DEFAULT_CONTRACT_REPO"}
CONTRACT_ROOT="$CONTRACT_REPO/libcontract"
CONTRACT_DYLIB="$CONTRACT_ROOT/zig-out/lib/libcontract.dylib"
AIKO_PROFILE=${AIKO_BUILD_PROFILE:-release}
AIKO_TARGET_DIR=${AIKO_CARGO_TARGET_DIR:-"$AIKO_ROOT/target"}
PACKAGE_ROOT="$AIKO_ROOT/target/aiko-package"

usage() {
    cat <<'EOF'
Usage: scripts/contract-runtime.sh [command]

Commands:
  build-contract  Build libcontract.dylib from the sibling Contract repository.
  build-aiko      Build Aiko + Contract and refresh the combined package (default).
  build-aiko-only Build only the Aiko binary without refreshing a package.
  dev-link        Build Contract and link ~/.aiko/lib to its live zig-out dylib.
  watch           Watch Contract sources, rebuild on edits, and keep dev-link active.
  sync            Copy the current Contract dylib into ~/.aiko/lib.
  package         Build Aiko + Contract and create a checksummed combined tarball.
  install         Package, verify, and atomically install both runtime components.

Environment:
  AIKO_CONTRACT_REPO  Contract repository (default: ../contract)
  AIKO_BUILD_PROFILE  Cargo profile (default: release)
  AIKO_CARGO_TARGET_DIR
                      Cargo target directory (default: ./target)
  CARGO_INCREMENTAL   Cargo incremental mode (default: 0 for reliable packages)
  AIKO_HOME           Runtime home (default: ~/.aiko)
  AIKO_BIN_DIR        Installed binary directory (default: ~/bin)
EOF
}

require_contract() {
    if [ ! -f "$CONTRACT_ROOT/build.zig" ]; then
        echo "Contract source not found at $CONTRACT_ROOT" >&2
        echo "Set AIKO_CONTRACT_REPO to the Contract repository." >&2
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
        cd "$AIKO_ROOT"
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
    mkdir -p "$DEST/bin" "$DEST/lib" \
        "$DEST/skills/telegram-contracts/agents" \
        "$DEST/skills/telegram-contracts/assets" \
        "$DEST/skills/telegram-contracts/references" \
        "$DEST/skills/telegram-contracts/scripts"
    install -m 755 "$BIN" "$DEST/bin/aiko"
    install -m 755 "$CONTRACT_DYLIB" "$DEST/lib/libcontract.dylib"
    if [ "$(uname -s)" = "Darwin" ]; then
        codesign --force --sign - "$DEST/lib/libcontract.dylib"
    fi
    install -m 755 "$AIKO_ROOT/scripts/install-aiko-package.sh" "$DEST/install.sh"
    install -m 644 "$AIKO_ROOT/.agents/skills/telegram-contracts/SKILL.md" \
        "$DEST/skills/telegram-contracts/SKILL.md"
    install -m 644 "$AIKO_ROOT/.agents/skills/telegram-contracts/agents/openai.yaml" \
        "$DEST/skills/telegram-contracts/agents/openai.yaml"
    install -m 644 "$AIKO_ROOT/.agents/skills/telegram-contracts/assets/capabilities.json" \
        "$DEST/skills/telegram-contracts/assets/capabilities.json"
    install -m 644 "$AIKO_ROOT/.agents/skills/telegram-contracts/references/telegram-api.md" \
        "$DEST/skills/telegram-contracts/references/telegram-api.md"
    install -m 755 "$AIKO_ROOT/.agents/skills/telegram-contracts/scripts/build_contract_pack.py" \
        "$DEST/skills/telegram-contracts/scripts/build_contract_pack.py"

    AIKO_SHA=$(sha256_file "$DEST/bin/aiko")
    CONTRACT_SHA=$(sha256_file "$DEST/lib/libcontract.dylib")
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
        printf '  "contract_abi": 6,\n'
        printf '  "application_runtime": "aiko-native-cdp-v1",\n'
        printf '  "aiko_sha256": "%s",\n' "$AIKO_SHA"
        printf '  "aiko_commit": "%s",\n' "$AIKO_COMMIT"
        printf '  "aiko_dirty": %s,\n' "$AIKO_DIRTY"
        printf '  "contract_sha256": "%s",\n' "$CONTRACT_SHA"
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
    install) install_runtime ;;
    -h|--help|help) usage ;;
    "") package_runtime ;;
    *) echo "Unknown command: $1" >&2; usage >&2; exit 2 ;;
esac
