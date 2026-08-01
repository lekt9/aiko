#!/usr/bin/env bash
# witness-contract-transport-registry.sh — RM3 generic transport-registry witness.
#
# RM3 gate (plan.md): poller / local-listener / ephemeral-tunnel /
# durable-tunnel / hosted-worker / provider-webhook are normalized as
# capabilities; every live binding requires lease+owner+health+cancellation+
# restart policy + bounded children; endpoints/credentials stay as opaque
# secret references; and replacing one tunnel provider with another needs
# only a new adapter descriptor and executor (no provider branch in core).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[rm3] transport-registry witness..."
cargo test -p xai-grok-shell --lib membrane::tests::rm3_ >/dev/null 2>&1
echo "[rm3] PASS — full lifecycle shape enforced, provider-neutral replace, child bound, retire keeps history"
