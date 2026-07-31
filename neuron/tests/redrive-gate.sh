#!/usr/bin/env bash
# Runnable witness for invalidation-driven re-derivation (ROADMAP R10),
# `neuron redrive`. From an empty directory, through the public CLI only.
#
# The staleness projection says which derivations rest on a source that moved.
# This gate proves what happens next, and that it is three different things:
#
#   1. `redrivable: true` under a determinism claim re-fires the producer
#      against the MOVED sources under a NEW firing id, producing a genuinely
#      different product, while the superseded firing stays in the journal
#      byte-for-byte as history;
#   2. `redrivable: false`, or a producer that cannot claim determinism, opens
#      an AGENT — manifest, snapshot 0000, active pointer, plus a goal naming
#      the stale derivation — and re-fires nothing;
#   3. a firing that already sent to `outbox/` produces a typed
#      `neuron.compensation-gap/v1` and MUST NEVER CROSS THE BOUNDARY TWICE.
#
# Assertion 3 is the reason the feature exists and the assertion that must
# never regress: re-firing "notify 35 workers" after an amendment re-messages
# the 31 who did not change and still fails to tell the 4 who did. The gate
# counts outbox messages in the durable journal before and after, and counts
# the files the boundary actually wrote on disk.
#
# Every assertion inspects durable state — the journal, the substrate, or the
# filesystem the boundary writes into — never stdout resemblance.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-redrive.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT
binary="$repo_dir/zig-out/bin/neuron"

fail() { echo "FAIL: $*" >&2; exit 1; }

node="$gate_root/node"
state="$node/state"
log="$state/substrate.log"

# Journal facts, read straight off the WAL.
outbox_sends() {
    python3 - "$log" <<'PY'
import json, sys
n = 0
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    n += sum(1 for m in rec.get("messages", []) if m["to"].startswith("outbox/"))
print(n)
PY
}

firing_ids() {
    python3 - "$log" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get("op") == "commit":
        print(rec["firing_id"])
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
    for a in rec["artifacts"]:
        if a["id"] == sys.argv[2]:
            found = a["bytes"]
sys.stdout.write("" if found is None else bytes.fromhex(found).decode("utf-8", "replace"))
PY
}

# ---------------------------------------------------------------------------
# 0. A limb that crosses an external boundary, and one that only derives.
#
# The agent stage network cannot, on its own, produce a stale derivation whose
# producer sent to `outbox/`, so case 3 is built where the caps are explicit:
# a limb package declares `send_prefix: outbox/` and cites the roster it read.
# ---------------------------------------------------------------------------
pkg="$gate_root/pkg"
mkdir -p "$pkg/neurons"
cat > "$pkg/neuron.json" <<'JSON'
{
  "schema": "typed-neuron.limb-manifest/v1",
  "package": "gate/roster",
  "version": "0.1.0",
  "description": "Roster publication and worker notification, for the redrive gate.",
  "neurons": [
    {
      "id": "publish",
      "argv": ["python3", "neurons/publish.py"],
      "caps_request": {
        "allow_write": true,
        "write_prefix": "artifact/roster/",
        "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 0, "max_bytes": 65536}
      }
    },
    {
      "id": "notify",
      "argv": ["python3", "neurons/notify.py"],
      "caps_request": {
        "allow_write": true,
        "write_prefix": "artifact/notice/",
        "allow_send": true,
        "send_prefix": "outbox/",
        "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 2, "max_bytes": 65536}
      }
    }
  ],
  "budgets": {"deadline_ms_per_firing": 30000}
}
JSON

# The publisher writes the roster. The content and any CAS pin arrive on the
# stimulus message, so the same pinned package produces every version.
cat > "$pkg/neurons/publish.py" <<'PY'
#!/usr/bin/env python3
import json, sys

stim = json.load(sys.stdin)
body = json.loads(stim["messages"][0]["payload"])
artifact = {"id": "artifact/roster/workers", "schema": "gate.roster/v1", "bytes": body["roster"]}
if body.get("expected_prior"):
    artifact["expected_prior"] = body["expected_prior"]
