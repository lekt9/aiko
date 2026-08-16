#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The acceptance harness may provide a deliberately sparse PATH. Resolve the
# project toolchain explicitly; CARGO remains an intentional caller override.
CARGO_BIN="${CARGO:-/Users/lewis/.cargo/bin/cargo}"
test -x "$CARGO_BIN" || { echo "cargo executable unavailable: $CARGO_BIN" >&2; exit 1; }

# Build the actual ABI. A source-only inventory cannot satisfy this witness.
(cd "$ROOT/contract/libcontract" && zig build)
case "$(uname -s)" in
  Darwin) LIB="$ROOT/contract/libcontract/zig-out/lib/libcontract.dylib" ;;
  Linux) LIB="$ROOT/contract/libcontract/zig-out/lib/libcontract.so" ;;
  *) echo "unsupported platform for native Contract ingress gate" >&2; exit 1 ;;
esac
test -f "$LIB"

# Exercise the modules through their production crates. Standalone rustc/source
# assertions are intentionally forbidden: they can stay green while composition
# roots bypass the ingress.
(cd "$ROOT/aiko" && "$CARGO_BIN" test -p xai-grok-hooks contract_projection --lib -- --nocapture)
(cd "$ROOT/aiko" && "$CARGO_BIN" test -p xai-grok-hooks criticality --lib -- --nocapture)
(cd "$ROOT/aiko" && "$CARGO_BIN" test -p xai-grok-mcp hook_contract_tools --lib -- --nocapture)
(cd "$ROOT/aiko" && "$CARGO_BIN" test -p xai-grok-pager-bin workflow_cli::tests:: --bin aiko -- --nocapture)
(cd "$ROOT/aiko" && "$CARGO_BIN" test -p xai-grok-shell ingress_routes::tests::every_public_face --lib -- --nocapture)

# The first ignored test sends every typed route through the shared production
# singleton and real ABI. The second enters the actual authenticated MCP
# composition root, which must admit before dispatching workflow_route.
(cd "$ROOT/aiko" && AIKO_CONTRACT_LIBRARY="$LIB" \
  "$CARGO_BIN" test -p xai-grok-shell ingress_routes::tests::real_native_abi --lib -- --ignored --nocapture)
(cd "$ROOT/aiko" && AIKO_CONTRACT_LIBRARY="$LIB" \
  "$CARGO_BIN" test -p xai-grok-shell authenticated_mcp_composition_root_admits_before_dispatch --lib -- --ignored --nocapture)

printf '%s\n' 'contract-hook-ingress gate: PASS (compiled production crates; turn/CLI/MCP composition roots; 8 typed faces -> shared choke -> real Contract ABI)'
