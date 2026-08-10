#!/bin/zsh
# prep-installer.sh — recreate, sign (when possible), and verify the Aiko macOS product pkg.
#
# What it does (idempotent, local, reversible — it only writes under dist/):
#   1. recreates dist/stage/Aiko.app from the current Tauri release bundle
#   2. refreshes dist/cli-root/usr/local/bin/aiko from the freshest built binary
#      and re-signs it with the Developer ID Application identity
#   3. rebuilds the two component pkgs:
#        dist/pkg/AikoApp.pkg  (from staged Aiko.app)
#        dist/pkg/AikoCLI.pkg  (from cli-root)
#   4. rebuilds the distribution pkg, named for the packaged Aiko CLI version:
#        dist/Aiko-Installer-<version>.pkg  (via productbuild + distribution.xml)
#   5. signs the product pkg with Developer ID Installer when that identity exists,
#      otherwise leaves it unsigned and prints the exact CSR import step
#   6. verifies every artifact (codesign, pkgutil, spctl, payload list) and prints
#      a summary with paths, sizes, shasums, and signature state
#   7. re-zips the product pkg to dist/Aiko-Installer-<version>.pkg.zip
#
# Usage:
#   scripts/prep-installer.sh [--notarize] [--app-version VERSION] [--cli-version VERSION]
#   scripts/prep-installer.sh --check        # verify only, do not rebuild
#   scripts/prep-installer.sh --help
#
# Notes:
#   - Notarization is opt-in (--notarize) and still requires:
#       xcrun notarytool store-credentials aiko --apple-id ... --team-id 547K33EUK7
#     and a Developer ID Installer cert for the product pkg step.
#     Without --notarize the script still produces a locally-verifiable pkg.
#   - The script never deletes your keychain or uploads anything unless you pass --notarize.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DIST="$ROOT/dist"
STAGE="$DIST/stage/Aiko.app"
CLI_ROOT="$DIST/cli-root"
CLI_BIN="$CLI_ROOT/usr/local/bin/aiko"
STAGE_CLI="$STAGE/Contents/MacOS/aiko"
PKG_DIR="$DIST/pkg"
APP_PKG="$PKG_DIR/AikoApp.pkg"
CLI_PKG="$PKG_DIR/AikoCLI.pkg"
DISTRIBUTION_XML="$PKG_DIR/distribution.xml"
INSTALLER_SOURCE="$ROOT/installer/macos"
IDENT_APP="${AIKO_APP_SIGNING_IDENTITY:-Developer ID Application: Lewis Tham (547K33EUK7)}"
IDENT_INSTALLER="${AIKO_INSTALLER_SIGNING_IDENTITY:-Developer ID Installer: Lewis Tham (547K33EUK7)}"

# versions default to source of truth
APP_VERSION="$(python3 -c "import json; print(json.load(open('apps/desktop/src-tauri/tauri.conf.json'))['version'])" 2>/dev/null || true)"
if [[ -z "$APP_VERSION" ]]; then
  echo "could not read the desktop version from apps/desktop/src-tauri/tauri.conf.json" >&2
  exit 1
fi
CLI_VERSION="$(sed -n -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' crates/codegen/xai-grok-pager-bin/Cargo.toml | head -1)"
if [[ -z "$CLI_VERSION" ]]; then
  echo "could not read the Aiko version from crates/codegen/xai-grok-pager-bin/Cargo.toml" >&2
  exit 1
fi

DO_NOTARIZE=0
DO_CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --notarize) DO_NOTARIZE=1; shift ;;
    --check) DO_CHECK_ONLY=1; shift ;;
    --app-version) APP_VERSION="$2"; shift 2 ;;
    --cli-version) CLI_VERSION="$2"; shift 2 ;;
    --help|-h)
      sed -n '1,120p' "$0" | sed -n '2,40p'
      echo ""
      echo "Options:"
      echo "  --notarize           also run notarytool submit + stapler (requires keychain profile 'aiko')"
      echo "  --check              verify existing artifacts only, do not rebuild"
      echo "  --app-version VER    override Aiko.app version (default: $APP_VERSION)"
      echo "  --cli-version VER    override CLI version (default: $CLI_VERSION)"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

PRODUCT_PKG="$DIST/Aiko-Installer-$CLI_VERSION.pkg"
PRODUCT_ZIP="$DIST/Aiko-Installer-$CLI_VERSION.pkg.zip"

