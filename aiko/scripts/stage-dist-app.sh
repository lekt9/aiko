#!/bin/zsh
# Stage the complete Aiko.app for dist packaging.
#
# Source of truth: the Tauri release bundle (aiko-desktop, aiko-stack,
# frontend/, contract/, icon) plus the freshly built CLI sidecar. The dist
# pipeline (dist/notarize.sh) builds the DMG and pkg from this stage app, so
# ANY missing component here ships a broken installer.
#
# This script exists because that happened three times:
#   - stage app missing frontend/  -> webhost 404 "frontend dist not bundled; API proxy only"
#   - stage app missing aiko-stack -> installed app cannot supervise its stack
#   - stale sidecar (82ca3e11)     -> installed CLI stamped an old commit
# The completeness gate below refuses to stage an app that would ship any of those.
#
# Usage: scripts/stage-dist-app.sh ["Developer ID Application: ... (TEAMID)"]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAURI_BUNDLE="apps/desktop/src-tauri/target/release/bundle/macos/Aiko.app"
CLI="target/release/aiko"
STAGE="dist/stage/Aiko.app"
IDENT="${1:-Developer ID Application: Lewis Tham (547K33EUK7)}"

test -d "$TAURI_BUNDLE" || { echo "missing Tauri bundle: $TAURI_BUNDLE (run tauri build first)" >&2; exit 1; }
test -x "$CLI" || { echo "missing CLI: $CLI (run scripts/contract-runtime.sh build-aiko)" >&2; exit 1; }

echo "== assemble stage app from Tauri bundle =="
rm -rf "$STAGE"
mkdir -p "$(dirname "$STAGE")"
ditto "$TAURI_BUNDLE" "$STAGE"
install -m 755 "$CLI" "$STAGE/Contents/MacOS/aiko"

echo "== completeness gate =="
for f in \
  "$STAGE/Contents/MacOS/aiko" \
  "$STAGE/Contents/MacOS/aiko-desktop" \
  "$STAGE/Contents/MacOS/aiko-stack" \
  "$STAGE/Contents/Resources/frontend/index.html" \
  "$STAGE/Contents/Resources/contract/libcontract.dylib"; do
  test -f "$f" || { echo "STAGE INCOMPLETE: missing $f — refusing to package a broken installer" >&2; exit 1; }
done
echo "all required components present"

SIGN_ARGS=(--force --options runtime -s "$IDENT")
if [[ "$IDENT" != "-" ]]; then
  SIGN_ARGS=(--force --timestamp --options runtime -s "$IDENT")
fi

echo "== sign inner Mach-Os explicitly (--deep does not sign plain dylibs) =="
for bin in aiko aiko-desktop aiko-stack; do
  codesign "${SIGN_ARGS[@]}" "$STAGE/Contents/MacOS/$bin"
done
codesign "${SIGN_ARGS[@]}" "$STAGE/Contents/Resources/contract/libcontract.dylib"

echo "== seal bundle =="
codesign --deep "${SIGN_ARGS[@]}" "$STAGE"

echo "== verify =="
codesign --verify --deep --strict "$STAGE"
"$STAGE/Contents/MacOS/aiko" --version
echo "STAGE OK: $STAGE"
