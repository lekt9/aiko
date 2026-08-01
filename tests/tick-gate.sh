#!/usr/bin/env bash
# Runnable witness for `aiko-doctor tick` — the pass that closes the loop
# between the two layers.
#
# Both halves existed and neither ran on its own: `bridge` mirrored firings into
# the ledger, `redrive` acted on stale derivations, and each was a manual
# one-shot. A system documented as event-driven still needed a human to turn
# each crank. This is the crank, and these are its two dangerous properties.
#
#   1. IT REACHES A FIXPOINT. `redrive` commits firings of its own, so each pass
#      can create work for the next. If that never settled, a resident tick over
#      an idle substrate would grow the ledger forever — which is exactly the
#      non-termination R10 warns about, arriving from the other direction. The
#      gate runs six consecutive passes with NO new input and asserts the ledger
#      stops changing and stays stopped.
#
#   2. IT IS STILL AWAKE AT THE FIXPOINT. A loop that has quietly stopped doing
#      anything also "converges", and would pass assertion 1 on its own. So the
#      gate then does real work and asserts the very next tick moves again.
#
# Assertion 2 is what makes assertion 1 mean something. Neither is worth much
# alone.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

aiko="$repo/zig-out/bin/aiko"
doctor="$repo/zig-out/bin/aiko-doctor"
[ -x "$aiko" ] && [ -x "$doctor" ] || { echo "FAIL: build first (zig build)"; exit 1; }

root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-tick.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# Isolate BOTH identities the ledger is discovered from — see the note in
# `bridge-gate.sh`. `ledger.zig` resolves `<cwd>/.claude/` before `$HOME`, so a
# gate that runs from the repo root silently starts writing to the project
# ledger the moment a `.claude/` directory exists there.
export HOME="$root"
export PATH="$repo/zig-out/bin:$PATH"
mkdir -p "$root/.contracts"
cd "$root"
ledger="$root/.contracts/contracts.jsonl"

"$aiko" agent init "$root/n" a1 >/dev/null
"$aiko" agent run "$root/n" a1 --goal "tick gate probe" --json >/dev/null

rows() { [ -f "$ledger" ] && wc -l < "$ledger" | tr -d ' ' || echo 0; }
tick() { "$doctor" tick "$root/n/state" --agent a1 >/dev/null 2>&1 || fail "tick exited non-zero"; }

# --- 1. six passes with no new input must reach a fixpoint -----------------
prev=-1
stable=0
for i in $(seq 1 6); do
    tick
    now=$(rows)
    [ "$now" -gt 0 ] || fail "pass $i left the ledger empty — nothing was bridged at all"
    if [ "$now" = "$prev" ]; then stable=$((stable + 1)); else stable=0; fi
    prev=$now
done

# Passes 3..6 must all have been unchanged. Settling once and drifting again is
# not a fixpoint.
[ "$stable" -ge 3 ] || fail "the ledger never settled: still changing after 6 idle passes (last=$prev)"
settled=$prev
echo "  fixpoint after idle passes: $settled rows, unchanged across the last $stable"

# --- 2. and it is still awake ---------------------------------------------
# A loop that has stopped working also stops changing. Do real work and require
# the next tick to notice.
"$aiko" agent run "$root/n" a1 --goal "second goal, after the fixpoint" --json >/dev/null
tick
after=$(rows)
[ "$after" -gt "$settled" ] || fail "tick did not react to new firings ($settled -> $after): it converged by going to sleep"
echo "  reacts to new work at the fixpoint: $settled -> $after rows"

# --- and settles again -----------------------------------------------------
tick; a=$(rows); tick; b=$(rows)
[ "$a" = "$b" ] || fail "the ledger did not re-settle after new work ($a -> $b)"
echo "  re-settles after new work: $b rows"

echo "tick gate: PASS"
