#!/usr/bin/env bash
# Runnable witness for the two verbs VISION.md says are the whole simplification:
# `claim.register` and `claim.observe` — a claim that carries its own refutation
# condition and a deadline.
#
# The seed, not the tree. Three neurons and one rule that must never bend.
#
# WHAT THE PROPOSAL GOT WRONG, and this fixes:
#
#   expected_by: "2026-07-30T22:00:00Z"
#
# A wall clock cannot be the deadline here. `now_ms` is inside the firing
# identity (CLAUDE.md), so a timestamp in a stimulus makes every redelivery a
# new identity and turns idempotent replay into FiringMismatch. The deadline is
# a COMMIT ORDINAL — the same reason the bridge carries an ordinal and not a
# clock. Assertion 5 is what holds that line: settling the same ordinal twice
# must change nothing.
#
# Five assertions:
#
#   1. AN UNFALSIFIABLE CLAIM IS REFUSED. A claim with no refutation condition
#      states nothing that could turn out to be false. `CapabilityGap.parse`
#      refuses an acceptance-free gap; admission refuses an acceptance-free
#      package; this refuses an acceptance-free claim. Same rule, third surface.
#
#   2. EVIDENCE BEFORE THE DEADLINE CONFIRMS, AND FIRES NOTHING. A confirmed
#      claim must not trigger its contradiction dependent. This is the ordinary
#      case and it must stay quiet.
#
#   3. THE DEADLINE PASSING WITH NO EVIDENCE CONTRADICTS. This is the whole
#      point: absence of evidence, at a declared ordinal, is itself an event.
#
#   4. A DEPENDENT THAT ALREADY CROSSED A BOUNDARY IS COMPENSATED, NEVER
#      RE-FIRED. The proposal's `on_contradiction: INVALIDATE_AND_PROPAGATE` has
#      no such case, which is exactly how re-deriving "notify 35 workers"
#      re-messages the 31 who did not change. A contradiction routes THROUGH
#      redrive's three cases, not around them.
#
#   5. SETTLING IS IDEMPOTENT. Driving the same ordinal twice must not
#      contradict twice, or one silence becomes two phone calls.
#
# Assertion 4 is the falsifier. Remove the crossed-check and 1, 2, 3 and 5 all
# still pass while the system re-crosses a boundary it already crossed.
#
# Synthetic only. No customer data.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="$repo/zig-out/bin/neuron"
[ -x "$binary" ] || { echo "FAIL: build first (zig build)"; exit 1; }

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-claim.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

export HOME="$gate_root"
cd "$gate_root"

node=""; state=""; log=""
pkg="$gate_root/pkg"

