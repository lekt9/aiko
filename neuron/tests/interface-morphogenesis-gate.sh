#!/usr/bin/env bash
# Runnable witness for automatic interface morphogenesis (entrypoint plan
# Phase 6). Through the public CLI only, against real executables this gate
# writes and a real node substrate:
#
#   1. the node begins with no compatible adapter at all;
#   2. a typed CapabilityGap drives discovery of a real boundary, derivation of
#      a complete adapter manifest, its contract + adversarial testing, its
#      independent admission, a least-authority attachment, and a retry of the
#      original goal on the real path — all without a restart;
#   3. the second goal REUSES the admitted interface instead of generating a
#      second one, proven by deleting the discovery target first: reuse cannot
#      be discovery in disguise if there is nothing left to discover;
#   4. a boundary that passes its battery and then regresses after admission is
#      RETIRED — revoked, detached, and no longer callable — because admission
#      is not success;
#   5. rankings are learned only from verified results: a failed resolution
#      leaves no pattern record, and the verified-success count advances only on
#      resolutions that actually satisfied the gap;
#   6. the generated edge never inherits the generator's authority: the grant is
#      scoped to the agent's own workspace, cannot spawn, and cannot send;
#   7. an unfalsifiable gap — one with no acceptance — is refused rather than
#      trivially "resolved";
#   8. retirement preserves the audit: the admission, revocation, and detachment
#      records all remain.
#
# Every assertion inspects durable state or the boundary's own behaviour, never
# stdout resemblance.

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-morph.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT

node_dir="$gate_root/node"
binary="$repo_dir/zig-out/bin/neuron"
log="$node_dir/state/substrate.log"

fail() { echo "FAIL: $1" >&2; exit 1; }

"$binary" agent init "$node_dir" builder >/dev/null

admitted_count() {
    "$binary" interface list "$node_dir" --json |
        python3 -c 'import json,sys; print(len(json.load(sys.stdin)["admitted"]))'
}
revoked_count() {
    "$binary" interface list "$node_dir" --json |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["revoked"])'
}
# Pattern records for one gap id, by its durable slug.
patterns_for() {
    python3 - "$log" "$1" <<'PY'
import hashlib, json, sys
log, gap = sys.argv[1], sys.argv[2]
slug = hashlib.sha256(gap.encode()).hexdigest()
best = None
with open(log) as fh:
    for line in fh:
        try:
            d = json.loads(line)
        except Exception:
            continue
        for art in (d.get("artifacts") or []):
            if art.get("id", "") == f"interfaces/patterns/{slug}":
                best = json.loads(bytes.fromhex(art["bytes"]).decode())
print(best["verified_successes"] if best else 0)
PY
}
resolve() { "$binary" interface resolve-gap "$node_dir" builder --gap "$1" --json; }
# Scalars are printed as JSON, so a boolean reads `true` rather than Python's
# `True` and comparisons in this gate stay in one vocabulary.
field() {
    python3 -c "
import json, sys
v = json.load(sys.stdin)[\"$1\"]
print(v if isinstance(v, str) else json.dumps(v))
"
}

# --- the boundary the gap will be resolved against ----------------------------
upper="$gate_root/upper.sh"
printf '#!/bin/sh\nexec tr "[:lower:]" "[:upper:]"\n' > "$upper"
chmod +x "$upper"

cat > "$gate_root/gap.json" <<EOF
{"schema":"neuron.capability-gap/v1",
 "id":"gap/uppercase",
 "need":"uppercase a line of text",
 "accepts":["neuron.interface-call/v1"],
 "emits":["neuron.interface-result/v1"],
 "discovery_target":"$upper",
 "discovery_kind":"process",
 "probe_input":"morphogenesis probe",
 "expect_contains":"MORPHOGENESIS PROBE"}
EOF

# ---------------------------------------------------------------------------
# 1. No compatible adapter exists yet.
# ---------------------------------------------------------------------------
[ "$(admitted_count)" = "0" ] || fail "the node did not begin with an empty interface set"
[ "$(patterns_for gap/uppercase)" = "0" ] || fail "a pattern existed before anything was verified"

# ---------------------------------------------------------------------------
# 2. An unfalsifiable gap is refused rather than trivially resolved.
# ---------------------------------------------------------------------------
python3 - "$gate_root/gap.json" "$gate_root/no-acceptance.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["expect_contains"] = ""
d["id"] = "gap/unfalsifiable"
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY
out="$(resolve "$gate_root/no-acceptance.json" 2>&1 || true)"
case "$out" in
    *InvalidCapabilityGap*) ;;
    *) fail "a gap with no acceptance was not refused: $out" ;;
