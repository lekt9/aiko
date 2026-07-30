#!/usr/bin/env bash
# witness-contract-security-gates.sh — RM7 security and mutation gates witness.
#
# RM7 gate (plan.md): fail closed at every consequential boundary. Webhook
# ingress verifies signature, bounds, freshness, and replay before an event
# is appended; every consequential effect without contract authority is Held;
# private payloads cannot cross the Contract boundary; transport endpoints
# stay as opaque secret references. Removing any one boundary turns its
# witness red.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[rm7] security + mutation gates witness..."
cargo test -p xai-grok-shell --lib membrane::tests::rm7_ >/dev/null 2>&1
echo "[rm7] PASS — webhook sig/size/stale/replay, fail-closed effect matrix, privacy + secret-ref boundaries"