# pretty
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { print -P "%F{blue}==%f $*"; }
ok()    { print -P "%F{green}✔%f $*"; }
warn()  { print -P "%F{yellow}!!%f $*"; }
fail()  { print -P "%F{red}✘%f $*" >&2; exit 1; }

have_ident() {
  security find-identity -v 2>/dev/null | grep -q "$1"
}

stage_app() {
  local sign_ident="$IDENT_APP"
  if ! have_ident "$IDENT_APP"; then
    sign_ident="-"
    warn "no Developer ID Application identity — staging with an ad-hoc signature"
  fi
  "$ROOT/scripts/stage-dist-app.sh" "$sign_ident"
}

if [[ "$APP_VERSION" != "$CLI_VERSION" ]]; then
  fail "desktop version $APP_VERSION does not match Aiko CLI $CLI_VERSION — run the README release-version step before building the Tauri bundle"
fi

prepare_installer_metadata() {
  [[ -f "$INSTALLER_SOURCE/distribution.xml" ]] || fail "missing installer template: $INSTALLER_SOURCE/distribution.xml"
  [[ -f "$INSTALLER_SOURCE/resources/welcome.html" ]] || fail "missing installer resource: $INSTALLER_SOURCE/resources/welcome.html"
  mkdir -p "$PKG_DIR/resources"
  cp "$INSTALLER_SOURCE/distribution.xml" "$DISTRIBUTION_XML"
  cp "$INSTALLER_SOURCE/resources/welcome.html" "$PKG_DIR/resources/welcome.html"
  python3 - "$DISTRIBUTION_XML" "$APP_VERSION" "$CLI_VERSION" << 'PY'
import pathlib, sys

path = pathlib.Path(sys.argv[1])
source = path.read_text()
source = source.replace("__APP_VERSION__", sys.argv[2])
source = source.replace("__CLI_VERSION__", sys.argv[3])
if "__APP_VERSION__" in source or "__CLI_VERSION__" in source:
    raise SystemExit("installer version placeholders were not fully replaced")
path.write_text(source)
PY
}

notarize_pkg() {
  local -a notary_auth
  if [[ -n "${APPLE_ID:-}" || -n "${APPLE_PASSWORD:-}" || -n "${APPLE_TEAM_ID:-}" ]]; then
    [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] || \
      fail "APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID must be configured together"
    notary_auth=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
  else
    notary_auth=(--keychain-profile "${AIKO_NOTARY_PROFILE:-aiko}")
  fi

  # Submit once, then poll explicitly. `notarytool submit --wait` has crashed
  # after returning a valid submission ID on hosted macOS runners; polling
  # preserves that accepted server-side job and makes transient client crashes
  # retryable instead of rebuilding and resubmitting the entire installer.
  local submission_json submission_id status_json notary_status
  submission_json="$(xcrun notarytool submit "$PRODUCT_PKG" "${notary_auth[@]}" --output-format json)"
  printf '%s\n' "$submission_json"
  submission_id="$(printf '%s' "$submission_json" | python3 -c \
    'import json, sys; print(json.load(sys.stdin).get("id", ""))')"
  [[ -n "$submission_id" ]] || fail "notarytool submit did not return a submission ID"

  local poll_seconds="${AIKO_NOTARY_POLL_SECONDS:-15}"
  local deadline=$((SECONDS + ${AIKO_NOTARY_TIMEOUT_SECONDS:-1800}))
  local accepted=0
  while (( SECONDS < deadline )); do
    if status_json="$(xcrun notarytool info "$submission_id" "${notary_auth[@]}" --output-format json 2>&1)"; then
      printf '%s\n' "$status_json"
      notary_status="$(printf '%s' "$status_json" | python3 -c \
        'import json, sys; print(json.load(sys.stdin).get("status", ""))')"
      case "$notary_status" in
        Accepted)
          accepted=1
          break
          ;;
        Invalid|Rejected)
          xcrun notarytool log "$submission_id" "${notary_auth[@]}" || true
          fail "product pkg notarization was rejected ($notary_status)"
          ;;
        "In Progress") ;;
        *) warn "unexpected notarization status '$notary_status'; retrying" ;;
      esac
    else
      warn "notarytool info failed; retrying submission $submission_id"
    fi
    sleep "$poll_seconds"
  done
  [[ $accepted -eq 1 ]] || fail "product pkg notarization timed out for submission $submission_id"
  xcrun stapler staple "$PRODUCT_PKG"
}

