#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The consumed Contract kernel is compiler-checked, not merely mirrored by JS.
bash "$ROOT/tests/contract-execution-recovery-kernel-gate.sh"
(
  cd "$ROOT/aiko-flow/packages/smithers"
  bun test tests/contractRecoveryPolicy.test.js tests/contractRecovery.test.js
)

# Production barrel must expose the coordinator, and the coordinator must bind
# both authoritative journals while keeping Smithers operational-only.
grep -q 'createExecutionRecovery' "$ROOT/aiko-flow/packages/smithers/src/index.js"
grep -q 'contract.readExecution' "$ROOT/aiko-flow/packages/smithers/src/contractRecovery.js"
grep -q 'neuron.readEffect' "$ROOT/aiko-flow/packages/smithers/src/contractRecovery.js"
grep -q 'Smithers.*never consulted' "$ROOT/aiko-flow/packages/smithers/src/contractRecovery.js"

echo "aiko execution recovery gate: ok"
