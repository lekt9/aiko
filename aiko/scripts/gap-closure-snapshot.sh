#!/bin/sh
# gap-closure-snapshot.sh — end-to-end witness for the all-gaps graph.
# Exits 0 only when every required artifact/pattern is present.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
AIKO_HOME=${AIKO_HOME:-$HOME/.aiko}
OUT="$AIKO_HOME/postmortem/gap-closure.latest.json"
mkdir -p "$AIKO_HOME/postmortem"

fail=0
check() {
    id=$1
    shift
    if "$@"; then
        echo "  ok  $id"
        return 0
    fi
    echo "  RED $id" >&2
    fail=$((fail + 1))
    return 1
}

echo "gap-closure: verifying all gap nodes"

check S0-schema test -f "$ROOT/scripts/postmortem-contract.sh"
check G10-residual rg -q 'git_head|HEAD|git rev-parse' "$ROOT/scripts/aiko-install-selfcheck.sh"
check G1-update rg -q 'aiko-install-selfcheck|post_install_selfcheck|run_post_install_selfcheck' \
    "$ROOT/crates/codegen/xai-grok-update/src/auto_update.rs"
check G2-aiko-install rg -q 'selfcheck|SELFCHECK|aiko-install-selfcheck' "$ROOT/sdk/registry/bin/aiko-install"
check G6-package test -f "$ROOT/scripts/package-installable-witness.sh"
check G6-hook rg -q 'package-installable-witness' "$ROOT/scripts/contract-runtime.sh"
check G4-native rg -q 'native_begin|local_task|task_store|postmortem' \
    "$ROOT/crates/codegen/xai-grok-shell/src/contract_native/pair.rs"
check G3-login test -f "$ROOT/scripts/aiko-login-selfcheck.sh"
check G3-wire rg -q 'aiko-login-selfcheck|login_selfcheck|post_login_selfcheck' \
    "$ROOT/crates/codegen/xai-grok-shell/src/auth/flow.rs" \
    "$ROOT/crates/codegen/xai-grok-shell/src/auth/codex_oauth.rs"
check G5-linux rg -q 'unsupported|postmortem|platform' \
    "$ROOT/crates/codegen/xai-grok-pager-bin/src/main.rs"
check G7-setup test -f "$ROOT/scripts/aiko-setup-selfcheck.sh"
check G8-mcp test -f "$ROOT/scripts/aiko-mcp-selfcheck.sh"
check G9-cap rg -q 'postmortem' "$ROOT/scripts/verify-aiko-capabilities.sh"
check G11-doctor test -f "$ROOT/scripts/aiko-doctor-headless.sh"
check G12-docs bash "$ROOT/scripts/check-install-docs.sh" >/dev/null

complete=false
if [ "$fail" -eq 0 ]; then
    complete=true
fi

python3 - "$OUT" "$fail" "$complete" <<'PY'
import json, sys, os
from pathlib import Path
out, fail, complete = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "true"
graph = {
    "format": 1,
    "kind": "gap-closure",
    "failures": fail,
    "complete": complete,
    "nodes": [
        "S0-schema", "G1-update-selfcheck", "G2-aiko-install", "G3-login-contracts",
        "G4-native-tasks", "G5-linux-worker", "G6-package-witness", "G7-setup-selfcheck",
        "G8-mcp-plugin", "G9-capabilities-default", "G10-install-residual",
        "G11-doctor-headless", "G12-docs-gate",
    ],
}
Path(out).write_text(json.dumps(graph, indent=2) + "\n", encoding="utf-8")
print(f"gap-closure: wrote {out} complete={complete} failures={fail}")
PY

if [ -d "$ROOT/.claude" ]; then
    cp -f "$OUT" "$ROOT/.claude/gap-closure.latest.json" 2>/dev/null || true
fi

if [ "$fail" -gt 0 ]; then
    exit 1
fi
exit 0
