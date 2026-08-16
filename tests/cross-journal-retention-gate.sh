#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Authority kernels prove atomic checkpoint recovery/tamper/loss and redrive/context equivalence.
bash tests/contract-retention-kernel-gate.sh
bash neuron/tests/retention-projection-gate.sh

# Cross projection joins already-confirmed Smithers/Neuron/Cloudflare abstract pins.
cd aiko-flow
bun test packages/smithers/tests/contractRetentionProjection.test.js packages/smithers/tests/contractRetention.test.js packages/cloudflare-webhook/tests/retention.test.ts

# Removal mutations: the public join and the production gate must be scheduled.
grep -q 'projectCrossJournalRetention' packages/smithers/src/index.js
grep -q 'tests/cross-journal-retention-gate.sh' ../build.zig
printf 'cross-journal-retention gate: ok\n'
