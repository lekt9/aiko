#!/usr/bin/env bash
# Aiko integration witness. The Contract witness proves substrate code homes;
# these checks prove that Aiko's complete law map and application bridges do not
# regress into a pointer-only document.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT="$(cd "$ROOT/../contract" 2>/dev/null && pwd || true)"
if [[ -z "${CONTRACT:-}" || ! -f "$CONTRACT/scripts/witness-first-principles.sh" ]]; then
  echo "FAIL  contract/scripts/witness-first-principles.sh not found (expected sibling ../contract)"
  exit 1
fi
FAIL=0
PASS=0
pass() { printf 'PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }
need_file() {
  if [[ -f "$1" ]]; then pass "file $1"; else fail "missing file $1"; fi
}
need_rg() {
  local desc="$1" pattern="$2" path="$3"
  if [[ ! -e "$path" ]]; then fail "$desc — missing $path"; return; fi
  if rg -q "$pattern" "$path" 2>/dev/null; then pass "$desc"
  else fail "$desc — pattern not found in $path: $pattern"; fi
}

DOC="${FIRST_PRINCIPLES_DOC:-$ROOT/docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md}"
NATIVE="$ROOT/crates/codegen/xai-grok-shell/src/contract_native.rs"
WORKER="$ROOT/crates/codegen/xai-grok-pager-bin/src/main.rs"
META="$ROOT/.agents/skills/aiko-meta-agent/SKILL.md"

printf '=== first-principles witness (aiko integration) ===\n'
need_file "$DOC"
need_file "$ROOT/plan3.md"

# The mirror must contain the complete law map, not merely an upstream pointer.
need_rg "ontology and identity" '^## 1\. Ontology and identity' "$DOC"
need_rg "collision atom and fractal seal" '^## 2\. The collision atom and fractal seal' "$DOC"
need_rg "antiparticle catalog" '^## 3\. Antiparticle catalog' "$DOC"
need_rg "composition algebra" '^## 4\. Composition algebra' "$DOC"
need_rg "energy and catabolism" '^## 5\. Energy, catabolism, and bounds' "$DOC"
need_rg "drive and observation" '^## 6\. Drive, preemption, and observation' "$DOC"
need_rg "Contract is control plane" '^### Control plane, not execution language' "$DOC"
need_rg "ordinary execution plane remains real" 'execution plane \(agent edits, shell, compiler, tool, API, human\)' "$DOC"
need_rg "conservation always" '^### Always' "$DOC"
need_rg "conservation never" '^### Never' "$DOC"
need_rg "collective N>=2 honesty" 'N≥2' "$DOC"
need_rg "Aiko integration inventory" '^## 9\. Aiko integration surface' "$DOC"
need_rg "open gaps remain explicit" 'Multi-host double-settle.*Open' "$DOC"
need_rg "agent boundary policy remains honest" 'Agent chooses discretionary Contract boundary correctly.*Open' "$DOC"
need_rg "mechanical witness documented" 'bash scripts/witness-first-principles\.sh' "$DOC"
need_rg "capability matrix documented" '^## 11\. Capability test matrix' "$DOC"
need_rg "comprehensive gate documented" 'bash scripts/test-first-principles-capabilities\.sh' "$DOC"
need_file "$ROOT/scripts/test-first-principles-capabilities.sh"

# Aiko application bridges named by the integration inventory.
need_rg "D2 tick bridge" 'pub async fn tick_due_contracts' "$NATIVE"
need_rg "grounded settle bridge" 'pub async fn settle_contract_claim' "$NATIVE"
need_rg "prompt settle/release chokepoint" 'settle_contract_prompt' "$NATIVE"
need_rg "finite claim lease" 'lease_until_unix' "$NATIVE"
need_rg "Contract tick ABI" 'contract_tick_json' "$NATIVE"
need_rg "Contract settle ABI" 'contract_settle_execution_json' "$NATIVE"
need_rg "Contract cancel ABI" 'contract_cancel' "$NATIVE"
need_rg "reflex bridge" 'pub fn decide_reflex' "$NATIVE"
need_rg "cold/proven recommendation bridge" 'recommend_proven' "$NATIVE"
need_rg "resident claim worker" 'run_contract_worker' "$WORKER"
# The agent-facing policy moved from ambient prompt prose into the admitted
# Meta-Agent connectome; the native reminder must delegate to it.
need_rg "native reminder delegates to admitted connectome" 'default connectome' "$NATIVE"
need_rg "agent multiscale system policy" 'action -> sensor -> evaluator' "$META"
need_rg "agent flywheel reentry policy" 'bounded new occurrence' "$META"
need_rg "native internal system compiler" 'pub fn compileInternalSystem' "$CONTRACT/libcontract/src/workflow.zig"
need_rg "native internal system cycle refusal" '\\"graph_reentry\\":false' "$CONTRACT/libcontract/src/workflow.zig"
need_rg "Aiko internal system ABI adapter" 'contract_compile_internal_system_json' "$ROOT/scripts/contract_workflow.py"
need_rg "native effect antiparticle settlement gate" 'contract_validate_effect_evidence_json' "$CONTRACT/libcontract/src/c_abi.zig"
need_rg "Aiko effect antiparticle ABI adapter" 'contract_validate_effect_evidence_json' "$ROOT/scripts/contract_workflow.py"

# The README must keep the complete map discoverable.
need_rg "documentation index link" 'PHOTON-POSITRON-FIRST-PRINCIPLES\.md' "$ROOT/docs/README.md"

printf '\n=== aiko summary: %d pass, %d fail ===\n' "$PASS" "$FAIL"

# The sibling proves the underlying Contract laws. Run it after local checks so
# an Aiko documentation regression cannot hide behind an upstream green.
bash "$CONTRACT/scripts/witness-first-principles.sh"
if [[ "$FAIL" -ne 0 ]]; then
  printf 'FAILURES — aiko first-principles integration regression\n'
  exit 1
fi
printf 'ALL PASS — Aiko integration and Contract substrate code homes present\n'