scenario() {
    node="$gate_root/$1"; state="$node/state"; log="$state/substrate.log"
    "$binary" agent init "$node" claims >/dev/null
    "$binary" limb admit "$pkg" "$state" >/dev/null || fail "admission failed in scenario $1"
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

sent_to() {
    python3 - "$log" "$1" <<'PY'
import json, sys
n = 0
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    n += sum(1 for m in rec.get("messages", []) if m["to"] == sys.argv[2])
print(n)
PY
}

mkdir -p "$pkg/neurons"

cat > "$pkg/SKILL.md" <<'DOC'
---
name: gate/claim-deadline
description: Registers a claim with a refutation condition and an ordinal deadline, confirms it on evidence, and contradicts it when the deadline passes unmet. Fires on register, observe and settle events.
probe_input: register c1 expect_by=2
expect_contains: "refuted_by": "no reply by shift", "state": "contradicted"
---

# gate/claim-deadline

The seed for `aiko.claim.register` / `aiko.claim.observe`. The deadline is a
COMMIT ORDINAL, never a wall clock: `now_ms` sits inside the firing identity, so
a timestamp would make each redelivery a new identity and break idempotent
replay. Contradiction routes through redrive's cases — a dependent that already
crossed a boundary is compensated, never re-fired.
DOC

cat > "$pkg/neuron.json" <<'JSON'
{
  "schema": "typed-neuron.limb-manifest/v1",
  "package": "gate/claim-deadline",
  "version": "0.1.0",
  "description": "Claim with a refutation condition and an ordinal deadline.",
  "neurons": [
    { "id": "register", "argv": ["python3", "neurons/register.py"],
      "caps_request": { "allow_write": true, "write_prefix": "artifact/claims/",
        "allow_send": false,
        "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 0, "max_bytes": 65536} } },
    { "id": "observe", "argv": ["python3", "neurons/observe.py"],
      "caps_request": { "allow_write": true, "write_prefix": "artifact/claims/",
        "allow_send": false,
        "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 0, "max_bytes": 65536} } },
    { "id": "settle", "argv": ["python3", "neurons/settle.py"],
      "caps_request": { "allow_write": true, "write_prefix": "artifact/claims/",
        "allow_send": true, "send_prefix": "outbox/claims/",
        "budget": {"max_effects": 12, "max_writes": 4, "max_messages": 4, "max_bytes": 65536} } }
  ],
  "budgets": {"deadline_ms_per_firing": 30000}
}
JSON

cat > "$pkg/neurons/register.py" <<'PY'
#!/usr/bin/env python3
# claim.register — a claim must declare what would REFUTE it.
import json, sys

stim = json.load(sys.stdin)
body = json.loads(stim["messages"][0]["payload"])

# The same refusal `CapabilityGap.parse` applies to a gap and admission applies
# to a package: without a refutation condition nothing about this claim could
# ever turn out to be false, so "it holds" degrades to "nobody checked".
if not body.get("refuted_by"):
    json.dump({"schema": "neuron.rejection/v1", "failure": "policy",
               "detail": "claim %s declares no refutation condition" % body.get("id")},
              sys.stdout)
    sys.exit(0)

claim = {
    "id": body["id"],
    "statement": body["statement"],
    "refuted_by": body["refuted_by"],
    # An ORDINAL, not a clock. See SKILL.md.
    "expect_by": int(body["expect_by"]),
    "dependent": body.get("dependent", ""),
    # Whether the dependent has ALREADY crossed an external boundary. This is
    # the field assertion 4 rests on; dropping it silently turns every
    # compensation back into a re-fire.
    "crossed": bool(body.get("crossed", False)),
    "state": "pending",
}
json.dump({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "registered"},
    "effects": [{"kind": "write", "artifact": {
        "id": "artifact/claims/%s" % body["id"],
        "schema": "gate.claim/v1",
        "bytes": json.dumps(claim, sort_keys=True)}}],
    "evidence": [{"claim": "claim registered with a declared refutation condition",
                  "method": "gate fixture", "sources": ["stimulus"]}],
}, sys.stdout)
PY

cat > "$pkg/neurons/observe.py" <<'PY'
#!/usr/bin/env python3
# claim.observe — evidence arrives; the claim is confirmed.
import json, sys

stim = json.load(sys.stdin)
body = json.loads(stim["messages"][0]["payload"])
cid = body["claim_id"]

prior, pin = None, None
for ref in stim.get("reads", []):
    if ref["id"] == "artifact/claims/%s" % cid:
        prior, pin = json.loads(ref["bytes"]), ref["digest"]
if prior is None:
    json.dump({"schema": "neuron.rejection/v1", "failure": "dependency",
               "detail": "claim %s not staged" % cid}, sys.stdout)
    sys.exit(0)

# A CONTRADICTION CANNOT BE UN-SAID. By the time a claim is contradicted its
# dependent has fired — in the staffing case, the phone call was made. Flipping
# the state back to "confirmed" on a late reply would leave the ledger asserting
# the claim held, with no record that a boundary was crossed, which is the one
# thing this system exists to refuse. The evidence is real and is recorded; the
# contradiction stands beside it.
if prior["state"] == "contradicted":
    prior["late_evidence"] = body["observation"]
else:
    prior["state"] = "confirmed"
    prior["evidence"] = body["observation"]
json.dump({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "confirmed"},
    "effects": [{"kind": "write", "artifact": {
        "id": "artifact/claims/%s" % cid, "schema": "gate.claim/v1",
        "bytes": json.dumps(prior, sort_keys=True), "expected_prior": pin}}],
    "evidence": [{"claim": "claim %s confirmed by observed evidence" % cid,
                  "method": "gate fixture", "sources": ["stimulus"]}],
}, sys.stdout)
PY

cat > "$pkg/neurons/settle.py" <<'PY'
#!/usr/bin/env python3
# The due event. Absence of evidence at a declared ordinal is itself an event.
#
# Decides entirely from pinned durable state plus the ordinal on the stimulus.
# No clock: `now_ms` is inside the firing identity, so a timestamp here would
# make each redelivery a new identity and break idempotent replay.
import json, sys

stim = json.load(sys.stdin)
now = int(json.loads(stim["messages"][0]["payload"])["ordinal"])

effects = []
for ref in stim.get("reads", []):
    if not ref["id"].startswith("artifact/claims/"):
        continue
    c = json.loads(ref["bytes"])
    if c["state"] != "pending":
        continue                      # confirmed or already contradicted
    if now < c["expect_by"]:
        continue                      # not due yet

    c["state"] = "contradicted"
    effects.append({"kind": "write", "artifact": {
        "id": ref["id"], "schema": "gate.claim/v1",
        "bytes": json.dumps(c, sort_keys=True), "expected_prior": ref["digest"]}})

    # THE BOUND. A dependent that already crossed an external boundary is
    # COMPENSATED, never re-fired. Re-deriving "notify 35 workers" re-messages
    # the 31 who did not change; the proposal's INVALIDATE_AND_PROPAGATE has no
    # such case. Compensation is a durable record for a human, not a send.
    if c.get("crossed"):
        effects.append({"kind": "write", "artifact": {
            "id": "artifact/claims/compensation/%s" % c["id"],
            "schema": "gate.compensation/v1",
            "bytes": json.dumps({"claim": c["id"], "reason": c["refuted_by"],
                                 "note": "dependent already crossed; not re-fired"},
                                sort_keys=True)}})
    elif c.get("dependent"):
        effects.append({"kind": "send", "message": {
            "to": "outbox/claims/%s" % c["dependent"],
            "schema": "gate.contradiction/v1",
            "payload": json.dumps({"claim": c["id"], "reason": c["refuted_by"]},
                                  sort_keys=True),
            "durable": True}})

json.dump({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "settled" if effects else "quiet"},
    "effects": effects,
    "evidence": [{"claim": "contradicted every pending claim past its ordinal deadline",
                  "method": "gate fixture", "sources": ["stimulus"]}],
}, sys.stdout)
PY

"$binary" limb admit "$pkg" "$gate_root/probe" >/dev/null 2>&1 || true

fire() {   # fire <neuron> <suffix> <payload-json> [stage-claims]
    python3 - "$log" "$2" "$3" "${4:-no}" > "$gate_root/s.json" <<'PY'
import hashlib, json, sys
log, suffix, payload, stage = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
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
reads = []
if stage == "yes":
    for rid, val in sorted(live.items()):
        if rid.startswith("artifact/claims/") and "/compensation/" not in rid:
            reads.append({"id": rid, "schema": "gate.claim/v1",
                          "digest": hashlib.sha256(val.encode()).hexdigest(),
                          "bytes": val})
json.dump({"schema": "neuron.stimulus/v1", "firing_id": "claim/%s" % suffix,
           "receptor_schema": "gate.claim-event/v1", "reads": reads,
           "permitted_reads": [r["id"] for r in reads],
           "messages": [{"to": "neuron/claims", "schema": "gate.claim-event/v1",
                         "from": "driver", "correlation": suffix,
                         "payload": payload}]}, sys.stdout)
PY
    set +e
    "$binary" limb run "$state" --package "$pkg" --neuron "$1" \
        --stimulus "$gate_root/s.json" >/dev/null 2>"$gate_root/err.txt"
    FIRE_RC=$?
    set -e
}
fire_ok()      { fire "$@"; [ "$FIRE_RC" = "0" ] || { grep -oE "error\.[A-Za-z]+" "$gate_root/err.txt" | head -2 >&2; fail "firing '$1/$2' should have succeeded"; }; }
# A DECLARED refusal and a CRASHED script both exit non-zero, and conflating
# them makes this assertion worthless: deleting the refusal check entirely still
# "passed", because the neuron then died on a KeyError instead. The substrate
# separates them — `error.ScriptFailed` is a neuron that refused (script.zig
# rejectionError), `error.ScriptCrashed` is one that fell over — so require the
# former by name.
fire_refused() {
    fire "$@"
    [ "$FIRE_RC" != "0" ] || fail "firing '$1/$2' SUCCEEDED where a refusal was required"
    grep -q "error.ScriptFailed" "$gate_root/err.txt" \
        || fail "firing '$1/$2' failed, but as $(grep -oE 'error\.[A-Za-z]+' "$gate_root/err.txt" | head -1) rather than a declared refusal — a crash is not a refusal"
}

# --- 1. an unfalsifiable claim is refused ---------------------------------
scenario A
fire_refused register r0 '{"id":"c0","statement":"something will happen","expect_by":2}'
[ -z "$(artifact_bytes artifact/claims/c0)" ] \
    || fail "a claim declaring no refutation condition was registered anyway"
echo "  1. a claim with no refutation condition is refused"

# --- 2. evidence before the deadline confirms, and fires nothing -----------
fire_ok register r1 '{"id":"c1","statement":"w1 attends","refuted_by":"no reply","expect_by":2,"dependent":"reassign"}'
fire_ok observe o1 '{"claim_id":"c1","observation":"w1 replied OK"}' yes
case "$(artifact_bytes artifact/claims/c1)" in
    *'"state": "confirmed"'*) : ;;
    *) fail "evidence did not confirm the claim: $(artifact_bytes artifact/claims/c1)" ;;
