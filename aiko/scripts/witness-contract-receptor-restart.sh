#!/usr/bin/env bash
# witness-contract-receptor-restart.sh — RM0 persistence-model witness.
#
# RM0 gate (plan.md): "a ledger row alone can never be reported as a live
# watcher." This witness proves the persistence model in
# crates/codegen/xai-grok-shell/src/contract_native/membrane.rs enforces:
#
#   1. A durable declaration with no reconciler lease is NOT live.
#   2. Acquiring a lease makes the receptor live; revoking (kill) drops it
#      to not-live while the declaration persists.
#   3. Restart recovers the SAME receptor from its declaration without
#      duplicating an effect (no second receptor; idempotent reconcile).
#   4. A stale worker holding the killed generation cannot commit after
#      restart (monotonic generations invalidate stale workers).
#   5. Runtime cannot be reconstructed from nothing — no lease without a
#      declaration.
#   6. Restartable/HostedDurable durability requires a reconciler.
#
# This is the persistence-model unit of RM0. A full process-level kill/
# restart of the Aiko reconciler is RM5 and is not claimed here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[rm0] membrane persistence-model witness..."
cargo test -p xai-grok-shell --lib membrane::tests::rm0_ >/dev/null 2>&1
echo "[rm0] PASS — declared-vs-live, restart-without-duplicate, stale-worker rejection all green"
