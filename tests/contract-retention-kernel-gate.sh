#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contract/libcontract"
# This must run through the published Contract build inventory. A source-only
# `zig test` is not acceptance: removing the module from build.zig must fail.
grep -q 'src/cross_journal_retention.zig' build.zig
zig build test
# Keep the storage adapter seam and the context-equivalence seam explicit.
grep -q 'pub const retention = @import("cross_journal_retention.zig")' src/ledger.zig
grep -q 'pub fn projectionEquivalent' src/cross_journal_retention.zig
printf 'contract-retention-kernel gate: ok\n'
