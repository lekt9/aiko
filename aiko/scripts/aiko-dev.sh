#!/bin/sh
# aiko-dev.sh — run the DEBUG aiko from this working tree, quickly and safely.
#
# Three traps this exists to avoid, all hit for real while building it:
#   1. A debug build embeds no Contract runtime (build.rs is release-only), so
#      it falls back to discovery — and the candidate list includes a sibling
#      ~/Unbrowse/contract-core checkout that can be stale. We pin the library.
#   2. The debug binary silently goes stale. We compare its embedded commit to
#      HEAD and say so rather than letting you test yesterday's code.
#   3. It shares ~/.aiko with the installed binary by default — same skills,
#      sessions and leader. We use ~/.aiko-dev, symlinking only the credential
#      files so you stay signed in without a second copy of any secret.
#
# Usage:  aiko-dev.sh [--build] [aiko args...]
set -eu

AIKO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN="$AIKO_ROOT/target/debug/aiko"
REAL_HOME="${AIKO_REAL_HOME:-$HOME/.aiko}"
DEV_HOME="${AIKO_DEV_HOME:-$HOME/.aiko-dev}"

# Trap 1 — pin the runtime to this tree's build, never a sibling checkout.
CONTRACT_LIB="$AIKO_ROOT/../contract/libcontract/zig-out/lib/libcontract.dylib"
[ -f "$CONTRACT_LIB" ] || CONTRACT_LIB="$AIKO_ROOT/../contract/libcontract/zig-out/lib/libcontract.so"

BUILD=0
if [ "${1:-}" = "--build" ]; then BUILD=1; shift; fi
[ -x "$BIN" ] || BUILD=1

if [ "$BUILD" = "1" ]; then
    echo "aiko-dev: building debug binary (first build is slow; later ones are incremental)" >&2
    (cd "$AIKO_ROOT" && cargo build -p xai-grok-pager-bin --bin aiko)
fi

# Trap 2 — say plainly when the binary predates the tree.
HEAD_SHA=$(git -C "$AIKO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
BIN_VER=$("$BIN" --version 2>/dev/null || echo "unknown")
case "$BIN_VER" in
    *"$HEAD_SHA"*) : ;;
    *) echo "aiko-dev: STALE — binary is [$BIN_VER], tree is [$HEAD_SHA]. Re-run with --build." >&2 ;;
esac

# Trap 3 — isolated home, credentials symlinked (never copied).
mkdir -p "$DEV_HOME"
for f in auth.json config.toml surplus-auth.json agent_id self.json; do
    [ -e "$REAL_HOME/$f" ] && [ ! -e "$DEV_HOME/$f" ] && ln -sfn "$REAL_HOME/$f" "$DEV_HOME/$f"
done
[ -d "$REAL_HOME/keys" ] && [ ! -e "$DEV_HOME/keys" ] && ln -sfn "$REAL_HOME/keys" "$DEV_HOME/keys"

exec env \
    AIKO_HOME="$DEV_HOME" \
    AIKO_CONTRACT_LIBRARY="$CONTRACT_LIB" \
    "$BIN" "$@"
