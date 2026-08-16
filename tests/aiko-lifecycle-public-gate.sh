#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# The public witness drives protocol -> SDK -> Gateway route -> server policy -> Contract command/readback.
(cd aiko-flow && bun test packages/server/tests/contractLifecyclePolicy.test.js packages/server/tests/contractLifecycle.test.js)
# Production barrels and the real Gateway dispatcher must carry every public route.
grep -q 'contractLifecycle.semanticRollback' aiko-flow/packages/gateway/src/rpc/index.js
grep -q 'routeContractLifecycleRpc(this.contractLifecycle' aiko-flow/packages/server/src/gateway.js
grep -q 'ContractLifecycleClient' aiko-flow/packages/gateway-client/src/index.ts
grep -q 'pub mod contract_lifecycle_tools' aiko/crates/codegen/xai-grok-mcp/src/lib.rs
# Compile the self-contained MCP adapter without dragging unrelated provider build scripts into this focused gate.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat >"$TMP/Cargo.toml" <<EOF
[package]
name = "aiko-lifecycle-mcp-gate"
version = "0.0.0"
edition = "2024"
[dependencies]
serde_json = "1"
EOF
mkdir "$TMP/src"
printf '#[path = "%s/aiko/crates/codegen/xai-grok-mcp/src/contract_lifecycle_tools.rs"]\nmod contract_lifecycle_tools;\n' "$ROOT" >"$TMP/src/lib.rs"
"${CARGO:-$HOME/.cargo/bin/cargo}" test --offline --manifest-path "$TMP/Cargo.toml" contract_lifecycle_tools::tests::catalog_is_closed_and_public --lib
! grep -E 'sqlite|postgres|DELETE FROM|UPDATE .* SET' aiko-flow/packages/server/src/contractLifecycle.js aiko-flow/packages/gateway/src/rpc/contractLifecycle.js aiko-flow/packages/cli/src/commands/contract-lifecycle.js
echo aiko-lifecycle-public-gate:ok
