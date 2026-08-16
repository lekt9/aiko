#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AIKO="$ROOT/aiko"
MODULE="$AIKO/crates/codegen/xai-grok-shell/src/contract_native/delegation_capability.rs"
COMPOSITION="$AIKO/crates/codegen/xai-grok-shell/src/contract_native.rs"
COORDINATOR="$AIKO/crates/codegen/xai-grok-shell/src/agent/mvp_agent/subagent_coordinator.rs"

# Use the project toolchain through Cargo, never a source-only rustc invocation.
# The canonical machine path is preferred; CI may provide the same tool via PATH.
if [[ -x /Users/lewis/.cargo/bin/cargo ]]; then
  CARGO=/Users/lewis/.cargo/bin/cargo
else
  CARGO="$(command -v cargo)"
fi
[[ -x "$CARGO" ]] || { echo "project Cargo not found" >&2; exit 1; }
"$CARGO" metadata --manifest-path "$AIKO/Cargo.toml" --no-deps --format-version 1 >/dev/null

python3 - "$MODULE" "$COMPOSITION" "$COORDINATOR" <<'PY'
from pathlib import Path
import sys
module, composition, coordinator = map(lambda value: Path(value).read_text(), sys.argv[1:])
required_module = [
    "pub struct VerifiedParentAuthority",
    "pub struct DelegationPolicy",
    "pub fn attenuate(",
    "pub fn validate_adoption(",
    "pub fn allows_tool(",
    "pub fn adoption_for_effect(",
]
required_composition = [
    "pub mod delegation_capability;",
    'b"contract_delegation_issue_json\\0"',
    'b"contract_delegation_adopt_json\\0"',
    "pub fn bind_verified_delegation_parent(",
    "pub async fn delegate_subagent_capability(",
    "authorize_delegated_child_tool(&root_id, tool_name, read_only)",
    'reason: "delegated capability adoption failed"',
]
required_coordinator = [
    "delegate_subagent_capability(",
    "refusing subagent before model/tool: delegated capability was not adopted",
]
for text, needles in ((module, required_module), (composition, required_composition), (coordinator, required_coordinator)):
    for needle in needles:
        assert needle in text, f"missing production integration: {needle}"
assert "delegate_subagent_root(" not in coordinator
assert "max_effects: 16" not in coordinator
assert "AIKO_CONTRACT_ROOT_ID" not in coordinator
assert "AIKO_CONTRACT_PARENT_ID" not in coordinator
assert "binding_or_policy(None, read_only, \"delegated capability adoption failed\")" not in composition
PY

# The durable Contract implementation proves row existence, tenant/root/fence,
# expiry, revocation and adoption by independent journal read-back.
bash "$ROOT/tests/contract-delegation-substrate-gate.sh"

# Compile and run through the real workspace/crate dependency graph and edition.
(
  cd "$AIKO"
  "$CARGO" test -p xai-grok-shell contract_native::delegation_capability::tests --lib
  "$CARGO" fmt --all -- --check
)

echo "contract delegation capability gate: ok"
