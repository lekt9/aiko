#!/usr/bin/env bash
# Runnable witness for the escalation ladder — the node graph the staffing
# brief describes and the step it says a general LLM agent is the wrong tool
# for: "each message is a node, reply/no-reply triggers the next node, call is
# a terminal fallback node".
#
# `conversation-gate.sh` already proves reply AUTHORITY (a neuron with no send
# capability can still answer a peer, because possession of an attested request
# confers the right to reply). `redrive-gate.sh` already proves COMPENSATION at
# the re-derivation layer (a firing that reached `outbox/` must never cross
# twice). Neither proves the thing in between: that the graph walks FORWARD
# through rungs, branches on whether a reply arrived, and STOPS.
#
# Four assertions, and each is a different way the ladder could be worthless:
#
#   1. FAN-OUT IS PER WORKER. One notify firing puts exactly one message on the
#      boundary for each worker, addressed individually. A ladder that sends one
#      broadcast cannot later tell who confirmed.
#
#   2. A CONFIRMED WORKER IS NEVER MESSAGED AGAIN. This is the commercial
#      property and the reason the brief rejects re-running a broad agent:
#      re-firing "notify 35 workers" re-messages the 31 who did not change.
#      The escalation neuron decides this from DURABLE STATE — it reads the
#      confirmation artifacts and skips those workers. Nothing in the stimulus
#      tells it whom to skip; if it did, this gate would be testing the gate.
#
#   3. THE LADDER TERMINATES. An unconfirmed worker advances notify -> follow-up
#      -> call, and `call` is the last rung. Driving the ladder again after that
#      must put NOTHING further on the boundary. A loop that keeps escalating a
#      silent worker forever is the non-termination R10 warns about, arriving
#      through the front door: each rung is a real phone call.
#
#   4. THE COUNTS ARE EXACTLY 1 / 2 / 3. A worker who replies immediately gets
#      one message; one who replies after the follow-up gets two; one who never
#      replies gets three and then nothing. Asserted per worker off the journal,
#      not in aggregate — an aggregate total of six is also what a ladder that
#      messaged the wrong people six times would produce.
#
# Assertion 3 is the falsifier. Remove the terminal check from `escalate.py`
# and assertions 1, 2 and 4 all still pass while the system quietly acquires an
# unbounded outbound-call loop.
#
# Everything is asserted against the durable journal. No customer data: three
# synthetic workers, w1/w2/w3.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="$repo/zig-out/bin/neuron"
[ -x "$binary" ] || { echo "FAIL: build first (zig build)"; exit 1; }

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-ladder.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

export HOME="$gate_root"
cd "$gate_root"          # isolate cwd too — ledger.zig discovers <cwd>/.claude first

node="$gate_root/node"
state="$node/state"
log="$state/substrate.log"
pkg="$gate_root/pkg"

# --- journal facts ---------------------------------------------------------
# Messages this worker actually received on the external boundary.
sent_to() {
    python3 - "$log" "$1" <<'PY'
import json, sys
n = 0
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    n += sum(1 for m in rec.get("messages", [])
             if m["to"] == "outbox/staffing/%s" % sys.argv[2])
print(n)
PY
}

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

# --- the package -----------------------------------------------------------
mkdir -p "$pkg/neurons"

# Admission now requires a declaration (see skill-doc-gate.sh). The acceptance
# names a per-worker boundary address, which only the real fan-out produces.
cat > "$pkg/SKILL.md" <<'DOC'
---
name: gate/staffing-ladder
description: Walks a worker through notify, follow-up and a terminal call, branching on whether a reply arrived. Fires on a roster stimulus and on each due event.
probe_input: roster w1,w2,w3
expect_contains: outbox/staffing/w3
---

# gate/staffing-ladder

Fixture limb for `escalation-ladder-gate.sh`. Three neurons, one per edge of the
graph: `notify` opens the ladder, `confirm` closes it for one worker, `escalate`
advances everyone the ladder is still waiting on and refuses to advance past the
terminal rung.
DOC

cat > "$pkg/neuron.json" <<'JSON'
{
  "schema": "typed-neuron.limb-manifest/v1",
  "package": "gate/staffing-ladder",
  "version": "0.1.0",
  "description": "Notify, reply-or-timeout, follow-up, terminal call.",
  "neurons": [
    {
      "id": "notify",
      "argv": ["python3", "neurons/notify.py"],
      "caps_request": {
        "allow_write": true, "write_prefix": "artifact/staffing/",
        "allow_send": true, "send_prefix": "outbox/staffing/",
        "budget": {"max_effects": 12, "max_writes": 4, "max_messages": 4, "max_bytes": 65536}
      }
    },
    {
      "id": "confirm",
      "argv": ["python3", "neurons/confirm.py"],
      "caps_request": {
        "allow_write": true, "write_prefix": "artifact/staffing/",
        "allow_send": false,
        "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 0, "max_bytes": 65536}
      }
    },
    {
      "id": "escalate",
      "argv": ["python3", "neurons/escalate.py"],
      "caps_request": {
        "allow_write": true, "write_prefix": "artifact/staffing/",
        "allow_send": true, "send_prefix": "outbox/staffing/",
        "budget": {"max_effects": 12, "max_writes": 4, "max_messages": 4, "max_bytes": 65536}
      }
    }
  ],
  "budgets": {"deadline_ms_per_firing": 30000}
}
JSON

