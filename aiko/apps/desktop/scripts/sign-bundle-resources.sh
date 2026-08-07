#!/usr/bin/env bash
# Sign every Mach-O in a built Aiko.app that `tauri build` leaves unsigned.
#
# Tauri signs the executables under Contents/MacOS and the declared
# externalBins, but not Mach-O files bundled as plain resources — here that is
# Contents/Resources/contract/libcontract.dylib. Apple notarization rejects a
# bundle if ANY Mach-O lacks a Developer ID signature with a secure timestamp,
# so an otherwise-signed app fails with "not signed with a valid Developer ID
# certificate" pointing at that one dylib. This closes that gap and re-seals
# the outer bundle (signing a nested item invalidates the container signature).
#
#   scripts/sign-bundle-resources.sh <path/to/Aiko.app> ["Developer ID Application: … (TEAMID)"]
#
# The identity defaults to APPLE_SIGNING_IDENTITY, the same variable the build
# reads, so a normal build + this script share one source of truth.
set -euo pipefail

APP="${1:?usage: sign-bundle-resources.sh <Aiko.app> [signing identity]}"
IDENTITY="${2:-${APPLE_SIGNING_IDENTITY:-}}"
[ -n "$IDENTITY" ] || { echo "no signing identity (arg 2 or APPLE_SIGNING_IDENTITY)"; exit 1; }
[ -d "$APP" ] || { echo "no app bundle at $APP"; exit 1; }

echo "Signing identity: $IDENTITY"

# Sign inner Mach-O first, outermost last. A resource dylib is not an executable
# and gets no entitlements, but it still needs hardened runtime + a timestamp to
# satisfy notarization.
resigned=0
while IFS= read -r f; do
  if file "$f" | grep -q "Mach-O"; then
    if ! codesign --verify --strict "$f" >/dev/null 2>&1 \
       || ! codesign -dv --verbose=4 "$f" 2>&1 | grep -q "Timestamp="; then
      echo "  signing ${f#"$APP"/}"
      codesign --force --sign "$IDENTITY" --timestamp --options runtime "$f"
      resigned=$((resigned + 1))
    fi
  fi
done < <(find "$APP/Contents/Resources" -type f 2>/dev/null)

if [ "$resigned" -gt 0 ]; then
  echo "Re-sealing the app bundle ($resigned resource binary/-ies signed)"
  codesign --force --sign "$IDENTITY" --timestamp --options runtime "$APP"
fi

echo "Verifying…"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -2
echo "OK — every Mach-O in the bundle is Developer ID signed and timestamped."
