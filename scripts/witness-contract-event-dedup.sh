#!/usr/bin/env bash
# witness-contract-event-dedup.sh — RM2 occurrence-store dedup witness.
#
# RM2 gate (plan.md): replay, race, out-of-order, changed-ID, expiry, and
# restart tests all converge without event loss or duplicate effects.
#
# This witness runs the RM2 occurrence-store tests: idempotent replay,
# poller+webhook convergence on one occurrence, the changed-ID contradiction
# (reused event_id with changed content is retained, not processed), and
# restart dedup. The cursor-CAS half is witness-contract-change-cursor.sh.
# Both run the full rm2_ set (one compile); each is green iff all RM2 tests
# pass.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[rm2] event dedup witness..."
cargo test -p xai-grok-shell --lib membrane::tests::rm2_ >/dev/null 2>&1
echo "[rm2] PASS — replay idempotent, race converges, changed-ID held as contradiction, restart still dedups"
