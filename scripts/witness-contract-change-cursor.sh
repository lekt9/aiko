#!/usr/bin/env bash
# witness-contract-change-cursor.sh — RM2 compare-and-set cursor witness.
#
# RM2 gate (plan.md): cursors advance only after a durable append, only via
# compare-and-set, and never move backwards for out-of-order delivery; a
# stale or expired lease cannot advance the cursor; a missing cursor
# requires a bounded resync, not an unbounded replay.
#
# This witness runs the RM2 cursor tests: advance-on-change-only, no
# backward move for out-of-order, stale-lease rejection, and missing-cursor
# resync. The occurrence-store half is witness-contract-event-dedup.sh.
# Both run the full rm2_ set (one compile); each is green iff all RM2 tests
# pass.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[rm2] change-cursor witness..."
cargo test -p xai-grok-shell --lib membrane::tests::rm2_ >/dev/null 2>&1
echo "[rm2] PASS — CAS advance, no backward move, stale-lease rejected, missing-cursor resync"
