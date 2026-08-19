#!/usr/bin/env bash
# witness-plan3-resident.sh — smoke that Plan 3 residents exist in the tree.
# Does not start a long-running daemon. Exit 0 = scaffolding present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_ROOT="$(cd "$ROOT/../contract" 2>/dev/null && pwd || true)"
FAIL=0

say() { printf '%s\n' "$*"; }
pass() { say "PASS  $*"; }
fail() { say "FAIL  $*"; FAIL=1; }

say "=== plan3 resident witness ==="
say "aiko root: $ROOT"

# 1. Plan + runtime docs (the plan is archived process history, not a worklist)
if [[ -f "$ROOT/../archive/plans/aiko-plan3.md" ]]; then
  pass "archived plan3 present"
else
  fail "archive/plans/aiko-plan3.md missing"
fi

if [[ -n "${CONTRACT_ROOT:-}" && -f "$CONTRACT_ROOT/docs/PHOTON-POSITRON-RUNTIME.md" ]]; then
  pass "PHOTON-POSITRON-RUNTIME.md present"
elif [[ -f "$ROOT/docs/PHOTON-POSITRON-RUNTIME.md" ]]; then
  pass "PHOTON-POSITRON-RUNTIME.md present (aiko mirror)"
else
  fail "PHOTON-POSITRON-RUNTIME.md missing"
fi

# 2. Contract CLI exposes tick / resident every
CONTRACT_BIN=""
for c in \
  "$CONTRACT_ROOT/libcontract/zig-out/bin/contract" \
  "$CONTRACT_ROOT/zig-out/bin/contract" \
  "$(command -v contract 2>/dev/null || true)"; do
  if [[ -n "$c" && -x "$c" ]]; then
    CONTRACT_BIN="$c"
    break
  fi
done

if [[ -n "$CONTRACT_BIN" ]]; then
  pass "contract binary: $CONTRACT_BIN"
  help_out="$("$CONTRACT_BIN" --help 2>&1 || true)"
  if echo "$help_out" | grep -qiE 'tick'; then
    pass "contract help mentions tick"
  else
    # identity JSON mentions tick on some builds
    id_out="$("$CONTRACT_BIN" identity 2>&1 || "$CONTRACT_BIN" version 2>&1 || true)"
    if echo "$id_out$help_out" | grep -qiE 'tick|--every|resident'; then
      pass "contract surfaces tick/resident in identity/help"
    else
      fail "contract binary does not advertise tick"
    fi
  fi
else
  # Source-level witness when binary not built
  if [[ -n "${CONTRACT_ROOT:-}" ]] && grep -q 'tick --every' "$CONTRACT_ROOT/zig/src/main.zig" 2>/dev/null; then
    pass "source: cmdTick implements tick --every (binary not on PATH)"
  else
    fail "no contract binary and no tick --every source"
  fi
fi

# 3. Aiko ABI tick path in source
if grep -q 'tick_due_contracts' "$ROOT/crates/codegen/xai-grok-shell/src/contract_native.rs" 2>/dev/null; then
  pass "aiko contract_native::tick_due_contracts present"
else
  fail "tick_due_contracts missing in contract_native.rs"
fi

if grep -q 'run_contract_worker' "$ROOT/crates/codegen/xai-grok-pager-bin/src/main.rs" 2>/dev/null; then
  pass "aiko run_contract_worker loop present"
else
  fail "run_contract_worker missing"
fi

# 4. Scheduler lease language in contract
if [[ -n "${CONTRACT_ROOT:-}" ]] && grep -q 'lease_until_unix' "$CONTRACT_ROOT/libcontract/src/scheduler.zig" 2>/dev/null; then
  pass "scheduler lease_until_unix present"
else
  fail "scheduler lease kernel not found"
fi

# 5. Cycle rejection doctrine in muscle docs/source
if [[ -n "${CONTRACT_ROOT:-}" ]] && grep -qi 'cycle' "$CONTRACT_ROOT/docs/MUSCLE-MEMORY.md" 2>/dev/null; then
  pass "muscle memory documents cycle rejection"
else
  fail "muscle cycle rejection not documented"
fi

say "=== result ==="
if [[ "$FAIL" -eq 0 ]]; then
  say "ALL PASS — plan3 resident scaffolding witnessed"
  exit 0
else
  say "FAILURES — see FAIL lines above"
  exit 1
fi