cat > "$pkg/neurons/notify.py" <<'PY'
#!/usr/bin/env python3
# Rung 1: one individually addressed message per worker on the roster.
import json, sys

stim = json.load(sys.stdin)
roster = None
for ref in stim.get("reads", []):
    if ref["id"] == "artifact/staffing/roster":
        roster = ref["bytes"]
if roster is None:
    json.dump({"schema": "neuron.rejection/v1", "failure": "dependency",
               "detail": "roster not staged"}, sys.stdout)
    sys.exit(0)

effects = []
for w in [x for x in roster.split(",") if x]:
    effects.append({"kind": "send", "message": {
        "to": "outbox/staffing/%s" % w,
        "schema": "gate.shift-notice/v1",
        "payload": json.dumps({"worker": w, "rung": 1, "start": "0700"}),
        "durable": True}})
    effects.append({"kind": "write", "artifact": {
        "id": "artifact/staffing/rung/%s" % w,
        "schema": "gate.rung/v1", "bytes": "1"}})

json.dump({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "notified"},
    "effects": effects,
    "evidence": [{"claim": "every worker on the pinned roster was notified once",
                  "method": "gate fixture", "sources": ["artifact/staffing/roster"]}],
}, sys.stdout)
PY

cat > "$pkg/neurons/confirm.py" <<'PY'
#!/usr/bin/env python3
# A reply closes the ladder for exactly one worker.
import json, sys

stim = json.load(sys.stdin)
body = json.loads(stim["messages"][0]["payload"])
w = body["worker"]
json.dump({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "confirmed"},
    "effects": [{"kind": "write", "artifact": {
        "id": "artifact/staffing/confirmed/%s" % w,
        "schema": "gate.confirmed/v1", "bytes": "yes"}}],
    "evidence": [{"claim": "worker %s confirmed by reply" % w,
                  "method": "gate fixture", "sources": ["stimulus"]}],
}, sys.stdout)
PY

cat > "$pkg/neurons/escalate.py" <<'PY'
#!/usr/bin/env python3
# The due event. Decides ENTIRELY from pinned durable state: who is on the
# roster, who has confirmed, which rung each is on. The stimulus never says
# whom to skip or advance — if it did, this would be testing the driver.
#
# TERMINAL is the load-bearing constant. Rung 3 is the call, and the ladder
# does not advance past it. Each rung is a real outbound effect, so an
# unbounded ladder is an unbounded phone bill.
import json, sys

TERMINAL = 3
RUNG_NAME = {2: "follow-up", 3: "call"}

stim = json.load(sys.stdin)
roster, confirmed, rung, pin = None, set(), {}, {}
for ref in stim.get("reads", []):
    rid = ref["id"]
    if rid == "artifact/staffing/roster":
        roster = ref["bytes"]
    elif rid.startswith("artifact/staffing/confirmed/"):
        confirmed.add(rid.rsplit("/", 1)[1])
    elif rid.startswith("artifact/staffing/rung/"):
        w = rid.rsplit("/", 1)[1]
        rung[w] = int(ref["bytes"])
        # Advancing a rung is a compare-and-swap, not a blind overwrite. Two due
        # events firing on the same worker must not both advance it — that would
        # be two phone calls for one silence. The substrate refuses the second
        # with error.Conflict, and it is right to.
        pin[w] = ref["digest"]

if roster is None:
    json.dump({"schema": "neuron.rejection/v1", "failure": "dependency",
               "detail": "roster not staged"}, sys.stdout)
    sys.exit(0)

effects = []
for w in [x for x in roster.split(",") if x]:
    if w in confirmed:
        continue                      # replied — the ladder is closed for them
    current = rung.get(w, 1)
    if current >= TERMINAL:
        continue                      # already called; there is no rung after
    nxt = current + 1
    effects.append({"kind": "send", "message": {
        "to": "outbox/staffing/%s" % w,
        "schema": "gate.shift-notice/v1",
        "payload": json.dumps({"worker": w, "rung": nxt,
                               "via": RUNG_NAME.get(nxt, "call")}),
        "durable": True}})
    art = {"id": "artifact/staffing/rung/%s" % w,
           "schema": "gate.rung/v1", "bytes": str(nxt)}
    if w in pin:
        art["expected_prior"] = pin[w]
    effects.append({"kind": "write", "artifact": art})

json.dump({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "escalated" if effects else "settled"},
    "effects": effects,
    "evidence": [{"claim": "advanced only unconfirmed workers below the terminal rung",
                  "method": "gate fixture", "sources": ["artifact/staffing/roster"]}],
}, sys.stdout)
PY

# --- admit -----------------------------------------------------------------
"$binary" agent init "$node" ladder >/dev/null
"$binary" limb admit "$pkg" "$state" >/dev/null || fail "the ladder package was refused admission"

