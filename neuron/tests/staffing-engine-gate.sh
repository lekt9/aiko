#!/usr/bin/env bash
# Runnable witness for the staffing engine — the brief's Step 2, and the node
# that FEEDS the escalation ladder: an order plus a worker database produce a
# roster, or the firing refuses.
#
# This one sits on the recompute path, which fixes its shape before any product
# question is asked. CLAUDE.md: "a producer on the recompute path must be
# deterministic. A non-deterministic producer re-derives a different answer,
# invalidates its own dependents, and never reaches a fixpoint. Determinism is
# the termination proof, not a preference." A roster engine that picked
# differently on two identical inputs would re-invalidate the ladder every pass
# and re-message workers forever. So the assignment is a pure function of pinned
# reads, and assertion 1 is what holds it there.
#
# Five assertions:
#
#   1. DETERMINISTIC. Two firings over identical inputs produce byte-identical
#      rosters. This is the termination proof, not a style preference. Note the
#      realistic way to break it: iterate a Python set. CPython randomizes str
#      hashing per process, so set order genuinely differs BETWEEN firings —
#      the bug would be invisible in one run and fatal across two.
#
#   2. QUALIFICATION IS NEVER VIOLATED. A worker is only assigned a role their
#      record lists. Assigning someone unqualified to a crane is the failure
#      that ends up in an incident report, not a bug report.
#
#   3. ROTATION IS BY LEAST-RECENTLY-WORKED. The engine prefers the worker
#      furthest from their last shift, ties broken by name so the order is
#      total. Asserted by requiring a specific worker to be EXCLUDED — the one
#      who worked most recently — because "someone was assigned" is satisfied
#      by any policy at all, including none.
#
#   4. A SHORTFALL REFUSES, AND WRITES NOTHING. An order needing more qualified
#      workers than exist does not quietly produce a short roster. It fails
#      closed and leaves no artifact, because a half-filled roster that looks
#      complete is worse than no roster: the ladder would notify it.
#
#   5. THE OUTPUT FEEDS THE LADDER. The roster parses into the comma-separated
#      form `escalation-ladder-gate.sh` consumes. Two nodes that each work but
#      cannot be joined are not a graph.
#
# Assertion 4 is the falsifier worth keeping: 1, 2, 3 and 5 all still pass while
# the engine silently under-fills every order it cannot satisfy.
#
# Synthetic workers only. No customer data.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="$repo/zig-out/bin/neuron"
[ -x "$binary" ] || { echo "FAIL: build first (zig build)"; exit 1; }

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-staffing.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

export HOME="$gate_root"
cd "$gate_root"

node="$gate_root/node"
state="$node/state"
log="$state/substrate.log"
pkg="$gate_root/pkg"

artifact_bytes() {
    python3 - "$log" "$1" <<'PY'
import json, sys
found = None
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    for a in rec.get("artifacts", []):
        if a["id"] == sys.argv[2]:
            found = a["bytes"]
sys.stdout.write("" if found is None else bytes.fromhex(found).decode("utf-8", "replace"))
PY
}

mkdir -p "$pkg/neurons"

cat > "$pkg/SKILL.md" <<'DOC'
---
name: gate/staffing-engine
description: Turns a shift order plus a worker database into a role-assigned roster, by qualification and least-recently-worked rotation. Fires on an order stimulus. Refuses rather than under-fill.
probe_input: crane:2,lash:1
expect_contains: crane=ben,gus;lash=fay
---

# gate/staffing-engine

Fixture limb for `staffing-engine-gate.sh`. Deterministic by construction: the
assignment is a pure function of the pinned order and worker records, sorted by
(last_worked, name) so the ordering is total. It sits on the recompute path, so
a non-deterministic pick here would prevent the whole graph from ever settling.
DOC