esac
[ "$(admitted_count)" = "0" ] || fail "an unfalsifiable gap still admitted something"

# ---------------------------------------------------------------------------
# 3. Generate: discover, derive, test, admit, attach, retry, judge.
# ---------------------------------------------------------------------------
resolve "$gate_root/gap.json" > "$gate_root/first.json"
[ "$(field route      < "$gate_root/first.json")" = "generated" ] || fail "the first resolution did not generate an adapter"
[ "$(field verified   < "$gate_root/first.json")" = "true" ]      || fail "the generated adapter was not verified on the real path"
[ "$(field verified_successes < "$gate_root/first.json")" = "1" ] || fail "the first verified success was not recorded as 1"
generated="$(field interface < "$gate_root/first.json")"
[ "$(admitted_count)" = "1" ] || fail "expected exactly one admitted interface after generation"
[ "$(patterns_for gap/uppercase)" = "1" ] || fail "no pattern record was written for a verified resolution"

# The attached interface really does the work, through the ordinary call path.
observed="$("$binary" interface call "$node_dir" --interface "$generated" --input "real path" --json | field output)"
[ "$observed" = "REAL PATH" ] || fail "the generated adapter does not perform the capability: $observed"

# ---------------------------------------------------------------------------
# 4. The edge is least-authority and does not inherit the generator's caps.
# ---------------------------------------------------------------------------
python3 - "$log" <<'PY'
import json, sys
last = None
with open(sys.argv[1]) as fh:
    for line in fh:
        try:
            d = json.loads(line)
        except Exception:
            continue
        for art in (d.get("artifacts") or []):
            if art.get("id", "").startswith("agents/") and "/interfaces/" in art.get("id", ""):
                last = json.loads(bytes.fromhex(art["bytes"]).decode())
assert last, "no attachment record was written"
assert last["status"] == "attached", last
caps = last["granted_caps"]
assert caps["write_prefix"] == "agents/builder/work/", caps
assert caps["allow_spawn"] is False, caps
# A worker is a capability read, so it may not send either.
assert caps["allow_send"] is False, caps
PY

# ---------------------------------------------------------------------------
# 5. Reuse before discovery — proven by pointing the same gap at a discovery
#    target that would FAIL it. If discovery ran at all, the resolution would
#    retire rather than reuse, and a second interface would be admitted.
#
#    (Deleting the target instead would prove nothing: a process interface pins
#    its executable's bytes, so removing it correctly breaks reuse as well.)
# ---------------------------------------------------------------------------
useless="$gate_root/useless.sh"
printf '#!/bin/sh\nexec cat >/dev/null\n' > "$useless"
chmod +x "$useless"
python3 - "$gate_root/gap.json" "$gate_root/gap-bad-target.json" "$useless" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["discovery_target"] = sys.argv[3]
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY

resolve "$gate_root/gap-bad-target.json" > "$gate_root/second.json"
[ "$(field route < "$gate_root/second.json")" = "reused" ] || fail "the second resolution did not reuse the admitted interface"
[ "$(field interface < "$gate_root/second.json")" = "$generated" ] || fail "reuse resolved to a different interface"
[ "$(field verified_successes < "$gate_root/second.json")" = "2" ] || fail "the verified-success count did not advance on reuse"
[ "$(admitted_count)" = "1" ] || fail "reuse admitted a second interface"
[ "$(patterns_for gap/uppercase)" = "2" ] || fail "the pattern record did not accumulate the second verified success"

