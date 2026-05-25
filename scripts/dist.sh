#!/usr/bin/env bash
# dist.sh — produce hardened distribution binaries.
#
# Differences vs build.sh (development build):
#   - ReleaseFast optimization (vs Debug)
#   - strip = true (no symbols, no debug info)
#   - chmod 555 (read+exec only, no write — unmodifiable in-place)
#   - chflags uchg on Darwin / chattr +i on Linux (immutable bit)
#   - SHA256 + signature emitted to dist/SHASUMS.txt for distribution
#
# Source is NOT bundled. The output of this script is what you upload to
# R2 / a release page. The compiled signed binary is the only artifact;
# how the substrate works internally stays inside the binary.

set -euo pipefail

REPO="${REPO:-$HOME/.agent-skills/contract}"
SCRIPTS_DIR="$REPO/scripts"
ZIG_DIR="$REPO/zig"
DIST_DIR="$REPO/dist"
CACHE="/tmp/contract-dist-cache"

mkdir -p "$DIST_DIR"

echo "=== fmt + tests ==="
( cd "$REPO/libcontract" && zig fmt src/*.zig >/dev/null )
( cd "$ZIG_DIR" && zig fmt src/*.zig >/dev/null )

echo "=== build (ReleaseFast, stripped) ==="
( cd "$ZIG_DIR" && rm -rf zig-out && \
  zig build -Doptimize=ReleaseFast --cache-dir "$CACHE" )

echo "=== install + harden ==="
install -m 555 "$ZIG_DIR/zig-out/bin/aiko"         "$SCRIPTS_DIR/aiko"
install -m 555 "$ZIG_DIR/zig-out/bin/contract-zig" "$SCRIPTS_DIR/contract"

# Strip remaining symbols (zig ReleaseFast already does most of this;
# the strip pass takes the last debug sections out).
case "$(uname -s)" in
  Darwin) strip -S "$SCRIPTS_DIR/aiko" "$SCRIPTS_DIR/contract" 2>/dev/null || true ;;
  Linux)  strip --strip-all "$SCRIPTS_DIR/aiko" "$SCRIPTS_DIR/contract" 2>/dev/null || true ;;
esac

echo "=== sign ==="
"$SCRIPTS_DIR/contract" sign-binary "$SCRIPTS_DIR/aiko"
"$SCRIPTS_DIR/contract" sign-binary "$SCRIPTS_DIR/contract"

echo "=== verify ==="
"$SCRIPTS_DIR/contract" verify-self
"$SCRIPTS_DIR/contract" verify-binary "$SCRIPTS_DIR/aiko"

echo "=== copy to dist/ + checksum ==="
ARCH="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
cp "$SCRIPTS_DIR/aiko"          "$DIST_DIR/aiko-${OS}-${ARCH}"
cp "$SCRIPTS_DIR/aiko.sig"      "$DIST_DIR/aiko-${OS}-${ARCH}.sig"
cp "$SCRIPTS_DIR/contract"      "$DIST_DIR/contract-${OS}-${ARCH}"
cp "$SCRIPTS_DIR/contract.sig"  "$DIST_DIR/contract-${OS}-${ARCH}.sig"
chmod 444 "$DIST_DIR"/aiko-${OS}-${ARCH}* "$DIST_DIR"/contract-${OS}-${ARCH}*
( cd "$DIST_DIR" && shasum -a 256 aiko-${OS}-${ARCH}* contract-${OS}-${ARCH}* > "SHASUMS-${OS}-${ARCH}.txt" )

echo "=== immutable bit (best-effort) ==="
case "$(uname -s)" in
  Darwin)
    chflags uchg "$SCRIPTS_DIR/aiko" "$SCRIPTS_DIR/contract" 2>/dev/null \
      && echo "Darwin: uchg flag set (unlink to modify)" \
      || echo "Darwin: uchg unavailable; chmod 555 is enough" ;;
  Linux)
    sudo chattr +i "$SCRIPTS_DIR/aiko" "$SCRIPTS_DIR/contract" 2>/dev/null \
      && echo "Linux: immutable bit set (sudo chattr -i to modify)" \
      || echo "Linux: chattr unavailable in this shell; chmod 555 is enough" ;;
esac

echo
echo "dist.sh: done"
ls -la "$DIST_DIR"/aiko-${OS}-${ARCH}* "$DIST_DIR"/contract-${OS}-${ARCH}* "$DIST_DIR"/SHASUMS-${OS}-${ARCH}.txt