json.dump({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "published"},
    "effects": [{"kind": "write", "artifact": artifact}],
    "evidence": [{
        "claim": "roster published from the operator's stimulus",
        "method": "gate fixture",
        "sources": ["stimulus"],
    }],
}, sys.stdout)
PY

# The notifier derives a notice FROM the roster and tells the world about it.
# Its evidence cites the roster, which is what puts it in the derivation graph;
# its send crosses `outbox/`, which is what disqualifies it from re-derivation.
cat > "$pkg/neurons/notify.py" <<'PY'
#!/usr/bin/env python3
import hashlib, json, sys

stim = json.load(sys.stdin)
roster = None
for ref in stim["reads"]:
    if ref["id"] == "artifact/roster/workers":
        roster = ref["bytes"]
if roster is None:
    json.dump({"schema": "neuron.rejection/v1", "failure": "dependency",
               "detail": "roster not staged"}, sys.stdout)
    sys.exit(0)
notice = "notified %d workers of roster %s" % (
    len(roster.split(",")), hashlib.sha256(roster.encode()).hexdigest()[:16])
json.dump({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "notified"},
    "effects": [
        {"kind": "write", "artifact": {
            "id": "artifact/notice/dispatch",
            "schema": "gate.notice/v1",
            "bytes": notice,
        }},
        {"kind": "send", "message": {
            "to": "outbox/notify/workers",
            "schema": "gate.notice/v1",
            "payload": notice,
            "durable": True,
        }},
    ],
    "evidence": [{
        "claim": "every worker on the pinned roster was notified",
        "method": "gate fixture",
        "sources": ["artifact/roster/workers"],
    }],
}, sys.stdout)
PY

stimulus() {  # firing_id, json body -> stimulus file on stdout
    python3 - "$1" "$2" <<'PY'
import json, sys
print(json.dumps({
    "schema": "neuron.stimulus/v1",
    "firing_id": sys.argv[1],
    "receptor_schema": "gate.roster-request/v1",
    "messages": [{"to": "neuron/publish", "schema": "gate.roster-request/v1",
                  "payload": sys.argv[2], "durable": True}],
}))
PY
}

notify_stimulus() {  # firing_id, roster bytes -> stimulus file on stdout
    python3 - "$1" "$2" <<'PY'
import hashlib, json, sys
roster = sys.argv[2]
print(json.dumps({
    "schema": "neuron.stimulus/v1",
    "firing_id": sys.argv[1],
    "receptor_schema": "gate.notify-request/v1",
    "permitted_reads": ["artifact/roster/workers"],
    "reads": [{"id": "artifact/roster/workers", "schema": "gate.roster/v1",
               "bytes": roster,
               "digest": hashlib.sha256(roster.encode()).hexdigest()}],
}))
PY
}

roster_v1='alice,bob,carol,dave'
roster_v2='alice,bob,carol,erin,frank'

"$binary" agent init "$node" alpha >/dev/null
"$binary" limb admit "$pkg" "$state" >/dev/null

stimulus roster/v1 "$(python3 -c 'import json,sys;print(json.dumps({"roster":sys.argv[1]}))' "$roster_v1")" \
    > "$gate_root/s1.json"
"$binary" limb run "$state" --package "$pkg" --neuron publish --stimulus "$gate_root/s1.json" >/dev/null

notify_stimulus notify/roster "$roster_v1" > "$gate_root/s2.json"
"$binary" limb run "$state" --package "$pkg" --neuron notify --stimulus "$gate_root/s2.json" >/dev/null

# The roster is amended: one worker leaves, two arrive. The notice that already
# went out now rests on a version of the roster that no longer exists.
prior="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' "$roster_v1")"
stimulus roster/v2 "$(python3 -c 'import json,sys;print(json.dumps({"roster":sys.argv[1],"expected_prior":sys.argv[2]}))' "$roster_v2" "$prior")" \
    > "$gate_root/s3.json"
"$binary" limb run "$state" --package "$pkg" --neuron publish --stimulus "$gate_root/s3.json" >/dev/null