esac
fire_ok settle s1 '{"ordinal":9}' yes
[ "$(sent_to outbox/claims/reassign)" = "0" ] \
    || fail "a CONFIRMED claim fired its contradiction dependent"
echo "  2. evidence before the deadline confirms, and the dependent stays quiet"

# --- 3. the deadline passing with no evidence contradicts ------------------
scenario B
fire_ok register r2 '{"id":"c2","statement":"w2 attends","refuted_by":"no reply by shift","expect_by":2,"dependent":"reassign"}'
fire_ok settle s2 '{"ordinal":1}' yes
case "$(artifact_bytes artifact/claims/c2)" in
    *'"state": "pending"'*) : ;;
    *) fail "a claim was settled BEFORE its deadline ordinal" ;;
esac
fire_ok settle s3 '{"ordinal":2}' yes
case "$(artifact_bytes artifact/claims/c2)" in
    *'"state": "contradicted"'*) : ;;
    *) fail "the deadline passed with no evidence and the claim did not contradict" ;;
esac
[ "$(sent_to outbox/claims/reassign)" = "1" ] \
    || fail "the contradiction did not fire its dependent (got $(sent_to outbox/claims/reassign))"
echo "  3. the deadline passing unmet contradicts, and fires the dependent once"

# --- 4. THE BOUND: an already-crossed dependent is compensated -------------
scenario C
fire_ok register r3 '{"id":"c3","statement":"w3 attends","refuted_by":"no reply","expect_by":2,"dependent":"reassign","crossed":true}'
fire_ok settle s4 '{"ordinal":5}' yes
[ -n "$(artifact_bytes artifact/claims/compensation/c3)" ] \
    || fail "a contradicted claim whose dependent already CROSSED produced no compensation record"