# ---- check-only mode -------------------------------------------------------
verify_only() {
  info "verify-only: checking $PRODUCT_PKG"
  echo ""
  info "stage app"
  if [[ -d "$STAGE" ]]; then
    codesign --verify --deep --strict "$STAGE" 2>&1 && ok "stage codesign verify" || fail "stage codesign verify"
    spctl -a -vv -t install "$STAGE" 2>&1 | head -n 5 || true
    STAGE_VERSION="$("$STAGE_CLI" --version 2>&1 | sed -nE 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1)"
    [[ "$STAGE_VERSION" == "$CLI_VERSION" ]] || fail "stage CLI is $STAGE_VERSION, expected $CLI_VERSION"
    ok "stage CLI version $STAGE_VERSION"
    STAGE_APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$STAGE/Contents/Info.plist" 2>/dev/null || true)"
    [[ "$STAGE_APP_VERSION" == "$APP_VERSION" ]] || fail "stage app is $STAGE_APP_VERSION, expected $APP_VERSION"
    ok "stage app version $STAGE_APP_VERSION"
  else
    fail "missing $STAGE"
  fi
  echo ""
  info "cli-root binary"
  if [[ -x "$CLI_BIN" ]]; then
    codesign -dv "$CLI_BIN" 2>&1 | head -n 8 || true
    codesign --verify --strict "$CLI_BIN" 2>&1 && ok "cli-root codesign verify" || fail "cli-root codesign"
    ROOT_VERSION="$("$CLI_BIN" --version 2>&1 | sed -nE 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1)"
    [[ "$ROOT_VERSION" == "$CLI_VERSION" ]] || fail "cli-root is $ROOT_VERSION, expected $CLI_VERSION"
    ok "cli-root version $ROOT_VERSION"
  else
    fail "missing $CLI_BIN"
  fi
  echo ""
  info "component pkgs"
  ls -lh "$APP_PKG" "$CLI_PKG" 2>&1 || fail "component pkgs missing"
  pkgutil --payload-files "$CLI_PKG" 2>&1 | head -n 20 || true
  echo ""
  info "product pkg"
  if [[ -f "$PRODUCT_PKG" ]]; then
    ls -lh "$PRODUCT_PKG" 2>&1
    shasum -a 256 "$PRODUCT_PKG" | awk '{print "sha256 " $1}' || true
    pkgutil --check-signature "$PRODUCT_PKG" 2>&1 || true
    spctl -a -vv -t install "$PRODUCT_PKG" 2>&1 || true
    # expand sanity
    rm -rf /tmp/_prep_check_expand
    pkgutil --expand "$PRODUCT_PKG" /tmp/_prep_check_expand 2>&1 && ok "pkgutil --expand ok" || fail "pkgutil --expand failed"
    grep -q "id=\"ai.aiko.cli\" version=\"$CLI_VERSION\"" /tmp/_prep_check_expand/Distribution || \
      fail "expanded installer does not declare CLI version $CLI_VERSION"
    [[ -f "$PRODUCT_ZIP" ]] || fail "missing $PRODUCT_ZIP"
    unzip -tq "$PRODUCT_ZIP" >/dev/null || fail "invalid installer zip: $PRODUCT_ZIP"
    unzip -Z1 "$PRODUCT_ZIP" | grep -q "Aiko-Installer-$CLI_VERSION.pkg$" || \
      fail "installer zip does not contain Aiko-Installer-$CLI_VERSION.pkg"
    ok "installer zip contains Aiko-Installer-$CLI_VERSION.pkg"
    ls -R /tmp/_prep_check_expand 2>&1 | head -n 40 || true
    cat /tmp/_prep_check_expand/Distribution 2>&1 | head -n 40 || true
  else
    fail "missing $PRODUCT_PKG"
  fi
  echo ""
  if have_ident "$IDENT_INSTALLER"; then
    ok "Developer ID Installer identity present"
  else
    warn "no Developer ID Installer identity — product pkg will be unsigned"
    echo "   create it: upload $DIST/csr/developer_id_installer.certSigningRequest at"
    echo "   https://developer.apple.com/account/resources/certificates/add (Developer ID Installer)"
    echo "   then: $DIST/import-installer-cert.sh <path/to/developerID_installer.cer>"
  fi
  if have_ident "$IDENT_APP"; then
    ok "Developer ID Application identity present ($IDENT_APP)"
  else
    warn "no Developer ID Application identity"
  fi
}

if [[ $DO_CHECK_ONLY -eq 1 ]]; then
  verify_only
  exit 0
