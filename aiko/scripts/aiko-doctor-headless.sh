#!/bin/sh
# aiko-doctor-headless.sh — TTY-free health entry for CI/postmortem.
# Composes install selfcheck + optional login/mcp smokes (soft).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
AIKO_BIN_DIR=${AIKO_BIN_DIR:-$HOME/.local/bin}
export AIKO_BIN_DIR
export AIKO="${AIKO:-$AIKO_BIN_DIR/aiko}"

echo "doctor-headless: install selfcheck"
sh "$ROOT/scripts/aiko-install-selfcheck.sh" || {
    echo "doctor-headless: install selfcheck failed" >&2
    exit 1
}

echo "doctor-headless: mcp selfcheck (soft)"
AIKO_SELFCHECK_SOFT=1 sh "$ROOT/scripts/aiko-mcp-selfcheck.sh" || true

echo "doctor-headless: ok"
# shellcheck disable=SC1091
. "$ROOT/scripts/postmortem-contract.sh"
pm_init "doctor-headless"
pm_run install-snapshot "install-selfcheck.latest complete" 1 \
    "python3 -c 'import json,os; d=json.load(open(os.path.expanduser(\"~/.aiko/postmortem/install-selfcheck.latest.json\"))); assert d.get(\"complete\") is True'"
pm_finish || exit 1
exit 0