cat > "$pkg/neuron.json" <<'JSON'
{
  "schema": "typed-neuron.limb-manifest/v1",
  "package": "gate/staffing-engine",
  "version": "0.1.0",
  "description": "Order + worker database -> roster, or a refusal.",
  "neurons": [
    {
      "id": "plan",
      "argv": ["python3", "neurons/plan.py"],
      "caps_request": {
        "allow_write": true, "write_prefix": "artifact/staffing/",
        "allow_send": false,
        "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 0, "max_bytes": 65536}
      }
    }
  ],
  "budgets": {"deadline_ms_per_firing": 30000}
}
JSON

cat > "$pkg/neurons/plan.py" <<'PY'
#!/usr/bin/env python3
# Order + worker database -> roster.
#
# DETERMINISM IS THE CONTRACT. This producer is on the recompute path, so the
# selection must be a total order over the pinned inputs and nothing else. No
# sets, no dict-order reliance, no clock: CPython randomizes str hashing per
# process, so a set here would reorder BETWEEN firings and the graph would never
# reach a fixpoint.
import json, sys

stim = json.load(sys.stdin)
order, workers = None, None
for ref in stim.get("reads", []):
    if ref["id"] == "artifact/staffing/order":
        order = ref["bytes"]
    elif ref["id"] == "artifact/staffing/workers":
        workers = ref["bytes"]

if order is None or workers is None:
    json.dump({"schema": "neuron.rejection/v1", "failure": "dependency",
               "detail": "order or worker database not staged"}, sys.stdout)
    sys.exit(0)

# workers: "name:role|role:last_worked" per line
db = []
for line in workers.strip().splitlines():
    name, roles, last = line.split(":")
    db.append((name, roles.split("|"), int(last)))

# order: "role:count,role:count"
want = []
for part in order.split(","):
    role, count = part.split(":")
    want.append((role, int(count)))

assigned, taken = [], []
for role, count in want:
    # Qualification first, then rotation: least-recently-worked, name as the
    # total-order tiebreak so two workers on the same shift never coin-flip.
    pool = [w for w in db if role in w[1] and w[0] not in taken]
    pool.sort(key=lambda w: (w[2], w[0]))
    if len(pool) < count:
        # Fail closed. A short roster that looks complete gets NOTIFIED, and
        # the shift is discovered understaffed at the berth instead of here.
        json.dump({"schema": "neuron.rejection/v1", "failure": "policy",
                   "detail": "role %s needs %d qualified workers, %d available"
                             % (role, count, len(pool))}, sys.stdout)
        sys.exit(0)
    picked = [w[0] for w in pool[:count]]
    taken.extend(picked)
    assigned.append("%s=%s" % (role, ",".join(picked)))

roster = ";".join(assigned)
order_id = stim.get("firing_id", "o").rsplit("/", 1)[-1]
json.dump({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "planned"},
    "effects": [{"kind": "write", "artifact": {
        "id": "artifact/staffing/roster/%s" % order_id,
        "schema": "gate.roster/v1", "bytes": roster}}],
    "evidence": [{"claim": "roster assigned by qualification and least-recently-worked rotation",
                  "method": "gate fixture",
                  "sources": ["artifact/staffing/order", "artifact/staffing/workers"]}],
}, sys.stdout)
PY

"$binary" agent init "$node" staffing >/dev/null
"$binary" limb admit "$pkg" "$state" >/dev/null || fail "the staffing engine was refused admission"

# ana worked most recently (5); ben least (1). dot and fay are lash-only.
# gus TIES with ben on last_worked. Without a tie the tiebreak is dead code, and
# a mutation putting hash() there is invisible — which is exactly how it survived
# the first version of this gate.
WORKERS='ana:crane:5
ben:crane:1
cal:crane:3
dot:lash:2
eve:crane|lash:4
fay:lash:0
gus:crane:1'