fi

# ---- 1. recreate stage ------------------------------------------------------
info "1/7 recreate stage from the current Tauri bundle"
prepare_installer_metadata
stage_app

# hard gate after stage
for f in \
  "$STAGE/Contents/MacOS/aiko" \
  "$STAGE/Contents/MacOS/aiko-desktop" \
  "$STAGE/Contents/MacOS/aiko-stack" \
  "$STAGE/Contents/Resources/frontend/index.html" \
  "$STAGE/Contents/Resources/contract/libcontract.dylib"; do
  if [[ ! -f "$f" ]]; then
    fail "STAGE INCOMPLETE: $f missing — aborting (run scripts/stage-dist-app.sh manually)"
    exit 1
  fi
done
ok "stage complete: $STAGE"
"$STAGE_CLI" --version 2>&1 | head -n 1 || true
STAGE_APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$STAGE/Contents/Info.plist" 2>/dev/null || true)"
[[ "$STAGE_APP_VERSION" == "$APP_VERSION" ]] || fail "stage app is $STAGE_APP_VERSION, expected $APP_VERSION"

# ---- 2. cli-root refresh + sign -------------------------------------------
info "2/7 cli-root refresh"
mkdir -p "$CLI_ROOT/usr/local/bin"
# choose freshest binary
SRC=""
for c in "$ROOT/target/release/aiko" "$STAGE_CLI" ; do
  if [[ -x "$c" ]]; then SRC="$c"; break; fi
done
if [[ -z "$SRC" ]]; then
  fail "no aiko binary found (target/release/aiko or $STAGE_CLI)"
  exit 1
fi
info "source: $SRC ($("$SRC" --version 2>&1 | head -n 1))"
# only copy if different or missing
if [[ ! -f "$CLI_BIN" ]] || ! cmp -s "$SRC" "$CLI_BIN" 2>/dev/null; then
  install -m 755 "$SRC" "$CLI_BIN"
  ok "installed $CLI_BIN"
else
  ok "cli-root already fresh"
fi
if have_ident "$IDENT_APP"; then
  codesign --force --timestamp --options runtime -s "$IDENT_APP" "$CLI_BIN"
  codesign --verify --strict "$CLI_BIN" 2>&1 && ok "cli-root signed + verified" || fail "cli-root sign verify failed"
else
  warn "no Application identity — cli-root left ad-hoc signed"
  codesign --force --timestamp --options runtime -s - "$CLI_BIN" 2>&1 || true
fi
"$CLI_BIN" --version 2>&1 | head -n 1 || true
CLI_VERSION_ACTUAL="$("$CLI_BIN" --version 2>&1 | sed -nE 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1)"
if [[ -n "$CLI_VERSION_ACTUAL" && "$CLI_VERSION_ACTUAL" != "$CLI_VERSION" ]]; then
  fail "CLI binary reports $CLI_VERSION_ACTUAL but source metadata requires $CLI_VERSION — rebuild Aiko first"
fi

# ---- 3. rebuild component pkgs --------------------------------------------
info "3/7 build AikoApp.pkg ($APP_VERSION)"
rm -f "$APP_PKG"
pkgbuild --component "$STAGE" --install-location /Applications \
  --identifier ai.aiko.desktop --version "$APP_VERSION" "$APP_PKG" >/dev/null
ok "built $APP_PKG ($(du -h "$APP_PKG" | awk '{print $1}'))"

info "4/7 build AikoCLI.pkg ($CLI_VERSION)"
rm -f "$CLI_PKG"
# pkgbuild --root expects the root to contain the install-location subtree
pkgbuild --root "$CLI_ROOT" --identifier ai.aiko.cli --version "$CLI_VERSION" \
  --install-location / "$CLI_PKG" >/dev/null
ok "built $CLI_PKG ($(du -h "$CLI_PKG" | awk '{print $1}'))"
pkgutil --payload-files "$CLI_PKG" 2>&1 | head -n 10 || true

# ---- 5. distribution pkg ---------------------------------------------------
info "5/7 build product pkg"

rm -f "$PRODUCT_PKG"
productbuild --distribution "$DISTRIBUTION_XML" --resources "$PKG_DIR/resources" \
  --package-path "$PKG_DIR" "$PRODUCT_PKG" >/dev/null
ok "built $PRODUCT_PKG ($(du -h "$PRODUCT_PKG" | awk '{print $1}'))"

