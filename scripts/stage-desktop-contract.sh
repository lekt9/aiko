#!/usr/bin/env bash
# Stage libcontract into the desktop app's Tauri resources for THIS host.
#
# `tauri.conf.json` globs `resources/contract/*`, and that directory used to be
# satisfied by a macOS .dylib committed to git — which is also precisely why the
# desktop app only ever bundled on macOS. Untracking the binary did not create a
# gap; it exposed one that had always been there, filled by a checked-in
# artifact standing in for a build step that never ran.
#
# This is that step. It builds libcontract from source and copies the shared
# library the current platform actually produces, so a Linux host bundles a
# Linux library and a macOS host bundles a macOS one.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$repo/aiko/apps/desktop/src-tauri/resources/contract"

echo "==> building libcontract's shared library"
( cd "$repo/contract/libcontract" && zig build contract-library )

# Zig names the shared library per platform; take whichever this host produced
# rather than assuming an extension.
lib="$(find "$repo/contract/libcontract/zig-out" -maxdepth 2 \
        \( -name 'libcontract.so*' -o -name 'libcontract.dylib' -o -name 'contract.dll' \) \
        -type f 2>/dev/null | head -1)"

[ -n "$lib" ] || {
    echo "FAIL: the build produced no shared library under contract/libcontract/zig-out" >&2
    exit 1
}

mkdir -p "$dest"
# Remove any FOREIGN-platform library first. Leaving one behind is how the
# resources glob ends up bundling a library that cannot load on the host it
# ships to — the original defect, re-created.
find "$dest" -maxdepth 1 -type f \
    \( -name 'libcontract.*' -o -name 'contract.dll' \) -delete 2>/dev/null || true

cp "$lib" "$dest/"
echo "==> staged $(basename "$lib") ($(du -h "$lib" | cut -f1)) into resources/contract/"
echo "    for: $(uname -s) $(uname -m)"
