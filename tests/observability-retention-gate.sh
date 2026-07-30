#!/usr/bin/env bash
# Runnable witness for derivation-graph retention across compaction
# (AGENTS.md §28.1–28.4). From an empty directory, through the public CLI only:
#
#   1. the derivation graph is recoverable at all — evidence citations are
#      journaled, so `stale` can answer which artifacts rest on moved sources;
#   2. that answer is *identical* before compaction, after compaction, after a
#      second compaction, and on a mixed journal of snapshot + fresh commits —
#      the four shapes a live node actually takes;
#   3. `trace` keeps per-firing identity across the fold and reports timing as
#      unavailable rather than as `0`, which already means "no clock";
#   4. §19 canonical form still holds: compacting identical state twice yields
#      byte-identical snapshots, which is what keeps a wall clock out;
#   5. adversarial journals — a torn snapshot, a ghost `produced_by`, a citation
#      to an artifact that never existed — produce no rows rather than guesses.
#
# Every assertion inspects durable state or CLI output derived from it. The
# gate fails closed if the feature is removed: assertion 2 compares real row
# sets, so a projection that goes blind after `compact` cannot pass it.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-observability-retention.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT
binary="$repo_dir/zig-out/bin/neuron"

fail() { echo "FAIL: $*" >&2; exit 1; }

# The comparable identity of a stale answer: which artifact, which source it
# rested on, and the ordinal relation between them. `redrivable` is expected to
# degrade after compaction (a snapshot keeps no per-firing messages), so it is
# deliberately excluded from the comparison — see §28.3.
stale_key() {
    "$binary" telemetry stale "$1" --json | python3 -c '
import json, sys
rows = [json.loads(line) for line in sys.stdin if line.strip()]
for r in sorted(rows, key=lambda r: r["artifact"]):
    print("%s|%s|%d<%d" % (r["artifact"], r["stale_source"], r["derived_at"], r["source_moved_at"]))
'
}

trace_ids() {
    "$binary" telemetry trace "$1" --json | python3 -c '
import json, sys
print("\n".join(sorted(json.loads(l)["firing_id"] for l in sys.stdin if l.strip())))
'
}

# ---------------------------------------------------------------------------
# 1. A real agent produces a real derivation graph.
# ---------------------------------------------------------------------------
node="$gate_root/node"
"$binary" agent init "$node" alpha >/dev/null
for goal in first second third; do
    "$binary" agent run "$node" alpha --goal "$goal" --json >/dev/null
done

before="$(stale_key "$node/state")"
[ -n "$before" ] || fail "no stale derivations before compaction: the graph was never recoverable"
before_trace="$(trace_ids "$node/state")"
[ -n "$before_trace" ] || fail "trace produced no rows before compaction"

# ---------------------------------------------------------------------------
# 2. The same answer in all four shapes a live node takes.
# ---------------------------------------------------------------------------
"$binary" compact "$node/state" >/dev/null
after="$(stale_key "$node/state")"
[ "$before" = "$after" ] || fail "compaction changed the stale answer:
before:
$before
after:
$after"

"$binary" compact "$node/state" >/dev/null
[ "$before" = "$(stale_key "$node/state")" ] || fail "second compaction changed the stale answer"

# Mixed mode: a snapshot with fresh commits appended. This is what every
# compacted node becomes, and it is where commit ordinals must continue past
# the folded firings rather than restarting at zero.
mixed="$gate_root/mixed"
"$binary" agent init "$mixed" beta >/dev/null
"$binary" agent run "$mixed" beta --goal first --json >/dev/null
"$binary" compact "$mixed/state" >/dev/null
"$binary" agent run "$mixed" beta --goal second --json >/dev/null
"$binary" agent run "$mixed" beta --goal third --json >/dev/null
mixed_answer="$(stale_key "$mixed/state")"
"$binary" compact "$mixed/state" >/dev/null
[ "$mixed_answer" = "$(stale_key "$mixed/state")" ] || fail "mixed-mode journal disagreed with its own compacted form"

# And a node that was never compacted at all must agree with both.
plain="$gate_root/plain"
"$binary" agent init "$plain" beta >/dev/null
for goal in first second third; do
    "$binary" agent run "$plain" beta --goal "$goal" --json >/dev/null
