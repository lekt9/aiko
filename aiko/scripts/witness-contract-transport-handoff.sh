#!/usr/bin/env bash
# witness-contract-transport-handoff.sh — RM4 adaptive binding + zero-loss handoff witness.
#
# RM4 gate (plan.md): a synthetic load trace promotes polling -> ephemeral
# -> durable, then degrades back, without duplicate replies or missed
# occurrences. Promotion thresholds, hysteresis, cooldown, and health-loss
# demotion are all exercised. Overlap delivery during each handoff converges
# in the OccurrenceStore by dedup key (no duplicate effect), and every event
# is processed (no miss).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[rm4] adaptive binding + zero-loss handoff witness..."
cargo test -p xai-grok-shell --lib membrane::tests::rm4_ >/dev/null 2>&1
echo "[rm4] PASS — poll->ephemeral->durable->back, hysteresis, cooldown, health demote, no dup/no miss"
