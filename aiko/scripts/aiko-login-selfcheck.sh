#!/bin/sh
# aiko-login-selfcheck.sh — post-auth smoke contracts for postmortem.
# Soft by default (auth/network can flake); set AIKO_LOGIN_SELFCHECK_STRICT=1
# to fail on models.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/scripts/postmortem-contract.sh"

AIKO=${AIKO:-${AIKO_BIN_DIR:-$HOME/.local/bin}/aiko}
if [ ! -x "$AIKO" ] && command -v aiko >/dev/null 2>&1; then
    AIKO=$(command -v aiko)
fi

pm_init "login-selfcheck"
crit=0
if [ "${AIKO_LOGIN_SELFCHECK_STRICT:-0}" = "1" ]; then
    crit=1
fi

pm_run auth-files "Auth store exists (aiko or codex)" "$crit" \
    "test -f \"\$HOME/.aiko/auth.json\" -o -f \"\$HOME/.grok/auth.json\" -o -f \"\$HOME/.codex/auth.json\""
pm_run models "aiko models lists catalog after login" "$crit" \
    "\"$AIKO\" models 2>&1 | grep -Eqi 'Available models:|Default model:|logged in'"
pm_run version "aiko still runs after login" 1 \
    "\"$AIKO\" --version 2>&1 | grep -q 'aiko '"

if ! pm_finish; then
    if [ "${AIKO_LOGIN_SELFCHECK_STRICT:-0}" = "1" ]; then
        exit 1
    fi
    echo "login-selfcheck: soft failures recorded" >&2
    exit 0
fi
exit 0