plan() {  # plan <order-id> <order-spec>
    python3 - "$1" "$2" "$WORKERS" > "$gate_root/s.json" <<'PY'
import hashlib, json, sys
oid, order, workers = sys.argv[1], sys.argv[2], sys.argv[3]
def pin(rid, val):
    return {"id": rid, "schema": "gate.input/v1",
            "digest": hashlib.sha256(val.encode()).hexdigest(), "bytes": val}
reads = [pin("artifact/staffing/order", order), pin("artifact/staffing/workers", workers)]
json.dump({"schema": "neuron.stimulus/v1", "firing_id": "plan/%s" % oid,
           "receptor_schema": "gate.order/v1", "reads": reads,
           "permitted_reads": [r["id"] for r in reads], "messages": []}, sys.stdout)
PY
    set +e
    # PLAN_SEED varies CPython's string-hash randomisation for this firing.
    # Comparing two firings under DIFFERENT seeds turns the determinism check
    # from a coin flip into a proof: any ordering that depends on hash() must
    # diverge, while a pure (last_worked, name) sort cannot. The earlier version
    # compared two firings under whatever seeds they happened to get and caught
    # a hash-based tiebreak only about half the time — a flaky gate, which is
    # worse than a failing one.
    PYTHONHASHSEED="${PLAN_SEED:-0}" "$binary" limb run "$state" --package "$pkg" --neuron plan \
        --stimulus "$gate_root/s.json" >"$gate_root/out.txt" 2>"$gate_root/err.txt"
    PLAN_RC=$?
    set -e
}

# A neuron that REFUSES is not a harness failure — the CLI exits non-zero for
# both, which is why this gate separates them. Conflating the two is how a gate
# ends up reporting a correct fail-closed refusal as breakage.
plan_ok() {
    plan "$@"
    [ "$PLAN_RC" = "0" ] || {
        grep -oE "error\.[A-Za-z]+" "$gate_root/err.txt" | head -2 >&2
        fail "firing 'plan/$1' should have succeeded"
    }
}
plan_refused() {
    plan "$@"
    [ "$PLAN_RC" != "0" ] || fail "firing 'plan/$1' SUCCEEDED where a refusal was required"
}

# --- 1. deterministic ------------------------------------------------------
# CONSTRUCT the discriminating seed pair rather than guess one. ben and gus tie
# on last_worked, so a hash-based tiebreak orders them by hash(name). Two
# arbitrary seeds agree about half the time — picking constants and hoping is
# how the first version of this check ended up flaky. Instead, search for one
# seed that puts ben first and one that puts gus first: under THOSE two, any
# hash-dependent ordering must diverge, while (last_worked, name) cannot.
read -r SEED_A SEED_B <<<"$(python3 - <<'PY2'
import subprocess, sys
first = {}
for seed in range(0, 400):
    out = subprocess.run([sys.executable, "-c",
        "p=[('ben',1),('gus',1)];p.sort(key=lambda w:(w[1],hash(w[0])));print(p[0][0])"],
        env={"PYTHONHASHSEED": str(seed), "PATH": "/usr/bin:/bin"},
        capture_output=True, text=True).stdout.strip()
    first.setdefault(out, seed)
    if len(first) == 2:
        print(first["ben"], first["gus"]); sys.exit(0)
sys.exit(1)
PY2
)" || fail "could not construct a seed pair that flips the tie — the determinism check would be vacuous"
echo "  seeds $SEED_A / $SEED_B flip a hash-ordered tie in opposite directions"

PLAN_SEED=$SEED_A plan_ok o1 "crane:2,lash:1"
PLAN_SEED=$SEED_B plan_ok o2 "crane:2,lash:1"
r1="$(artifact_bytes artifact/staffing/roster/o1)"
r2="$(artifact_bytes artifact/staffing/roster/o2)"
[ -n "$r1" ] || fail "the first order produced no roster"
[ "$r1" = "$r2" ] || fail "NON-DETERMINISTIC under two hash seeds: '$r1' then '$r2'. This producer is on the recompute path; the graph would never reach a fixpoint."
# ben and gus TIE on last_worked, so the tiebreak is live: pin the exact result
# rather than only self-consistency. Two runs agreeing is satisfied by any
# stable-but-wrong order; this is satisfied only by (last_worked, name).
[ "$r1" = "crane=ben,gus;lash=fay" ] \
    || fail "roster is '$r1', expected exactly 'crane=ben,gus;lash=fay' — ben before gus is the NAME tiebreak on an equal last_worked"