# ---------------------------------------------------------------------------
# 1. Two agents whose goals go stale, and one deterministic boundary attached
#    only afterwards — so re-derivation has something new to derive.
# ---------------------------------------------------------------------------
cat > "$gate_root/upper.sh" <<'SH'
#!/usr/bin/env bash
tr '[:lower:]' '[:upper:]'
SH
chmod +x "$gate_root/upper.sh"

"$binary" agent init "$node" beta >/dev/null
for agent in alpha beta; do
    for goal in first second; do
        "$binary" agent run "$node" "$agent" --goal "$goal" --json >/dev/null
    done
done

"$binary" interface describe "$gate_root/upper.sh" --kind process --id proc/upper \
    --input-channel stdin --deterministic --output "$gate_root/upper.json" >/dev/null
"$binary" interface describe "$gate_root/upper.sh" --kind process --id proc/loose \
    --input-channel stdin --output "$gate_root/loose.json" >/dev/null
python3 - "$gate_root/upper.json" "$gate_root/loose.json" <<'PY'
import json, sys
assert json.load(open(sys.argv[1]))["invocation"]["deterministic"] is True
# The termination proof is a claim on the manifest, not an assumption: this
# one declines to make it, and redrive must refuse to auto-redrive it.
assert json.load(open(sys.argv[2]))["invocation"]["deterministic"] is False
PY
strict="$("$binary" interface admit "$node" "$gate_root/upper.json" --json |
    python3 -c 'import json,sys;print(json.load(sys.stdin)["interface"])')"
loose="$("$binary" interface admit "$node" "$gate_root/loose.json" --json |
    python3 -c 'import json,sys;print(json.load(sys.stdin)["interface"])')"
"$binary" interface attach "$node" alpha --interface "$strict" --role worker >/dev/null
"$binary" interface attach "$node" beta --interface "$loose" --role worker >/dev/null

# The projection must actually see all three shapes before redrive runs, or the
# gate would be asserting against an empty classification.
"$binary" telemetry stale "$state" --json > "$gate_root/stale.json"
python3 - "$gate_root/stale.json" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
notice = [r for r in rows if r["artifact"] == "artifact/notice/dispatch"]
goals = [r for r in rows if r["artifact"].startswith("agents/") and "/goals/" in r["artifact"]]
assert notice, "the boundary-crossing derivation never went stale: case 3 is untested"
assert notice[0]["redrivable"] is False, notice
assert notice[0]["stale_source"] == "artifact/roster/workers", notice
assert len(goals) >= 4, goals
assert all(r["redrivable"] for r in goals), goals
PY

# ---------------------------------------------------------------------------
# 2. `--dry-run` classifies and commits nothing.
# ---------------------------------------------------------------------------
wal_before="$(wc -c < "$log")"
sends_before="$(outbox_sends)"
firings_before="$(firing_ids | sort)"
journal_before="$gate_root/journal.before"
cp "$log" "$journal_before"

"$binary" redrive "$state" --dry-run --json > "$gate_root/dry.json"
[ "$(wc -c < "$log")" = "$wal_before" ] || fail "--dry-run committed to the journal"
python3 - "$gate_root/dry.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r["schema"] == "neuron.redrive/v1", r
assert r["dry_run"] is True and r["generation"] == 0, r
assert all(row["record"] == "" for row in r["rows"]), r
cases = {row["case"] for row in r["rows"]}
assert cases == {"redrive", "escalate", "compensate"}, cases
PY

# ---------------------------------------------------------------------------
# 3. The real pass: three cases, three durable outcomes.
# ---------------------------------------------------------------------------
"$binary" redrive "$state" --json > "$gate_root/pass1.json"
python3 - "$gate_root/pass1.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r["redriven"] >= 2 and r["escalated"] >= 2 and r["compensation_gaps"] == 1, r
assert all(row["record"] for row in r["rows"]), r
PY

# --- case 1: a new firing id, a new product, and history left alone ---------
python3 - "$gate_root/pass1.json" "$log" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
redriven = [row for row in report["rows"] if row["case"] == "redrive"]
assert redriven, report
committed = {}
for line in open(sys.argv[2]):
    rec = json.loads(line)
    if rec.get("op") == "commit":
        committed[rec["firing_id"]] = rec

