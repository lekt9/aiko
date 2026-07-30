#!/usr/bin/env bash
# witness-first-principles.sh — mechanical regression guard for
# docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md laws against the source tree.
#
# Exit 0 = laws still have code homes. Does not prove product-wide surface
# coverage or multi-host behavior (those remain OPEN in §17).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAIL=0
PASS=0

pass() { printf 'PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }
need_file() {
  if [[ -f "$1" ]]; then pass "file $1"
  else fail "missing file $1"
  fi
}
need_rg() {
  local desc="$1" pattern="$2" path="$3"
  if [[ ! -e "$path" ]]; then
    fail "$desc — path missing: $path"
    return
  fi
  if rg -q "$pattern" "$path" 2>/dev/null; then
    pass "$desc"
  else
    fail "$desc — pattern not found in $path: $pattern"
  fi
}

printf '=== first-principles witness (contract tree) ===\n'
printf 'root: %s\n' "$ROOT"

# ── Canon docs ──────────────────────────────────────────────────────
need_file docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md
need_file docs/PHOTON-POSITRON-CONTRACT-EBM.md
need_file docs/PHOTON-POSITRON-GAPS.md
need_file docs/PHOTON-POSITRON-RUNTIME.md

# ── A2 Terminal alphabet (exactly three) ────────────────────────────
need_rg "A2 terminal.classify satisfied" 'satisfied' libcontract/src/terminal.zig
need_rg "A2 terminal.classify died" 'died' libcontract/src/terminal.zig
need_rg "A2 terminal.classify purged" 'purged' libcontract/src/terminal.zig
need_rg "A2 EXACTLY three events" 'EXACTLY three' libcontract/src/terminal.zig
need_rg "A2 classify fn" 'pub fn classify' libcontract/src/terminal.zig

# ── A4 / E3 Cold refuse ─────────────────────────────────────────────
need_rg "A4 cold energy +inf" 'inf\(f64\)' libcontract/src/ebm.zig
need_rg "A4 route null if cold" 'null if all cold' libcontract/src/ebm.zig
need_rg "A4 recommend cold null" 'Cold \(nothing learned\)' libcontract/src/route.zig

# ── E1 Energy definition ────────────────────────────────────────────
need_rg "E1 energy = -cosine" 'energy = -cosine' libcontract/src/ebm.zig

# ── B1 Cycle reject + cutoffs ───────────────────────────────────────
need_rg "B1 cycle-checked expand" 'cycle-checked' libcontract/src/muscle.zig
need_rg "B1 MAX_WAVES" 'MAX_WAVES' libcontract/src/muscle.zig
need_rg "B1 MAX_NODES" 'MAX_NODES' libcontract/src/muscle.zig
need_rg "B1 cycle test" 'cycles are refused' libcontract/src/muscle.zig

# ── A1 / P1 Task duals (task begin requires --check) ────────────────
need_rg "A1 task begin requires --check" '"--check"' zig/src/main.zig
need_rg "A1 usage task begin --check" 'task begin' zig/src/main.zig

# ── D2/D3 Tick / resident ───────────────────────────────────────────
need_rg "D3 tick --every resident" 'tick --every' zig/src/main.zig
need_rg "D2 resolverTick" 'fn resolverTick' zig/src/main.zig
need_rg "D4 lease_until" 'lease_until_unix' libcontract/src/scheduler.zig
need_rg "D4 execution_released" 'execution_released' libcontract/src/scheduler.zig

# ── Gate + reflex antiparticles ─────────────────────────────────────
need_rg "P1 gate allow|confirm|deny" 'allow, confirm, deny|enum \{ allow' libcontract/src/gate.zig
need_rg "P1 reflex fire/prepare/hold" 'fire, prepare, hold' libcontract/src/reflex.zig
need_rg "P1 reflex decide" 'pub fn decide' libcontract/src/reflex.zig

# ── K1 Catabolism ───────────────────────────────────────────────────
need_rg "K1 compactIfOversized" 'compactIfOversized' zig/src/main.zig
need_rg "E8 freshness/atrophy" 'fn freshness' libcontract/src/ebm.zig
need_rg "E8 HALFLIFE" 'HALFLIFE' libcontract/src/ebm.zig

# ── F1 Ledger primacy (append via ledger) ───────────────────────────
need_rg "F1 ledger module" 'jsonl|append' libcontract/src/ledger.zig

# ── Parent reinforcement doctrine (B3) ──────────────────────────────
need_rg "B3 parent after children" 'child' docs/MUSCLE-MEMORY.md

# ── Skill duals reminder ────────────────────────────────────────────
need_rg "skill task begin --check" 'task begin' SKILL.md
need_rg "skill no LLM alone" 'Never claim success from an LLM' SKILL.md

# ── Surface inventory table present in first-principles ─────────────
need_rg "surface inventory section" 'Surface inventory' docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md

printf '\n=== summary: %d pass, %d fail ===\n' "$PASS" "$FAIL"
if [[ "$FAIL" -eq 0 ]]; then
  printf 'ALL PASS — first-principles code homes present\n'
  exit 0
fi
printf 'FAILURES — first-principles regression\n'
exit 1
