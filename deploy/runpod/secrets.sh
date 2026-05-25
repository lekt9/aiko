#!/usr/bin/env bash
# secrets.sh — mirror local .env + ~/.contracts/root.key into Cloudflare
# Workers Secrets so the RunPod template can boot from CF env. The aiko
# substrate's boot policy is "preinstalled+self-bind primary, API cold-start
# fallback" — this script makes the cold-start fallback real.
#
# Required local files:
#   ~/.contracts/root.key                64-hex root signing seed
#   ./.env (this dir)                    CONTRACT_INSTANCE_ID + AIKO_X_PAYMENT
#
# Required tools: wrangler (Cloudflare Workers CLI)
#
# After running, RunPod can mirror from CF via `runpodctl secrets import-from-cf`
# (or paste them into RunPod UI by hand).

set -euo pipefail

ROOT_KEY_FILE="${HOME}/.contracts/root.key"
ENV_FILE="$(dirname "$0")/.env"

if [[ ! -f "$ROOT_KEY_FILE" ]]; then
    echo "missing $ROOT_KEY_FILE — run any aiko command locally first to generate" >&2
    exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
    echo "missing $ENV_FILE — copy .env.example and fill it" >&2
    exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${CF_WORKER:?CF_WORKER must be set in .env (the worker name to attach secrets to)}"

echo "pushing AIKO_ROOT_KEY to CF worker $CF_WORKER..."
tr -d '\n' < "$ROOT_KEY_FILE" | wrangler secret put AIKO_ROOT_KEY --name "$CF_WORKER"

for key in CONTRACT_INSTANCE_ID AIKO_X_PAYMENT; do
    val="${!key:-}"
    if [[ -n "$val" ]]; then
        echo "pushing $key to CF worker $CF_WORKER..."
        printf '%s' "$val" | wrangler secret put "$key" --name "$CF_WORKER"
    fi
done

echo
echo "done — secrets present on CF worker $CF_WORKER."
echo "next: mirror to RunPod via UI or runpodctl secrets import-from-cf"
