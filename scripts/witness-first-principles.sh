#!/usr/bin/env bash
# Thin wrapper: first-principles witness lives in Unbrowse/contract.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT="$(cd "$ROOT/../contract" 2>/dev/null && pwd || true)"
if [[ -z "${CONTRACT:-}" || ! -f "$CONTRACT/scripts/witness-first-principles.sh" ]]; then
  echo "FAIL  contract/scripts/witness-first-principles.sh not found (expected sibling ../contract)"
  exit 1
fi
# Aiko-side extras: claim worker + plan3 still present
FAIL=0
if ! grep -q 'tick_due_contracts' "$ROOT/crates/codegen/xai-grok-shell/src/contract_native.rs" 2>/dev/null; then
  echo "FAIL  aiko tick_due_contracts missing"; FAIL=1
else
  echo "PASS  aiko tick_due_contracts"
fi
if [[ ! -f "$ROOT/plan3.md" ]]; then
  echo "FAIL  plan3.md missing"; FAIL=1
else
  echo "PASS  plan3.md"
fi
if [[ ! -f "$ROOT/docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md" ]]; then
  echo "FAIL  aiko first-principles pointer missing"; FAIL=1
else
  echo "PASS  aiko first-principles pointer"
fi
bash "$CONTRACT/scripts/witness-first-principles.sh"
exit $(( FAIL != 0 ? 1 : 0 ))