# ---- 6. sign product pkg when identity exists ------------------------------
info "6/7 sign product pkg"
if have_ident "$IDENT_INSTALLER"; then
  info "signing with $IDENT_INSTALLER"
  productsign --sign "$IDENT_INSTALLER" "$PRODUCT_PKG" "${PRODUCT_PKG}.signed.pkg"
  mv "${PRODUCT_PKG}.signed.pkg" "$PRODUCT_PKG"
  ok "product pkg signed"
  if [[ $DO_NOTARIZE -eq 1 ]]; then
    info "notarizing product pkg"
    notarize_pkg
    ok "product pkg notarized + stapled"
  else
    warn "notarization skipped (pass --notarize to submit)"
  fi
else
  warn "no Developer ID Installer identity — leaving product pkg unsigned"
  echo "   To enable signing:"
  echo "   1) upload $DIST/csr/developer_id_installer.certSigningRequest at"
  echo "      https://developer.apple.com/account/resources/certificates/add"
  echo "      (type: Developer ID Installer)"
  echo "   2) download the .cer and run:"
  echo "      $DIST/import-installer-cert.sh <path/to/developerID_installer.cer>"
  echo "   3) re-run: scripts/prep-installer.sh"
  echo "   Unsigned pkgs install locally with: sudo installer -pkg $PRODUCT_PKG -target /"
  echo "   but Gatekeeper will show 'no usable signature' until signed+notarized."
fi

# ---- 7. re-zip + verify ----------------------------------------------------
info "7/7 re-zip + verify"
rm -f "$PRODUCT_ZIP"
zip -j -q "$PRODUCT_ZIP" "$PRODUCT_PKG"
ok "zipped $PRODUCT_ZIP ($(du -h "$PRODUCT_ZIP" | awk '{print $1}'))"

echo ""
info "verify"
echo "  stage:"
spctl -a -vv -t install "$STAGE" 2>&1 | sed 's/^/    /' || true
echo "  cli-root:"
codesign -dv "$CLI_BIN" 2>&1 | head -n 4 | sed 's/^/    /' || true
echo "  AikoCLI.pkg payload:"
pkgutil --payload-files "$CLI_PKG" 2>&1 | sed 's/^/    /' | head -n 10
echo "  product pkg signature:"
pkgutil --check-signature "$PRODUCT_PKG" 2>&1 | sed 's/^/    /' || true
spctl -a -vv -t install "$PRODUCT_PKG" 2>&1 | sed 's/^/    /' || true

echo ""
# expand sanity
rm -rf /tmp/_prep_expand
pkgutil --expand "$PRODUCT_PKG" /tmp/_prep_expand 2>&1 && ok "pkgutil --expand ok" || fail "expand failed"
echo "  expanded Distribution versions:"
grep 'pkg-ref id="ai.aiko' /tmp/_prep_expand/Distribution 2>&1 | sed 's/^/    /' || true

echo ""
info "summary"
printf "  %-22s %s\n" "Aiko.app:" "$STAGE ($APP_VERSION)"
printf "  %-22s %s\n" "aiko CLI:" "$CLI_BIN ($CLI_VERSION) — $("$CLI_BIN" --version 2>&1 | head -n 1)"
printf "  %-22s %s\n" "AikoApp.pkg:" "$APP_PKG ($(du -h "$APP_PKG" | awk '{print $1}'))"
printf "  %-22s %s\n" "AikoCLI.pkg:" "$CLI_PKG ($(du -h "$CLI_PKG" | awk '{print $1}'))"
printf "  %-22s %s\n" "Installer pkg:" "$PRODUCT_PKG ($(du -h "$PRODUCT_PKG" | awk '{print $1}'))"
printf "  %-22s %s\n" "Installer zip:" "$PRODUCT_ZIP ($(du -h "$PRODUCT_ZIP" | awk '{print $1}'))"
shasum -a 256 "$PRODUCT_PKG" 2>&1 | awk '{printf "  %-22s %s\n", "sha256:", $1}'
echo ""
if have_ident "$IDENT_INSTALLER"; then
  pkgutil --check-signature "$PRODUCT_PKG" 2>&1 | grep -q "Status: signed" && ok "READY — signed installer at $PRODUCT_PKG" || warn "signed but check failed"
else
  warn "READY (unsigned) — installer at $PRODUCT_PKG"
  echo "   sign+notarize when the Installer cert is ready, or install unsigned locally for testing."
fi
if [[ $DO_NOTARIZE -eq 1 ]]; then
  echo "   notarization requested — see above for staple result"
fi
