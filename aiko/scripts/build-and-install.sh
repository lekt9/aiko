#!/bin/sh
# build-and-install.sh — one-shot build → package → install → verify for Aiko.
#
#   1. build    zig build of libcontract + cargo release build of the aiko binary
#   2. package  checksummed installer package under target/aiko-package/
#               (bin/aiko, lib/libcontract.dylib, skills/, sdk/, manifest.json,
#               install.sh, plus a .tar.gz archive)
#   3. install  run the package's own install.sh — installs ~/bin/aiko,
#               ~/.aiko/lib, ~/.aiko/skills, the SDK registry, and on macOS the
#               launchd contract worker
#   4. verify   the installed `aiko --version` must report this repo's commit
#
# Usage: scripts/build-and-install.sh
set -eu

AIKO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Pin the commit BEFORE the build: the binary embeds HEAD at build time, and
# HEAD can move during a long build (e.g. a concurrent commit/push), which
# would make a post-build HEAD read spuriously fail the verification below.
COMMIT=$(git -C "$AIKO_ROOT" rev-parse --short HEAD)

echo "==> build + package + install (contract-runtime.sh install)"
echo "    building from commit $COMMIT"
"$AIKO_ROOT/scripts/contract-runtime.sh" install

echo "==> verify installed binary"
VERSION_OUT=$("${AIKO_BIN_DIR:-$HOME/.local/bin}/aiko" --version 2>&1)
echo "    aiko --version: $VERSION_OUT"
echo "    repo commit:    $COMMIT"
printf '%s\n' "$VERSION_OUT" | grep -q "$COMMIT" || {
    echo "error: installed aiko does not match repo commit $COMMIT" >&2
    exit 1
}
echo "==> done: $VERSION_OUT"