for row in redriven:
    assert row["changed"], f"re-derivation produced nothing new: {row}"
    new = row["redriven_workflow"]
    old = row["produced_by"].rsplit("/", 1)[0]
    assert new != old, f"re-derivation reused the superseded firing identity: {row}"
    # The new derivation exists as its own firing, and the product came from
    # the boundary that was attached after the original run — so this is a real
    # re-derivation against moved inputs, not a replay of the old answer.
    assert f"{new}/intake" in committed, new
    output = None
    for rec in committed.values():
        for a in rec["artifacts"]:
            if a["id"] == f"agents/alpha/work/{new.rsplit('/', 1)[1]}/output":
                output = bytes.fromhex(a["bytes"]).decode()
    assert output and output.isupper(), (new, output)
    # The durable action record names both halves of the supersession.
    rec_id = row["record"]
    assert rec_id.startswith("artifact/redrive/actions/"), row
PY

# The superseded firings are untouched. The journal is append-only, so the
# bytes that were there before the pass must still be there, byte for byte.
python3 - "$journal_before" "$log" <<'PY'
import sys
before = open(sys.argv[1], "rb").read()
after = open(sys.argv[2], "rb").read()
assert after.startswith(before), "re-derivation rewrote committed history"
PY
firing_ids | sort > "$gate_root/firings.after"
comm -23 <(printf '%s\n' "$firings_before") "$gate_root/firings.after" | grep . &&
    fail "a firing that had settled disappeared from the journal"

