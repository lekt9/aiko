#!/usr/bin/env bash
# Install the built Aiko.app to /Applications — the right place — and reopen it.
#
#   apps/desktop/scripts/install-app.sh [path/to/Aiko.app]
#
# Defaults to the release bundle this repo builds. Targets /Applications, which
# is admin-group writable, so no sudo is needed to replace an app THIS script
# installed (they are owned by the running user).
#
# The one thing that needs a human is a pre-existing root-owned install (e.g. an
# original drag-installed by an admin). This script cannot delete root-owned
# files without sudo; it parks such an install as Aiko.app.oldroot-<n> beside
# the fresh one and prints the single sudo line to remove it. After that
# one-time cleanup, every future install is user-owned and replaced cleanly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$ROOT/src-tauri/target/release/bundle/macos/Aiko.app}"
DEST="/Applications/Aiko.app"

[ -d "$SRC" ] || { echo "no app bundle at $SRC — build it first (tauri build)"; exit 1; }

echo "Installing $SRC → $DEST"

# Stop any running instance so files are not busy.
osascript -e 'tell application "Aiko" to quit' >/dev/null 2>&1 || true
sleep 2
pkill -f "Aiko.app/Contents/MacOS/aiko-desktop" 2>/dev/null || true
sleep 1

leftover=""
if [ -e "$DEST" ]; then
  if [ -w "$DEST" ] && rm -rf "$DEST" 2>/dev/null; then
    :  # user-owned: replaced cleanly
  else
    # Root-owned: cannot delete without sudo, but /Applications is writable so
    # the entry can be renamed aside (a rename needs no recursion).
    n=0; while [ -e "$DEST.oldroot-$n" ]; do n=$((n + 1)); done
    leftover="$DEST.oldroot-$n"
    mv "$DEST" "$leftover"
    echo "Parked a root-owned prior install at $leftover"
  fi
fi

cp -R "$SRC" "$DEST"
echo "Installed."

# Verify signing/notarization survived the copy.
if xcrun stapler validate "$DEST" >/dev/null 2>&1; then
  echo "Notarization ticket: stapled and valid."
else
  echo "Note: no stapled notarization ticket (fine for a dev build)."
fi
spctl -a -v "$DEST" 2>&1 | sed 's/^/  /' | head -2 || true

open "$DEST" && echo "Reopened from /Applications."

if [ -n "$leftover" ]; then
  echo
  echo "One-time cleanup of the old root-owned copy (needs your password):"
  echo "  sudo rm -rf \"$leftover\""
fi