ROSTER="w1,w2,w3"

# Stage the roster as a pinned read, plus whatever durable state exists now.
# The driver stages FACTS; the neuron makes the decision.
build_stimulus() {   # build_stimulus <firing-suffix> [worker-with-reply]
    python3 - "$log" "$1" "$ROSTER" "${2:-}" <<'PY'
import json, sys
log, suffix, roster, reply = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

live = {}
try:
    for line in open(log):
        rec = json.loads(line)
        if rec.get("op") != "commit":
            continue
        for a in rec.get("artifacts", []):
            live[a["id"]] = bytes.fromhex(a["bytes"]).decode("utf-8", "replace")
except FileNotFoundError:
    pass

# A read is pinned BY DIGEST — a placeholder is refused at stageStimulus, which
# is the substrate declining to let a firing cite bytes it cannot identify.
import hashlib
def pin(rid, schema, val):
    return {"id": rid, "schema": schema,
            "digest": hashlib.sha256(val.encode()).hexdigest(), "bytes": val}

reads = [pin("artifact/staffing/roster", "gate.roster/v1", roster)]
for rid, val in sorted(live.items()):
    if rid.startswith("artifact/staffing/rung/") or rid.startswith("artifact/staffing/confirmed/"):
        reads.append(pin(rid, "gate.state/v1", val))

stim = {"schema": "neuron.stimulus/v1", "firing_id": "ladder/%s" % suffix,
        "receptor_schema": "gate.due/v1", "reads": reads,
        "permitted_reads": [r["id"] for r in reads], "messages": []}
if reply:
    stim["messages"] = [{"to": "neuron/confirm", "schema": "gate.reply/v1",
                         "from": "worker/%s" % reply, "correlation": "c-%s" % reply,
                         "payload": json.dumps({"worker": reply})}]
json.dump(stim, sys.stdout)
PY
}

run() {  # run <neuron> <firing-suffix> [reply-worker]
    build_stimulus "$2" "${3:-}" > "$gate_root/s.json"
    # A capability or budget refusal is CORRECT behaviour that prints a Zig
    # stack trace, so surface the error name rather than the trace — reading
    # the trace first is how this repo has lost time before.
    if ! "$binary" limb run "$state" --package "$pkg" --neuron "$1" \
            --stimulus "$gate_root/s.json" >/dev/null 2>"$gate_root/err.txt"; then
        echo "--- refusal from '$1/$2' ---" >&2
        grep -oE "error\.[A-Za-z]+|error: .*" "$gate_root/err.txt" | head -3 >&2
        fail "firing '$1/$2' was rejected"
    fi
}

# --- 1. fan-out is per worker ---------------------------------------------
run notify n1
for w in w1 w2 w3; do
    [ "$(sent_to $w)" = "1" ] || fail "after notify, $w received $(sent_to $w) messages, expected exactly 1"
done
echo "  notify: one individually addressed message per worker"

# --- 2. a confirmed worker is never messaged again -------------------------
run confirm c1 w1
run escalate e1
[ "$(sent_to w1)" = "1" ] || fail "w1 confirmed but was messaged again ($(sent_to w1) total) — this is the 31-of-35 defect"
[ "$(sent_to w2)" = "2" ] || fail "w2 did not receive a follow-up (got $(sent_to w2))"
[ "$(sent_to w3)" = "2" ] || fail "w3 did not receive a follow-up (got $(sent_to w3))"
echo "  confirmed worker skipped from durable state; the silent two advanced"

# --- 3. the ladder terminates ---------------------------------------------
run confirm c2 w2
run escalate e2
[ "$(artifact_bytes artifact/staffing/rung/w3)" = "3" ] || fail "w3 did not reach the terminal rung"
[ "$(sent_to w3)" = "3" ] || fail "w3 did not receive the terminal call (got $(sent_to w3))"

before_w1=$(sent_to w1); before_w2=$(sent_to w2); before_w3=$(sent_to w3)
run escalate e3          # drive it again with nothing left to do
[ "$(sent_to w3)" = "$before_w3" ] || fail "the ladder advanced PAST the terminal rung: w3 went $before_w3 -> $(sent_to w3). Every rung is a real call."
[ "$(sent_to w1)" = "$before_w1" ] || fail "w1 messaged again on a settled ladder"
[ "$(sent_to w2)" = "$before_w2" ] || fail "w2 messaged again on a settled ladder"
echo "  terminal rung halts: a further due event puts nothing on the boundary"

# --- 4. exact per-worker counts -------------------------------------------
[ "$(sent_to w1)" = "1" ] || fail "w1 final count $(sent_to w1), expected 1"
[ "$(sent_to w2)" = "2" ] || fail "w2 final count $(sent_to w2), expected 2"
[ "$(sent_to w3)" = "3" ] || fail "w3 final count $(sent_to w3), expected 3"
echo "  final ladder: w1=1 (replied), w2=2 (replied after follow-up), w3=3 (called)"

echo "escalation-ladder gate: PASS"