[ "$(sent_to outbox/claims/reassign)" = "0" ] \
    || fail "RE-CROSSED A BOUNDARY: the dependent had already crossed and was sent to again. This is the 31-of-35 defect, and INVALIDATE_AND_PROPAGATE has no case for it."
echo "  4. an already-crossed dependent is compensated, never re-fired"

# --- 5. settling is idempotent --------------------------------------------
scenario D
fire_ok register r4 '{"id":"c4","statement":"w4 attends","refuted_by":"no reply","expect_by":1,"dependent":"reassign"}'
fire_ok settle s5 '{"ordinal":3}' yes
before="$(sent_to outbox/claims/reassign)"
fire_ok settle s6 '{"ordinal":3}' yes
[ "$(sent_to outbox/claims/reassign)" = "$before" ] \
    || fail "settling the SAME ordinal twice contradicted twice ($before -> $(sent_to outbox/claims/reassign)). One silence must not become two calls."
echo "  5. settling the same ordinal twice changes nothing"

# --- 6. the package's DECLARED acceptance is actually satisfied ------------
# skill-doc-gate proves a package must DECLARE an acceptance and that the
# declaration is inside the digest. Nothing proved the declaration is
# ACHIEVABLE. This fixture shipped with `expect_contains: "state":"contradicted"`
# while the limb emits `"state": "contradicted"` — json.dumps puts a space after
# the colon — so the correct implementation failed its own stated claim, and
# every assertion above still passed. That is the mirror of an acceptance a
# do-nothing handler satisfies, and it is just as worthless.
declared="$(sed -n 's/^expect_contains: //p' "$pkg/SKILL.md")"
[ -n "$declared" ] || fail "the fixture package declares no acceptance"
scenario E
fire_ok register r5 '{"id":"c2","statement":"w2 attends","refuted_by":"no reply by shift","expect_by":2,"dependent":"reassign"}'
fire_ok settle s7 '{"ordinal":4}' yes
case "$(artifact_bytes artifact/claims/c2)" in
    *"$declared"*) : ;;
    *) fail "the package's declared acceptance is NOT satisfied by its own correct output.
  declared: $declared
  produced: $(artifact_bytes artifact/claims/c2)" ;;
esac
echo "  6. the declared acceptance is satisfied by the real limb"

# --- 7. a contradiction cannot be un-said ---------------------------------
# The adversarial edge: the worker replies AFTER the escalation call went out.
# Recording that as a clean "confirmed" would erase the crossing from durable
# state, and a later reader — or a redrive pass — would see a claim that held
# and no evidence a call was ever made.
scenario F
fire_ok register r6 '{"id":"c5","statement":"w5 attends","refuted_by":"no reply","expect_by":1,"dependent":"reassign"}'
fire_ok settle s8 '{"ordinal":4}' yes
[ "$(sent_to outbox/claims/reassign)" = "1" ] || fail "setup: the dependent should have fired"
fire_ok observe o2 '{"claim_id":"c5","observation":"replied after the call"}' yes
final="$(artifact_bytes artifact/claims/c5)"
case "$final" in
    *'"state": "confirmed"'*) fail "LATE EVIDENCE ERASED THE CROSSING: a reply arriving after the escalation call flipped the claim to confirmed. The ledger now says it held, and nothing records that a boundary was crossed.
  $final" ;;
esac
case "$final" in
    *'"late_evidence"'*) : ;;
    *) fail "late evidence was discarded entirely rather than recorded: $final" ;;
esac
echo "  7. late evidence is recorded without un-saying the contradiction"

echo "claim-deadline gate: PASS"
