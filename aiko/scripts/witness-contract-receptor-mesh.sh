#!/usr/bin/env bash
# witness-contract-receptor-mesh.sh — the cumulative Receptor-Mesh gate.
#
# Runs every RM-unit witness together: RM0 persistence, RM2 dedup+cursor,
# RM3 transport registry, RM4 adaptive handoff, RM5 reconciler+cell, RM7
# security gates, plus the full contract_native suite. Green iff the whole
# in-process receptor mesh is coherent.
#
# Not claimed here: RM6 live-provider witnesses (Telegram webhook + tunnel)
# and RM5 real-process death/restart — those need live-provider authority
# and are integration-level.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[rm] receptor-mesh cumulative witness..."
bash scripts/witness-contract-receptor-restart.sh >/dev/null
bash scripts/witness-contract-event-dedup.sh >/dev/null
bash scripts/witness-contract-change-cursor.sh >/dev/null
bash scripts/witness-contract-transport-registry.sh >/dev/null
bash scripts/witness-contract-transport-handoff.sh >/dev/null
bash scripts/witness-contract-receptor-runtime.sh >/dev/null
bash scripts/witness-contract-security-gates.sh >/dev/null
cargo test -p xai-grok-shell --lib contract_native:: >/dev/null 2>&1
echo "[rm] PASS — RM0/2/3/4/5/7 units green, contract_native suite green"
