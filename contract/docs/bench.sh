#!/bin/bash
# bench.sh — reproducible benchmark harness for the contract substrate.
#
# Metrics (all --private: measures the substrate, never the network):
#   M1 cold_declare      — declare into a fresh ledger (p50/p95 ms, N runs)
#   M2 scaled_declare    — declare into a ledger pre-seeded with $SCALE rows
#   M3 decalogue_scan    — decalogue:purge:3 over the seeded ledger
#   M4 eval_close        — satisfied:<id> closure over the seeded ledger
#
# Methodology notes live in docs/journal.md. Harness sanity is checked
# before any number is trusted: the seeded ledger must be visible to the
# binary (scan reports the seeded bare rows), else the run aborts.
set -euo pipefail
A="$HOME/.claude/skills/contract/scripts/contract"
SCALE="${SCALE:-2000}"
RUNS="${RUNS:-15}"

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

mk_ledger() { # $1=dir $2=rows
  mkdir -p "$1/.claude"
  python3 - "$1/.claude/contracts.jsonl" "$2" << 'PY'
import sys, json
path, n = sys.argv[1], int(sys.argv[2])
with open(path, "w") as f:
    for i in range(n):
        cid = f"{i:08x}"
        f.write(json.dumps({"event": "declared", "id": cid,
            "plan": f"synthetic claim {i}", "action": "neuron",
            "pointer_type": "cell", "layer": 3, "cwd": "/tmp",
            "parent_id": None, "ts": "2026-06-01T00:00:00Z",
            "agent": "bench"}) + "\n")
        # Two thirds get a terminal event so the frontier stays realistic.
        if i % 3 != 0:
            f.write(json.dumps({"event": "satisfied", "id": cid, "wave": 1,
                "ts": "2026-06-01T00:01:00Z", "agent": "bench",
                "learning": "synthetic proof, long enough to be thick"}) + "\n")
PY
}

bench() { # $1=label $2=cwd $3...=goal words; prints "label ms" per run
  local label="$1" dir="$2"; shift 2
  local t0 t1
  t0=$(now_ms)
  ( cd "$dir" && "$A" declare "$@" --register ) > /dev/null 2>&1 || true
  t1=$(now_ms)
  echo "$label $(( t1 - t0 ))"
}

pcts() { # stdin: one ms per line → "p50=X p95=Y n=N"
  python3 -c '
import sys
v = sorted(int(x) for x in sys.stdin)
def p(q): return v[min(len(v)-1, int(q*len(v)))]
print(f"p50={p(0.5)} p95={p(0.95)} n={len(v)}")'
}

echo "== contract substrate bench  scale=$SCALE runs=$RUNS  $(date -u +%FT%TZ)"
echo "binary: $($A 2>&1 | head -1 || true)"

# M1 — cold declare
M1=()
for i in $(seq "$RUNS"); do
  D=$(mktemp -d); mkdir -p "$D/.claude"; : > "$D/.claude/contracts.jsonl"
  M1+=("$(bench m1 "$D" "bench cold declare probe $i" | awk '{print $2}')")
  rm -rf "$D"
done
echo "M1 cold_declare:    $(printf '%s\n' "${M1[@]}" | pcts)"

# Seeded ledger for M2-M4 (reused; each run appends, ledger grows slightly —
# growth per run is constant so percentiles stay comparable).
S=$(mktemp -d); mk_ledger "$S" "$SCALE"
# Harness sanity: the binary must SEE the seeded rows before numbers count.
sanity=$( (cd "$S" && "$A" "decalogue:purge:3" --private 2>&1 || true) | grep -c 'commandment 3 violation' )
if [ "$sanity" -lt $(( SCALE / 4 )) ]; then
  echo "HARNESS BROKEN: scan saw only $sanity bare rows of ~$((SCALE/3)) seeded — aborting" >&2
  exit 1
fi
echo "harness sanity: scan sees $sanity bare rows (expected ~$((SCALE/3))) — OK"

M2=(); M3=(); M4=()
for i in $(seq "$RUNS"); do
  M2+=("$(bench m2 "$S" "bench scaled declare probe $i" | awk '{print $2}')")
done
for i in $(seq "$RUNS"); do
  M3+=("$(bench m3 "$S" "decalogue:purge:3" | awk '{print $2}')")
done
for i in $(seq "$RUNS"); do
  tid=$(printf '%08x' $(( (i * 3) % SCALE )))
  M4+=("$(bench m4 "$S" "satisfied:$tid wave=$i — bench closure with a sufficiently thick proof line" | awk '{print $2}')")
done
echo "M2 scaled_declare:  $(printf '%s\n' "${M2[@]}" | pcts)"
echo "M3 decalogue_scan:  $(printf '%s\n' "${M3[@]}" | pcts)"
echo "M4 eval_close:      $(printf '%s\n' "${M4[@]}" | pcts)"
rm -rf "$S"
