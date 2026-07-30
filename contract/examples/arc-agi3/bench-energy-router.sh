#!/bin/bash
# Phase 1 prove-or-kill benchmark for the energy router.
#
# Frontier: N independent pairs — producer P_i (a python: leaf that satisfies)
# and consumer C_i = fulfil:P_i. Consumers are declared NEWER than producers, so
# the drill's newest-first scan fires every consumer BEFORE its producer: each
# consumer HOLDs (producer unsettled) and only resolves a pass later — 2 passes
# to settle. The centroid is pre-seeded from satisfied python contracts, so with
# AIKO_ENERGY_RANK=1 the router fires the (resolved-like) producers first; each
# consumer, fired after its producer satisfied in the SAME pass, resolves
# immediately — 1 pass. Fewer passes = the router earned its keep.
#
# Reorder-only + gated: the two runs use the IDENTICAL binary and frontier;
# only AIKO_ENERGY_RANK differs. That isolates the ordering effect.
set -euo pipefail
CONTRACT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/contract"
N=8

build_frontier() {
  local ledger="$1"
  : > "$ledger"
  # Seed: satisfied python contracts train the centroid toward "python = resolved-like".
  for i in 0 1 2 3 4 5; do
    local sid="5eed000$i"
    printf '%s\n' "{\"event\":\"declared\",\"id\":\"$sid\",\"plan\":\"seed producer\",\"action\":\"python:print($i,end='')\",\"parent_id\":null,\"ts\":\"2026-07-14T00:00:0${i}Z\"}" >> "$ledger"
    printf '%s\n' "{\"event\":\"satisfied\",\"id\":\"$sid\",\"action_result\":\"$i\",\"ts\":\"2026-07-14T00:00:1${i}Z\"}" >> "$ledger"
  done
  # Frontier: producers (older) then consumers (newer) so newest-first scan hits consumers first.
  for i in $(seq 0 $((N-1))); do
    local p=$(printf 'aa0000%02d' "$i")
    printf '%s\n' "{\"event\":\"declared\",\"id\":\"$p\",\"plan\":\"producer $i\",\"action\":\"python:print('p$i',end='')\",\"parent_id\":null,\"ts\":\"2026-07-15T00:00:00Z\"}" >> "$ledger"
  done
  for i in $(seq 0 $((N-1))); do
    local p=$(printf 'aa0000%02d' "$i"); local c=$(printf 'cc0000%02d' "$i")
    printf '%s\n' "{\"event\":\"declared\",\"id\":\"$c\",\"plan\":\"consumer $i\",\"action\":\"fulfil:$p\",\"parent_id\":null,\"ts\":\"2026-07-15T00:00:01Z\"}" >> "$ledger"
  done
}

run_mode() {
  local mode="$1" tmp ledger ev passes real
  tmp=$(mktemp -d); mkdir -p "$tmp/.claude"; ledger="$tmp/.claude/contracts.jsonl"; ev="$tmp/ev"
  build_frontier "$ledger"
  ( cd "$tmp"; export HOME="$tmp"
    if [ "$mode" = energy ]; then export AIKO_ENERGY_RANK=1; fi
    "$CONTRACT" declare "energy bench drill" >/dev/null 2>"$ev" || true )
  passes=$(grep -c "backfill pass" "$ev" || true)
  # count how many of the 16 real frontier contracts satisfied
  real=$(python3 - "$ledger" <<'PY'
import sys,json
sat=set()
for line in open(sys.argv[1]):
    try:r=json.loads(line)
    except:continue
    i=r.get("id","")
    if r.get("event")=="satisfied" and (i.startswith("aa0000") or i.startswith("cc0000")): sat.add(i)
print(len(sat))
PY
)
  echo "$mode: backfill_passes=$passes  frontier_satisfied=$real/$((N*2))"
  # emit machine-readable line for the assertion
  echo "RESULT $mode $passes $real" >&2
  rm -rf "$tmp"
}

echo "=== Phase 1 energy-router benchmark ($N producer/consumer pairs) ==="
scan_r=$(run_mode scan 2>/tmp/_bs); cat /tmp/_bs | grep -v RESULT || true; echo "$scan_r"
energy_r=$(run_mode energy 2>/tmp/_be); cat /tmp/_be | grep -v RESULT || true; echo "$energy_r"
sp=$(echo "$scan_r"   | grep -oE 'backfill_passes=[0-9]+' | grep -oE '[0-9]+')
ep=$(echo "$energy_r" | grep -oE 'backfill_passes=[0-9]+' | grep -oE '[0-9]+')
ss=$(echo "$scan_r"   | grep -oE 'satisfied=[0-9]+' | grep -oE '[0-9]+' | head -1)
es=$(echo "$energy_r" | grep -oE 'satisfied=[0-9]+' | grep -oE '[0-9]+' | head -1)
# correctness: both must fully settle
[ "$ss" = "$((N*2))" ] && [ "$es" = "$((N*2))" ] || { echo "FAIL: a mode did not fully settle (scan=$ss energy=$es of $((N*2)))"; exit 1; }
# the claim: energy settles in strictly fewer passes
if [ "$ep" -lt "$sp" ]; then
  echo "PASS: energy-ranked resolution beat scan-order — $ep passes vs $sp ($(( (sp-ep)*100/sp ))% fewer), 16/16 both"
else
  echo "FAIL: energy ($ep passes) did NOT beat scan ($sp passes) — the router earned nothing"
  exit 1
fi