# ---------------------------------------------------------------------------
# 6. A boundary that regresses after admission is retired: admission is not
#    success. This one passes its battery and then stops working the moment the
#    node records its admission.
# ---------------------------------------------------------------------------
# Its acceptance is deliberately one the already-admitted uppercaser cannot
# meet, so reuse genuinely fails and generation is forced. Otherwise the
# resolver would correctly reuse the existing edge and this case would never
# reach the path it is meant to exercise.
# It regresses when the node records an admission *beyond the ones already
# present* — i.e. exactly when its own admission commits, after its battery has
# passed and before the real-path retry.
marks_before="$(grep -o 'interfaces/admitted/' "$log" | wc -l | tr -d ' ')"
fickle="$gate_root/fickle.sh"
cat > "$fickle" <<EOF
#!/bin/sh
marks="\$(grep -o 'interfaces/admitted/' "$log" 2>/dev/null | wc -l | tr -d ' ')"
if [ "\$marks" -gt "$marks_before" ]; then
  echo "REGRESSED"
else
  printf 'OK:%s' "\$(tr '[:lower:]' '[:upper:]')"
fi
EOF
chmod +x "$fickle"

cat > "$gate_root/fickle-gap.json" <<EOF
{"schema":"neuron.capability-gap/v1",
 "id":"gap/fickle",
 "need":"a marked uppercase from a boundary that regresses once admitted",
 "accepts":["neuron.interface-call/v1"],
 "emits":["neuron.interface-result/v1"],
 "discovery_target":"$fickle",
 "discovery_kind":"process",
 "probe_input":"morphogenesis probe",
 "expect_contains":"OK:MORPHOGENESIS PROBE"}
EOF

revoked_before="$(revoked_count)"
out="$(resolve "$gate_root/fickle-gap.json" 2>&1 || true)"
case "$out" in
    *GeneratedAdapterRetired*) ;;
    *) fail "a boundary that regressed after admission was not retired: $out" ;;
esac
[ "$(revoked_count)" -gt "$revoked_before" ] || fail "the retired adapter was not revoked"

# Nothing is retained on compilation alone: no pattern, and the retired
# interface is not callable.
[ "$(patterns_for gap/fickle)" = "0" ] || fail "a retired adapter still trained the ranking"

retired="$("$binary" interface list "$node_dir" --json | python3 -c '
import json,sys
d = json.load(sys.stdin)
known = {i["interface"] for i in d["admitted"]}
print([h for h in known if h != sys.argv[1]][0] if len(known) > 1 else "")
' "$generated")"
[ -n "$retired" ] || fail "the retired adapter left no admission record to audit"
out="$("$binary" interface call "$node_dir" --interface "$retired" --input "hello" 2>&1 || true)"
case "$out" in
    *InterfaceRevoked*) ;;
    *) fail "a retired adapter was still callable: $out" ;;
esac

# The audit survives retirement: the edge is recorded as detached, not erased.
python3 - "$log" <<'PY'
import json, sys
statuses = []
with open(sys.argv[1]) as fh:
    for line in fh:
        try:
            d = json.loads(line)
        except Exception:
            continue
        for art in (d.get("artifacts") or []):
            i = art.get("id", "")
            if i.startswith("agents/") and "/interfaces/" in i:
                body = json.loads(bytes.fromhex(art["bytes"]).decode())
                statuses.append(body["status"])
assert "attached" in statuses, statuses
assert "detached" in statuses, "retirement did not record a detachment: %s" % statuses
PY

# ---------------------------------------------------------------------------
# 7. The surviving interface is untouched by the failed resolution, and still
#    ranks on its own verified history.
# ---------------------------------------------------------------------------
resolve "$gate_root/gap.json" > "$gate_root/third.json"
[ "$(field route < "$gate_root/third.json")" = "reused" ] || fail "the surviving interface was not reused after an unrelated failure"
[ "$(field interface < "$gate_root/third.json")" = "$generated" ] || fail "reuse drifted to a different interface"
[ "$(field verified_successes < "$gate_root/third.json")" = "3" ] || fail "the verified-success count did not advance to 3"

echo "interface-morphogenesis gate: PASS"
