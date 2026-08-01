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

# Each scenario gets its OWN substrate. The survivor hunt showed why: a gate that
# tests one trajectory is blind to every conditional weakening that behaves the
# same on that trajectory. `if confirmed and current >= TERMINAL` was
# indistinguishable from the real check in the only state the gate ever entered.
node=""; state=""; log=""
pkg="$gate_root/pkg"

scenario() {   # scenario <name> — a fresh substrate, so state cannot leak between them
    node="$gate_root/$1"; state="$node/state"; log="$state/substrate.log"
    "$binary" agent init "$node" ladder >/dev/null
    "$binary" limb admit "$pkg" "$state" >/dev/null || fail "admission failed in scenario $1"
}

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

# Decoded payloads of the messages a worker actually received, in order. The
# journal hex-encodes a payload exactly as it does artifact bytes, so this
# decodes rather than reads: a raw compare would never match anything.
# survivor hunt found a mutation that pinned every rung's payload to
# {"rung": 3, "via": "call"} — every worker skipped the follow-up rung, and the
# gate could not see it because it only ever matched on the `to` address.
payloads_for() {
    python3 - "$log" "$1" <<'PY2'
import json, sys
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    for m in rec.get("messages", []):
        if m["to"] == "outbox/staffing/%s" % sys.argv[2]:
            print(bytes.fromhex(m["payload"]).decode("utf-8", "replace"))
PY2
}

# Every message must name the worker it was sent to. Kills a recipient rotation
# that keeps the per-worker COUNTS at 1/2/3 while sending each notice to the
# wrong person.
assert_addressed() {   # assert_addressed <worker>
    python3 - "$log" "$1" <<'PY2'
import json, sys
w = sys.argv[2]
bad = []
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    for m in rec.get("messages", []):
        if m["to"] == "outbox/staffing/%s" % w:
            body = json.loads(bytes.fromhex(m["payload"]).decode("utf-8", "replace"))
            if body.get("worker") != w:
                bad.append((w, body.get("worker")))
if bad:
    print("FAIL: message addressed to %s names worker %s — recipient and content disagree" % bad[0])
    sys.exit(1)
PY2
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
# A mixed-case name is deliberate: it kills a `.lower()` in confirm.py, which
# otherwise silently fails to match and re-messages a worker who did reply.
ROSTER="w1,W2,w3"

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

# ===========================================================================
# A. MIXED — one replies at once, one after the follow-up, one never.
# ===========================================================================
scenario A
run notify n1
for w in w1 W2 w3; do
    [ "$(sent_to $w)" = "1" ] || fail "after notify, $w received $(sent_to $w) messages, expected exactly 1"
    assert_addressed "$w" || exit 1
done
echo "  A. notify: one message per worker, each naming its own recipient"

run confirm c1 w1
run escalate e1
[ "$(sent_to w1)" = "1" ] || fail "w1 confirmed but was messaged again ($(sent_to w1)) — the 31-of-35 defect"
[ "$(sent_to W2)" = "2" ] || fail "W2 did not receive a follow-up (got $(sent_to W2))"
[ "$(sent_to w3)" = "2" ] || fail "w3 did not receive a follow-up (got $(sent_to w3))"

# The rungs must be DISTINCT. A mutation that labelled every message rung 3
# ("call") kept these counts at 1/2/3 while skipping the follow-up for everyone.
p2="$(payloads_for w3 | sed -n 2p)"
case "$p2" in *follow-up*) : ;; *) fail "w3's second message is not a follow-up rung: $p2" ;; esac
echo "  A. confirmed worker skipped; the silent two advanced to a real follow-up"

run confirm c2 W2
run escalate e2
[ "$(artifact_bytes artifact/staffing/rung/w3)" = "3" ] || fail "w3 did not reach the terminal rung"
p3="$(payloads_for w3 | sed -n 3p)"
case "$p3" in *call*) : ;; *) fail "w3's third message is not the terminal call: $p3" ;; esac

b1=$(sent_to w1); b2=$(sent_to W2); b3=$(sent_to w3)
run escalate e3
[ "$(sent_to w3)" = "$b3" ] || fail "advanced PAST terminal: w3 went $b3 -> $(sent_to w3)"
[ "$(sent_to w1)" = "$b1" ] || fail "w1 messaged again on a settled ladder"
[ "$(sent_to W2)" = "$b2" ] || fail "W2 messaged again on a settled ladder"
[ "$(sent_to w1)" = "1" ] && [ "$(sent_to W2)" = "2" ] && [ "$(sent_to w3)" = "3" ] \
    || fail "final counts wrong: w1=$(sent_to w1) W2=$(sent_to W2) w3=$(sent_to w3), expected 1/2/3"
echo "  A. final ladder 1/2/3, distinct rungs, halts"

# ===========================================================================
# B. NOBODY REPLIES — the production case, and the state the gate never
#    entered before. `if confirmed and current >= TERMINAL` is identical to the
#    real check whenever ANYONE has replied; only here does it diverge, and
#    here it escalates every silent worker forever. Each rung is a real call.
# ===========================================================================
scenario B
run notify b1
for i in 1 2 3 4; do run escalate "b-due-$i"; done
for w in w1 W2 w3; do
    n="$(sent_to $w)"
    [ "$n" = "3" ] || fail "SILENT SHIFT: $w received $n messages across four due events, expected exactly 3. The ladder does not terminate when nobody replies."
    [ "$(artifact_bytes artifact/staffing/rung/$w)" = "3" ] \
        || fail "$w rung is $(artifact_bytes artifact/staffing/rung/$w), expected 3"
done
echo "  B. nobody replies: every worker stops at exactly 3, four due events later"

# ===========================================================================
# C. A LATE JOINER — added to the roster after the others have been called.
#    Kills two survivors at once: a per-worker rung defaulted to TERMINAL
#    (the new worker is treated as already called and silently dropped), and a
#    roster-GLOBAL terminal check (everyone frozen once anyone reaches 3).
# ===========================================================================
scenario C
ROSTER="w1,W2"
run notify c-n1
for i in 1 2; do run escalate "c-due-$i"; done
[ "$(sent_to w1)" = "3" ] || fail "setup: w1 should be at the terminal rung"
ROSTER="w1,W2,late"          # the new worker has NO rung artifact yet
run escalate c-due-3
[ "$(sent_to late)" -ge "1" ] \
    || fail "LATE JOINER DROPPED: 'late' joined the roster and received $(sent_to late) messages. A worker with no rung artifact must be contacted, not treated as already called."
echo "  C. a worker who joins after the others were called is still contacted"

# ===========================================================================
# D. EVERYONE REPLIES — kills `len(confirmed) < len(crew) and w in confirmed`,
#    which skips confirmed workers only while at least one is still silent.
# ===========================================================================
scenario D
ROSTER="w1,W2,w3"
run notify d-n1
run confirm d-c1 w1
run confirm d-c2 W2
run confirm d-c3 w3
d1=$(sent_to w1); d2=$(sent_to W2); d3=$(sent_to w3)
run escalate d-due-1
[ "$(sent_to w1)" = "$d1" ] && [ "$(sent_to W2)" = "$d2" ] && [ "$(sent_to w3)" = "$d3" ] \
    || fail "ALL CONFIRMED yet the ladder messaged someone again: w1 $d1->$(sent_to w1), W2 $d2->$(sent_to W2), w3 $d3->$(sent_to w3)"
echo "  D. when everyone has replied, a due event puts nothing on the boundary"

echo "escalation-ladder gate: PASS"