echo "  deterministic across hash seeds, and the tie breaks by name ($r1)"

# --- 2. qualification ------------------------------------------------------
crane_part="${r1%%;*}"                    # "crane=..."
lash_part="${r1##*;}"                    # "lash=..."
case "$crane_part" in
    *dot*|*fay*) fail "a lash-only worker was assigned to crane: $crane_part" ;;
esac
# The second role is where `role in w[1] or assigned` mis-assigns, so check it.
case "$lash_part" in
    *ana*|*ben*|*cal*|*gus*) fail "a crane-only worker was assigned to lash: $lash_part" ;;
esac
echo "  qualification: holds in both directions, not just the first role"

# --- 3. rotation is by least-recently-worked -------------------------------
# ana worked most recently of the crane pool and must be EXCLUDED; ben worked
# least recently and must be picked. Asserting only "someone was assigned"
# would be satisfied by no rotation policy at all.
case "$crane_part" in
    *ana*) fail "rotation ignored: ana worked most recently and was still assigned ($crane_part)" ;;
esac
case "$crane_part" in
    *ben*) : ;;
    *) fail "rotation ignored: ben worked least recently and was not assigned ($crane_part)" ;;
esac
echo "  rotation: least-recently-worked chosen, most-recently-worked excluded"

# --- 4. a shortfall refuses, and writes nothing ---------------------------
# Only four workers are crane-qualified. Asking for five must fail closed.
plan_refused o3 "crane:6"
[ -z "$(artifact_bytes artifact/staffing/roster/o3)" ] \
    || fail "an unsatisfiable order produced a roster anyway: '$(artifact_bytes artifact/staffing/roster/o3)'. A short roster that looks complete gets notified."

# The discriminating case: QUALIFIED is sufficient but AVAILABLE is not.
# crane:4 consumes ben, gus, cal AND eve — and eve is the only crane worker who
# is also lash-qualified. Three workers are lash-qualified (dot, eve, fay) but
# only two remain FREE, so a guard that counts qualified-rather-than-available
# sails past the check and then silently under-fills from a two-worker pool.
# The previous version of this gate could not tell those two guards apart.
plan_refused o4 "crane:4,lash:3"
[ -z "$(artifact_bytes artifact/staffing/roster/o4)" ] \
    || fail "SHORTFALL MISSED: lash has 3 qualified workers but only 2 free after crane took eve, and a roster was produced anyway: '$(artifact_bytes artifact/staffing/roster/o4)'"
echo "  shortfall refuses on AVAILABLE, not merely qualified, and writes nothing"

# --- 5. the output feeds the ladder ---------------------------------------
# The ladder consumes a comma-separated worker list. Every name in the roster
# must be a known worker, or the two nodes cannot be joined.
python3 - "$r1" "$WORKERS" <<'PY' || exit 1
import sys
roster, workers = sys.argv[1], sys.argv[2]
known = {l.split(":")[0] for l in workers.strip().splitlines()}
names = []
for group in roster.split(";"):
    names.extend(group.split("=")[1].split(","))
unknown = [n for n in names if n not in known]
if unknown:
    print("FAIL: roster names nobody in the worker database: %s" % unknown); sys.exit(1)
if len(names) != len(set(names)):
    print("FAIL: a worker was assigned twice in one roster: %s" % names); sys.exit(1)
print("  feeds the ladder: %d distinct known workers -> %s" % (len(names), ",".join(names)))
PY

echo "staffing-engine gate: PASS"
