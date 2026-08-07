#!/bin/sh
# package-installable-witness.sh — prove a built package is installable
# without re-running a full cargo build.
#
# Usage:
#   scripts/package-installable-witness.sh [package-dir]
# Default package-dir: newest target/aiko-package/aiko-*-$platform dir.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/scripts/postmortem-contract.sh"

platform() {
    case "$(uname -s)-$(uname -m)" in
        Linux-x86_64) echo linux-x86_64 ;;
        Linux-aarch64|Linux-arm64) echo linux-aarch64 ;;
        Darwin-arm64) echo macos-aarch64 ;;
        Darwin-x86_64) echo macos-x86_64 ;;
        *) echo "unknown-$(uname -s)-$(uname -m)" ;;
    esac
}

PKG=${1:-}
if [ -z "$PKG" ]; then
    # Prefer non-.previous package dirs
    PKG=$(ls -d "$ROOT"/target/aiko-package/aiko-*-"$(platform)" 2>/dev/null | grep -v previous | tail -1 || true)
fi
if [ -z "$PKG" ] || [ ! -d "$PKG" ]; then
    echo "package-installable-witness: no package dir found" >&2
    exit 1
fi

pm_init "package-installable"
echo "package-witness: $PKG"
pm_run pkg-dir "Package directory exists" 1 "test -d \"$PKG\""
pm_run pkg-bin "Package contains executable bin/aiko" 1 "test -x \"$PKG/bin/aiko\""
pm_run pkg-lib "Package contains libcontract" 1 "test -f \"$PKG/lib/libcontract.so\" -o -f \"$PKG/lib/libcontract.dylib\""
pm_run pkg-manifest "Package has manifest.json" 1 "test -f \"$PKG/manifest.json\""
pm_run pkg-install "Package has install.sh" 1 "test -x \"$PKG/install.sh\" -o -f \"$PKG/install.sh\""
pm_run pkg-contract-cli "Package contains executable bin/contract" 1 "test -x \"$PKG/bin/contract\""
pm_run pkg-contract-mcp "Packaged contract serves the MCP handshake" 1 \
    "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"witness\",\"version\":\"1\"}}}' | \"$PKG/bin/contract\" mcp 2>/dev/null | grep -q '\"serverInfo\"'"
pm_run pkg-selfcheck "Package ships selfcheck.sh" 1 "test -f \"$PKG/selfcheck.sh\""
pm_run pkg-version "Package aiko --version runs" 1 "\"$PKG/bin/aiko\" --version 2>&1 | grep -q 'aiko '"
pm_run pkg-skills "Package has skills/" 0 "test -d \"$PKG/skills\""

if ! pm_finish; then
    echo "package-witness: FAILED ($PM_FAILURES)" >&2
    exit 1
fi
echo "package-witness: green"
exit 0