# --- case 2: an agent, which is three writes plus a goal --------------------
python3 - "$gate_root/pass1.json" "$log" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
escalated = [row for row in report["rows"] if row["case"] == "escalate"]
assert escalated, report
artifacts = {}
firings = set()
for line in open(sys.argv[2]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    firings.add(rec["firing_id"])
    for a in rec["artifacts"]:
        artifacts[a["id"]] = bytes.fromhex(a["bytes"]).decode("utf-8", "replace")

for row in escalated:
    goal_id = row["record"]
    assert goal_id in artifacts, goal_id
    agent = goal_id.split("/")[1]
    # An agent is exactly three writes (initAgentCore) — no new machinery.
    for part in ("manifest", "snapshots/0000", "active"):
        assert f"agents/{agent}/{part}" in artifacts, (agent, part)
    assert artifacts[f"agents/{agent}/active"] == f"agents/{agent}/snapshots/0000"
    goal = json.loads(artifacts[goal_id])
    assert goal["schema"] == "neuron.agent-goal/v1", goal
    assert goal["artifact"] == row["artifact"], goal
    assert goal["stale_source"] == row["stale_source"], goal
    assert goal["produced_by"] == row["produced_by"], goal
    assert goal["reason"], goal
# Nothing on the non-deterministic agent was re-fired: escalation opens a task,
# it does not perform one.
beta_rows = [r for r in report["rows"] if r["produced_by"].startswith("agent/beta/")]
assert beta_rows, report
assert all(r["case"] == "escalate" for r in beta_rows), beta_rows
assert all(r["redriven_workflow"] == "" for r in beta_rows), beta_rows
PY

# --- case 3: THE BOUNDARY IS NOT CROSSED TWICE ------------------------------
# This is the assertion that must never regress.
sends_after="$(outbox_sends)"
[ "$sends_before" = "$sends_after" ] ||
    fail "redrive queued $((sends_after - sends_before)) new outbox message(s): a firing that already crossed an external boundary crossed it again"
[ "$sends_after" = "1" ] || fail "expected exactly one outbox crossing in the journal, found $sends_after"

python3 - "$gate_root/pass1.json" "$log" "$roster_v1" "$roster_v2" <<'PY'
import hashlib, json, sys
report = json.load(open(sys.argv[1]))
gaps = [row for row in report["rows"] if row["case"] == "compensate"]
assert len(gaps) == 1, report
gap_row = gaps[0]
assert gap_row["artifact"] == "artifact/notice/dispatch", gap_row
assert gap_row["crossed"] == "outbox/notify/workers", gap_row
assert gap_row["redriven_workflow"] == "", "a boundary crossing was re-fired"

artifacts = {}
for line in open(sys.argv[2]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    for a in rec["artifacts"]:
        artifacts[a["id"]] = bytes.fromhex(a["bytes"])

gap = json.loads(artifacts[gap_row["record"]])
assert gap["schema"] == "neuron.compensation-gap/v1", gap
assert gap["crossed"] == "outbox/notify/workers", gap
assert gap["resolution"] == "manual-compensation-required", gap
assert gap["refusal"], gap

# It names the superseded product ...
notice = artifacts["artifact/notice/dispatch"]
assert gap["superseded_product"]["id"] == "artifact/notice/dispatch", gap
assert gap["superseded_product"]["digest"] == hashlib.sha256(notice).hexdigest(), gap

# ... the new product, or honestly that it is unknown, with a reason. It must
# never be fabricated: computing it here would require re-crossing.
assert gap["new_product"]["known"] is False, gap
assert gap["new_product"]["digest"] == "", gap
assert gap["new_product"]["reason"], gap

# ... and the delta, which is what a compensating message would actually say.
before, after = sys.argv[3].encode(), sys.argv[4].encode()
delta = gap["delta"]
assert delta["source"] == "artifact/roster/workers", delta
assert delta["before"]["known"] and delta["after"]["known"], delta
assert delta["before"]["digest"] == hashlib.sha256(before).hexdigest(), delta
assert delta["after"]["digest"] == hashlib.sha256(after).hexdigest(), delta
assert delta["before"]["bytes"] == len(before), delta
assert delta["after"]["bytes"] == len(after), delta
assert delta["identical"] is False, delta
expected = next(i for i in range(min(len(before), len(after))) if before[i] != after[i])
assert delta["first_differing_offset"] == expected, (delta, expected)
PY

# The boundary's own record of what it did is unchanged: exactly one notice
# went out, and its content still describes the roster that existed then.
[ "$(artifact_bytes artifact/notice/dispatch | wc -l)" -le 1 ] ||
    fail "the notice artifact was rewritten"
python3 - "$(artifact_bytes artifact/notice/dispatch)" "$roster_v1" <<'PY'
import hashlib, sys
notice, roster = sys.argv[1], sys.argv[2]
assert hashlib.sha256(roster.encode()).hexdigest()[:16] in notice, notice
PY

# ---------------------------------------------------------------------------
# 4. Termination: the cascade is bounded and reaches a fixpoint.
# ---------------------------------------------------------------------------
gen() { python3 - "$log" <<'PY'
import json, sys
seen = "0"
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    for a in rec["artifacts"]:
        if a["id"] == "artifact/redrive/generation":
            seen = bytes.fromhex(a["bytes"]).decode()
print(seen)
PY
}
[ "$(gen)" = "1" ] || fail "the generation counter did not advance: the cascade is unbounded"

# A re-derivation settles a goal, which advances the active snapshot, which
# invalidates the derivations that cited it — so the next pass legitimately has
# work. Determinism is what makes that sequence converge, and convergence is
# what the loop must actually reach rather than assume.
fixpoint=""
for pass_n in 2 3 4 5 6 7 8 9 10; do
    wal_pass="$(wc -c < "$log")"
    "$binary" redrive "$state" --json > "$gate_root/pass$pass_n.json"
    changed="$(python3 -c '
import json,sys
r = json.load(open(sys.argv[1]))
print(sum(1 for row in r["rows"] if row["changed"]))' "$gate_root/pass$pass_n.json")"
    if [ "$changed" = "0" ] && [ "$(wc -c < "$log")" = "$wal_pass" ]; then
        fixpoint="$pass_n"
        break
    fi
done
[ -n "$fixpoint" ] || fail "re-derivation never reached a fixpoint in nine passes"

# And whatever happens, the bound holds: no pass may raise the generation above
# MAX_GENERATIONS, and no pass may ever cross the boundary again.
python3 -c 'import sys; assert int(sys.argv[1]) <= 8, sys.argv[1]' "$(gen)"
[ "$(outbox_sends)" = "1" ] ||
    fail "a later pass crossed the external boundary: $(outbox_sends) sends, expected 1"

# The bound itself, on its own node, driven to the ceiling. Replacing the
# attached boundary changes the work identity, so every pass has genuinely new
# work and the counter genuinely advances — which is exactly the shape a
# non-deterministic producer would take if determinism were not required. Past
# the ceiling the loop MUST stop re-firing and hand over, not keep going.
bound_node="$gate_root/bound"
bound_state="$bound_node/state"
"$binary" agent init "$bound_node" gamma >/dev/null
"$binary" agent run "$bound_node" gamma --goal "bounded" --json >/dev/null
"$binary" agent run "$bound_node" gamma --goal "moves it" --json >/dev/null
for step in 0 1 2 3 4 5 6 7 8 9 10; do
    printf '#!/usr/bin/env bash\ntr "[:lower:]" "[:upper:]"\nexit 0 # %d\n' "$step" \
        > "$gate_root/boundary$step.sh"
    chmod +x "$gate_root/boundary$step.sh"
    "$binary" interface describe "$gate_root/boundary$step.sh" --kind process \
        --id "proc/boundary$step" --input-channel stdin --deterministic \
        --output "$gate_root/boundary$step.json" >/dev/null
    digest="$("$binary" interface admit "$bound_node" "$gate_root/boundary$step.json" --json |
        python3 -c 'import json,sys;print(json.load(sys.stdin)["interface"])')"
    "$binary" interface attach "$bound_node" gamma --interface "$digest" \
        --role worker --replace >/dev/null
    "$binary" redrive "$bound_state" --json > "$gate_root/bound$step.json"
done
python3 - "$gate_root" <<'PY'
import glob, json, os, sys
root = sys.argv[1]
passes = [json.load(open(os.path.join(root, "bound%d.json" % i))) for i in range(11)]
gens = [p["generation"] for p in passes]
assert gens == sorted(gens), gens
# The bound is on re-firing, not on the counter: an escalation pass still
# records what it handed over, and that record is itself a generation.
assert all(p["bounded"] == (p["generation"] >= 8) for p in passes), gens
bounded = [p for p in passes if p["bounded"]]
assert bounded, "the generation bound was never reached: the cascade is unbounded"
for p in bounded:
    assert p["redriven"] == 0, p
    # Past the bound every remaining row hands over to an agent rather than
    # being dropped: an unfinished cascade a human can see is recoverable.
    assert all(row["case"] != "redrive" for row in p["rows"]), p
    assert all(row["redriven_workflow"] == "" for row in p["rows"]), p
    assert any("generation bound" in row["reason"] for row in p["rows"]), p
PY

# ---------------------------------------------------------------------------
# 5. Idempotence: the same facts settle as a replay, not a second record.
# ---------------------------------------------------------------------------
wal_settled="$(wc -c < "$log")"
"$binary" redrive "$state" --json > "$gate_root/idem.json"
[ "$(wc -c < "$log")" = "$wal_settled" ] ||
    fail "a redrive pass over unchanged facts appended new records"
gap_count="$(python3 - "$log" <<'PY'
import json, sys
ids = set()
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get("op") != "commit":
        continue
    for a in rec["artifacts"]:
        if a["id"].startswith("artifact/redrive/gaps/"):
            ids.add(a["id"])
print(len(ids))
PY
)"
[ "$gap_count" = "1" ] || fail "expected one compensation gap, found $gap_count"

# ---------------------------------------------------------------------------
# 6. The projection and the loop agree, and the node still replays.
# ---------------------------------------------------------------------------
"$binary" telemetry stale "$state" --json | python3 -c '
import json, sys
rows = [json.loads(l) for l in sys.stdin if l.strip()]
notice = [r for r in rows if r["artifact"] == "artifact/notice/dispatch"]
assert notice and notice[0]["redrivable"] is False, notice
' || fail "the staleness projection stopped agreeing with the loop"

"$binary" agent inspect "$node" alpha --json | python3 -c '
import json, sys
view = json.load(sys.stdin)
assert view["agent"] == "alpha", view
' || fail "the node no longer replays after redrive"

echo "redrive gate: PASS"