done
[ "$mixed_answer" = "$(stale_key "$plain/state")" ] || fail "compaction history changed the answer for identical work"

# ---------------------------------------------------------------------------
# 3. Trace survives, and is honest about what it lost.
# ---------------------------------------------------------------------------
[ "$before_trace" = "$(trace_ids "$node/state")" ] || fail "trace lost firings across compaction"
"$binary" telemetry trace "$node/state" --json | python3 -c '
import json, sys
rows = [json.loads(line) for line in sys.stdin if line.strip()]
assert rows, "no trace rows after compaction"
folded = [r for r in rows if r.get("from") == "snapshot"]
assert folded, "no rows reported as snapshot-sourced"
for r in folded:
    assert r.get("timing") == "unavailable", f"timing was fabricated after compaction: {r}"
    assert "elapsed_ms" not in r, f"a folded row carried an elapsed time it cannot know: {r}"
    assert r["cites"] >= 0 and r["writes"] >= 0, r
assert any(r["cites"] > 0 for r in folded), "no citations survived the fold"
' || fail "trace misreported what compaction discarded"

# ---------------------------------------------------------------------------
# 4. §19 canonical form: identical state, byte-identical snapshot.
# ---------------------------------------------------------------------------
canon="$gate_root/canon"
"$binary" agent init "$canon" gamma >/dev/null
"$binary" agent run "$canon" gamma --goal only --json >/dev/null
"$binary" compact "$canon/state" >/dev/null
first_hash="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$canon/state/substrate.log")"
"$binary" compact "$canon/state" >/dev/null
second_hash="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$canon/state/substrate.log")"
[ "$first_hash" = "$second_hash" ] || fail "compacting identical state produced different bytes: a non-deterministic field reached the snapshot"

# ---------------------------------------------------------------------------
# 5. Adversarial journals produce no rows, not guesses.
# ---------------------------------------------------------------------------
adv="$gate_root/adv"
mkdir -p "$adv/state"
good="$node/state/substrate.log"

# A torn final write.
python3 -c '
import sys
data = open(sys.argv[1], "rb").read()
open(sys.argv[2], "wb").write(data[: len(data) // 2])
' "$good" "$adv/state/substrate.log"
"$binary" telemetry stale "$adv/state" --json >/dev/null 2>&1 ||
    true  # a torn log may fail closed; it must not crash the harness or invent rows
torn_rows="$("$binary" telemetry stale "$adv/state" --json 2>/dev/null | wc -l | tr -d ' ')"
[ "$torn_rows" = "0" ] || fail "a torn snapshot produced $torn_rows stale rows"

# A produced_by naming a firing that never fired.
python3 -c '
import json, sys
rec = json.loads(open(sys.argv[1]).read().strip())
for artifact in rec["artifacts"]:
    artifact["produced_by"] = "agent/ghost/never-fired"
open(sys.argv[2], "w").write(json.dumps(rec) + "\n")
' "$good" "$adv/state/substrate.log"
ghost_rows="$("$binary" telemetry stale "$adv/state" --json 2>/dev/null | wc -l | tr -d ' ')"
[ "$ghost_rows" = "0" ] || fail "a ghost produced_by yielded $ghost_rows rows: the projection invented an ordinal"

# Evidence citing an artifact that never existed.
python3 -c '
import json, sys
rec = json.loads(open(sys.argv[1]).read().strip())
for firing in rec["firings"]:
    for item in firing.get("evidence", []):
        item["sources"] = ["artifact/does-not-exist"]
open(sys.argv[2], "w").write(json.dumps(rec) + "\n")
' "$good" "$adv/state/substrate.log"
unknown_rows="$("$binary" telemetry stale "$adv/state" --json 2>/dev/null | wc -l | tr -d ' ')"
[ "$unknown_rows" = "0" ] || fail "an unknown cited source was reported as moved"

# The good journal still replays: the adversarial cases mutated copies only.
"$binary" agent inspect "$node" alpha --json | python3 -c '
import json, sys
view = json.load(sys.stdin)
assert view["agent"] == "alpha" and view["goals"] == 3, view
'

echo "observability-retention gate: PASS"
