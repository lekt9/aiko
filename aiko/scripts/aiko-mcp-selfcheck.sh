#!/bin/sh
# aiko-mcp-selfcheck.sh — MCP/plugin inventory health contracts.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/scripts/postmortem-contract.sh"

AIKO=${AIKO:-${AIKO_BIN_DIR:-$HOME/bin}/aiko}
if [ ! -x "$AIKO" ] && command -v aiko >/dev/null 2>&1; then
    AIKO=$(command -v aiko)
fi

pm_init "mcp-selfcheck"
pm_run mcp-list "aiko mcp list --json is machine-readable" 1 \
    "\"$AIKO\" mcp list --json 2>&1 | head -c 500 | grep -qE '\\{|\\[|null'"
pm_run plugin-list "aiko plugin list --json is machine-readable" 0 \
    "\"$AIKO\" plugin list --json 2>&1 | head -c 500 | grep -qE '\\{|\\[|null'"

if ! pm_finish; then
    exit 1
fi
exit 0
