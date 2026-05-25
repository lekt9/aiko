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
echo -n "$AIKO_ROOT_KEY" > "$HOME/.contracts/root.key"
chmod 600 "$HOME/.contracts/root.key"

MODE="${AIKO_RUN_MODE:-server}"

if [[ "$MODE" == "server" ]]; then
    # OpenAI-compatible HTTP transport. http_shim.py listens on $PORT,
    # routes /v1/chat/completions to `aiko openai` (cmdOpenAi in zig).
    exec python3 /opt/aiko/http_shim.py
fi

# ONESHOT: RunPod serverless one-job-per-container shape.
INPUT="${RUNPOD_INPUT:-$(cat)}"
GOAL=$(printf '%s' "$INPUT" | sed -n 's/.*"goal"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')
if [[ -z "$GOAL" ]]; then
    echo '{"error":"no goal field in input"}'
    exit 1
fi
export CONTRACT_PARENT_ID="${CONTRACT_INSTANCE_ID:-}"
RESULT=$(aiko "$GOAL" --remote 2>&1) || true
printf '{"output":%s}\n' "$(printf '%s' "$RESULT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
