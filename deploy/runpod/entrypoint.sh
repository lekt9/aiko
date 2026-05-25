#!/usr/bin/env bash
# entrypoint.sh — boot aiko inside the RunPod serverless container.
#
# Cold-start lifecycle:
#   1. AIKO_ROOT_KEY (from CF Secrets via RunPod env) seeds the wallet
#      lineage. lineage_lib.loadOrInitRootKey checks this var first.
#   2. CONTRACT_INSTANCE_ID names this aiko's identity (per-deployment
#      contract id from the canonical ledger).
#   3. ~/.contracts/ is recreated per cold-start; the ledger lives in
#      Unbrowse, the container is stateless.
#   4. RunPod hands us a JSON job on stdin (their serverless contract);
#      we hand the inner "input.goal" to aiko --remote and stream the
#      result back as JSON.

set -euo pipefail

if [[ -z "${AIKO_ROOT_KEY:-}" ]]; then
    echo '{"error":"AIKO_ROOT_KEY not set — refusing to boot without root signing seed"}' >&2
    exit 2
fi

mkdir -p "$HOME/.contracts"
chmod 700 "$HOME/.contracts"

# Persist root.key only for in-container resolver; cleared on cold-stop.
echo -n "$AIKO_ROOT_KEY" > "$HOME/.contracts/root.key"
chmod 600 "$HOME/.contracts/root.key"

# RunPod serverless feeds the job JSON via $RUNPOD_INPUT or stdin.
INPUT="${RUNPOD_INPUT:-$(cat)}"
GOAL=$(printf '%s' "$INPUT" | sed -n 's/.*"goal"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')

if [[ -z "$GOAL" ]]; then
    echo '{"error":"no goal field in input"}'
    exit 1
fi

# Route through aiko --remote. The cloud compiler handles everything —
# this container is just the executor body for one contract turn.
export CONTRACT_PARENT_ID="${CONTRACT_INSTANCE_ID:-}"
RESULT=$(aiko "$GOAL" --remote 2>&1) || true

# Wrap stdout in RunPod-shaped JSON.
printf '{"output":%s}\n' "$(printf '%s' "$RESULT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
