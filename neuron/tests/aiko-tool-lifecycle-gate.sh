#!/usr/bin/env bash
set -euo pipefail

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$HERE/../.." && pwd)"
AIKO="$ROOT/aiko"

# Resolve Cargo independently of the caller's PATH while remaining overridable
# for hermetic builders. Tests run from the real workspace so Cargo supplies
# each crate's declared edition and feature graph.
CARGO="${CARGO:-/Users/lewis/.cargo/bin/cargo}"
if [[ ! -x "$CARGO" ]]; then
  CARGO="$(command -v cargo || true)"
fi
[[ -n "$CARGO" && -x "$CARGO" ]] || { echo "cargo not found" >&2; exit 1; }

cd "$AIKO"
"$CARGO" test -p xai-grok-mcp graph_harness_tools::admitted_tests --lib
"$CARGO" test -p xai-grok-shell admitted_capability_service::tests --lib

# Composition, not catalog resemblance: the shell must construct the MCP
# server around its own registry, fresh authority provider, and effector.
grep -q 'pub fn mcp_server(' crates/codegen/xai-grok-shell/src/lib.rs
grep -q 'move || authority()' crates/codegen/xai-grok-shell/src/lib.rs
grep -q 'InertExecutionEnvelope::default()' crates/codegen/xai-grok-shell/src/contract_native/capability_tools.rs

echo "aiko admitted tool lifecycle gate: ok"
