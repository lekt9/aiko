#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CARGO_BIN="${CARGO:-$(command -v cargo || true)}"
if [[ -z "$CARGO_BIN" && -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
[[ -x "$CARGO_BIN" ]] || { echo "cargo is required" >&2; exit 1; }

# Public production barrels, not mere file presence.
grep -q 'export { createContractDriver' aiko-flow/packages/smithers/src/index.js
grep -q 'export \* from "./contractSignals.js"' aiko-flow/packages/server/src/index.js
grep -q 'export { ContractCell }' aiko-flow/packages/components/src/components/index.js
grep -q 'pub mod smithers_driver;' aiko/crates/codegen/xai-grok-shell/src/contract_native.rs
grep -q 'pub use smithers_driver' aiko/crates/codegen/xai-grok-shell/src/contract_native.rs
grep -q 'sidecar.execute(invocation.cell_request).await' aiko/crates/codegen/xai-grok-shell/src/contract_native/smithers_driver.rs

# The Contract component/driver must not regain legacy path/control authority.
! grep -E 'runCell|control\.json' aiko-flow/packages/components/src/components/ContractCell.js aiko-flow/packages/smithers/src/contractDriver.js

(
  cd aiko-flow
  bun test packages/smithers/tests/contractDriver.test.js packages/server/tests/contractSignals.test.js packages/components/tests/contractCell.test.js
)
(
  cd aiko
  "$CARGO_BIN" check -q -p xai-grok-shell --lib
)

echo "smithers contract driver gate: ok"
