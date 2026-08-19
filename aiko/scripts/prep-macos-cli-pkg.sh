#!/bin/zsh
# prep-macos-cli-pkg.sh — build an unsigned macOS CLI product pkg from a portable stack.
#
# Darwin-only. The signed desktop DMG/pkg still comes from prep-installer.sh + Xcode.
# This script is the in-tree path that can run on a Mac with Command Line Tools:
#   1. locate the portable package dir (bin/aiko + install.sh + libcontract.dylib)
#   2. stage a pkg root with /usr/local/bin + /usr/local/lib layout
#   3. pkgbuild ai.aiko.cli → installers/Aiko-macOS-CLI-<version>.pkg
#   4. wrap it as a product pkg via productbuild when distribution.xml is present
#
# Usage:
#   scripts/prep-macos-cli-pkg.sh [portable-dir]
#   AIKO_PORTABLE_DIR=... scripts/prep-macos-cli-pkg.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "prep-macos-cli-pkg.sh must run on macOS (pkgbuild/productbuild)" >&2
  exit 1
fi

CLI_VERSION="$(sed -n -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' crates/codegen/xai-grok-pager-bin/Cargo.toml | head -1)"
[[ -n "$CLI_VERSION" ]] || { echo "could not read Aiko version" >&2; exit 1; }

PORTABLE="${1:-${AIKO_PORTABLE_DIR:-}}"
if [[ -z "$PORTABLE" ]]; then
  plat="$(uname -m)"
  case "$plat" in
    arm64|aarch64) plat=macos-aarch64 ;;
    x86_64) plat=macos-x86_64 ;;
    *) echo "unsupported arch $plat" >&2; exit 1 ;;
  esac
  for cand in \
    "$REPO_ROOT/target/aiko-package/aiko-${CLI_VERSION}-${plat}" \
    "$ROOT/target/aiko-package/aiko-${CLI_VERSION}-${plat}"; do
    [[ -d "$cand" && -x "$cand/bin/aiko" ]] && PORTABLE="$cand" && break
  done
fi
[[ -n "$PORTABLE" && -x "$PORTABLE/bin/aiko" && -f "$PORTABLE/install.sh" ]] || {
  echo "portable package missing (need bin/aiko + install.sh): ${PORTABLE:-unset}" >&2
  exit 1
}

DYLIB=""
for cand in "$PORTABLE/lib/libcontract.dylib" "$PORTABLE/lib/libcontract.so"; do
  if [[ -f "$cand" && ! -L "$cand" ]]; then DYLIB="$cand"; break; fi
done
[[ -n "$DYLIB" ]] || { echo "portable package missing libcontract.dylib" >&2; exit 1; }

OUT_DIR="$REPO_ROOT/installers"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/aiko-cli-pkg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/usr/local/bin" "$STAGE/usr/local/lib" "$OUT_DIR"

install -m 755 "$PORTABLE/bin/aiko" "$STAGE/usr/local/bin/aiko"
[[ -x "$PORTABLE/bin/neuron" ]] && install -m 755 "$PORTABLE/bin/neuron" "$STAGE/usr/local/bin/neuron"
[[ -x "$PORTABLE/bin/aiko-doctor" ]] && install -m 755 "$PORTABLE/bin/aiko-doctor" "$STAGE/usr/local/bin/aiko-doctor"
[[ -x "$PORTABLE/bin/cell" ]] && install -m 755 "$PORTABLE/bin/cell" "$STAGE/usr/local/bin/cell"
install -m 755 "$DYLIB" "$STAGE/usr/local/lib/libcontract.dylib"

COMPONENT="$OUT_DIR/AikoCLI-$CLI_VERSION.pkg"
PRODUCT="$OUT_DIR/Aiko-macOS-CLI-$CLI_VERSION.pkg"
rm -f "$COMPONENT" "$PRODUCT"

pkgbuild --root "$STAGE" \
  --identifier ai.aiko.cli \
  --version "$CLI_VERSION" \
  --install-location / \
  "$COMPONENT"

if [[ -f "$ROOT/installer/macos/distribution.xml" ]]; then
  DIST="$STAGE/distribution.xml"
  python3 - "$ROOT/installer/macos/distribution.xml" "$DIST" "$CLI_VERSION" <<'PY'
import pathlib, sys
src, dest, ver = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
text = src.read_text()
text = text.replace("__APP_VERSION__", ver).replace("__CLI_VERSION__", ver)
dest.write_text(text)
PY
  # Component-only product pkg: CLI identifier is the one we actually built.
  productbuild --package "$COMPONENT" "$PRODUCT" 2>/dev/null || cp "$COMPONENT" "$PRODUCT"
else
  cp "$COMPONENT" "$PRODUCT"
fi

shasum -a 256 "$PRODUCT" | awk '{print $1}' > "$PRODUCT.sha256"
echo "built $PRODUCT ($(du -h "$PRODUCT" | awk '{print $1}'))"
pkgutil --payload-files "$PRODUCT" 2>/dev/null | head -20 || true
