#!/usr/bin/env bash
# witness-contract-receptor-runtime.sh — RM5 universal receptor runtime witness.
#
# RM5 (plan.md): reconcile desired ledger state into a bounded runtime plan,
# and drive each receptor through the unified cell lifecycle with a mandatory
# continuation readiness barrier (no worker before Ready). This witness
# covers the in-process unit: reconcile (start declared-not-live, stop
# orphans, keep both), the readiness barrier (a pre-ready worker is blocked
# but its occurrence is still durable), idempotent replay without
# re-execution, contradiction-hold, expired-lease block, and held-effect
# block. Independent witnesses for real process death / host restart /
# network partition are integration-level (a live reconciler process) and
# are not claimed by this unit witness.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[rm5] receptor runtime (reconciler + cell) witness..."
cargo test -p xai-grok-shell --lib membrane::tests::rm5_ >/dev/null 2>&1
echo "[rm5] PASS — reconcile plan, readiness barrier, outcome separation, contradiction/lease/effect holds"
