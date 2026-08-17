#!/bin/sh
# aiko-setup-selfcheck.sh — after managed config apply.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/scripts/postmortem-contract.sh"

AIKO=${AIKO:-${AIKO_BIN_DIR:-$HOME/.local/bin}/aiko}
if [ ! -x "$AIKO" ] && command -v aiko >/dev/null 2>&1; then
    AIKO=$(command -v aiko)
fi

pm_init "setup-selfcheck"
pm_run version "aiko --version after setup" 1 "\"$AIKO\" --version 2>&1 | grep -q 'aiko '"
pm_run help "aiko --help after setup" 1 "\"$AIKO\" --help 2>&1 | grep -Eqi 'Contract-native|Usage:'"
pm_run inspect "aiko inspect --json serializes" 0 "\"$AIKO\" inspect --json 2>&1 | head -c 200 | grep -q '{'"
pm_run models "aiko models after setup (soft)" 0 "\"$AIKO\" models 2>&1 | grep -Eqi 'Available models:|Default model:|logged in|error'"

if ! pm_finish; then
    exit 1
fi
exit 0
