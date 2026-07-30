#!/usr/bin/env bash
# Runnable witness for model, device, and human interfaces (entrypoint plan
# Phase 4). Through the public CLI only, against real boundaries — a real TCP
# model provider started by this gate, a real device directory, and a real
# human inbox:
#
#   1. two compatible model providers are swapped behind one unchanged topology
#      — same agent, same role, same acceptance predicate — and the *far end's
#      own counters* prove which provider actually served each goal;
#   2. provider identity lives inside the interface pin, so a swap is a
#      different admitted interface rather than a silent substitution;
#   3. a human approval is required before a simulated actuator moves: no
#      answer, a refusal, a forged subject, and a gate that is not a human
#      boundary each fail closed with the device provably untouched;
#   4. an approved effect crosses exactly once and settles only after an
#      independent read-back of the device's own state;
#   5. model output and human input remain untrusted evidence: neither may
#      claim determinism, a model without provenance is inadmissible, and a
#      model answer that fails the caller's acceptance predicate does not
#      become a settled result.
#
# Every assertion inspects durable state or the far end's own counters, never
# stdout resemblance.

# Job-control notices would otherwise print when the trap kills the test server.
set +m
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-mdh.XXXXXX")"
model_pid=""
cleanup() {
    if [ -n "$model_pid" ]; then
        kill "$model_pid" 2>/dev/null || true
        wait "$model_pid" 2>/dev/null || true
    fi
    rm -rf -- "$gate_root"
}
trap cleanup EXIT

node_dir="$gate_root/node"
binary="$repo_dir/zig-out/bin/neuron"
inbox="$gate_root/inbox"     # the human boundary
device="$gate_root/device"   # the device boundary
mkdir -p "$inbox" "$device"

fail() { echo "FAIL: $1" >&2; exit 1; }

# --- the model boundary: two providers behind one real server -----------------
python3 "$repo_dir/tests/fixtures/model_provider_server.py" 0 \
    > "$gate_root/port.txt" 2>"$gate_root/model.err" &
model_pid=$!
for _ in $(seq 1 50); do
    port="$(tr -d '[:space:]' < "$gate_root/port.txt" 2>/dev/null || true)"
    [ -n "$port" ] && break
    sleep 0.1
done
port="$(tr -d '[:space:]' < "$gate_root/port.txt")"
[ -n "$port" ] || { cat "$gate_root/model.err" >&2; fail "the model boundary never reported a port"; }
base="http://127.0.0.1:$port"

"$binary" agent init "$node_dir" swapper >/dev/null

admit() { "$binary" interface admit "$node_dir" "$1" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["interface"])'; }
served() { curl -s "$base/served?provider=$1" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])'; }
dispatch_field() { "$binary" interface dispatch "$node_dir" --json 2>/dev/null |
    python3 -c "import json,sys; print(json.load(sys.stdin)[\"$1\"])"; }
sha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }

# ---------------------------------------------------------------------------
# 1. Two compatible model providers. Provider identity is inside the pin.
# ---------------------------------------------------------------------------
"$binary" interface describe "$base/alpha/complete?text={input}" --kind model --id model/alpha \
    --method GET --non-mutating --response-encoding json --response-field completion \
    --provider alpha-labs --model-name alpha-1 --protocol chat-completions/v1 --cost-micros 250 \
    --output "$gate_root/alpha.json" >/dev/null
"$binary" interface describe "$base/beta/complete?text={input}" --kind model --id model/beta \
    --method GET --non-mutating --response-encoding json --response-field completion \
    --provider beta-systems --model-name beta-9 --protocol chat-completions/v1 --cost-micros 90 \
    --output "$gate_root/beta.json" >/dev/null

alpha="$(admit "$gate_root/alpha.json")"
beta="$(admit "$gate_root/beta.json")"
[ "$alpha" != "$beta" ] || fail "two providers produced one interface digest: a swap would be invisible"

# The same declaration with only the provider changed must not collide either —
# provider and model are load-bearing parts of the contract, not annotations.
python3 - "$gate_root/alpha.json" "$gate_root/relabel.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["provider"] = "beta-systems"
d["id"] = "model/relabelled"
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY
if "$binary" interface test "$gate_root/relabel.json" >/dev/null 2>&1; then
    fail "a manifest whose provider was changed still matched its old pin"
fi

# ---------------------------------------------------------------------------
# 2. A model and a human may not claim determinism, and a model must carry
#    provenance. Both are refused at admission, not discovered later.
# ---------------------------------------------------------------------------
"$binary" interface describe "$inbox" --kind human --id human/approver \
    --human-interaction approval --output "$gate_root/human.json" >/dev/null

for src in alpha human; do
    python3 - "$gate_root/$src.json" "$gate_root/det-$src.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["invocation"]["deterministic"] = True
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY
    out="$("$binary" interface test "$gate_root/det-$src.json" 2>&1 || true)"
    case "$out" in
        *InterfaceNondeterminismClaim*) ;;
        *) fail "$src claimed determinism and was not refused: $out" ;;
    esac
done

python3 - "$gate_root/alpha.json" "$gate_root/noprov.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["provider"] = ""
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY
out="$("$binary" interface test "$gate_root/noprov.json" 2>&1 || true)"
case "$out" in
    *InterfaceProvenanceMissing*) ;;
    *) fail "a model with no provider was not refused: $out" ;;
esac

# The durable manifest records the untrusted status, so the property survives
# in the record rather than only in the code that happens to read it.
python3 - "$gate_root/alpha.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["invocation"]["deterministic"] is False, "describe authored a deterministic model"
assert "untrusted evidence" in d["settlement"], d["settlement"]
PY

human="$(admit "$gate_root/human.json")"

# ---------------------------------------------------------------------------
# 3. Swap the providers behind an unchanged topology.
# ---------------------------------------------------------------------------
cat > "$gate_root/accept.json" <<'EOF'
{"schema":"neuron.acceptance-predicate/v1","kind":"contains","value":"SUMMARIZE THE LEDGER"}
EOF

alpha_before="$(served alpha-labs)"
beta_before="$(served beta-systems)"

"$binary" interface attach "$node_dir" swapper --interface "$alpha" --role worker >/dev/null
"$binary" agent run "$node_dir" swapper --goal "summarize the ledger" \
    --acceptance "$gate_root/accept.json" --json >"$gate_root/run-alpha.json"
python3 - "$gate_root/run-alpha.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["status"] == "settled", d
PY

alpha_mid="$(served alpha-labs)"
beta_mid="$(served beta-systems)"
[ "$alpha_mid" -gt "$alpha_before" ] || fail "the alpha provider never actually served the goal"
[ "$beta_mid" -eq "$beta_before" ] || fail "the beta provider served while alpha was attached"

# The swap: same agent, same role, same acceptance predicate. Only the admitted
# interface behind the role changes.
"$binary" interface detach "$node_dir" swapper --role worker >/dev/null
"$binary" interface attach "$node_dir" swapper --interface "$beta" --role worker >/dev/null
"$binary" agent run "$node_dir" swapper --goal "summarize the ledger again" \
    --acceptance "$gate_root/accept.json" --json >"$gate_root/run-beta.json"
python3 - "$gate_root/run-beta.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["status"] == "settled", d
PY

[ "$(served beta-systems)" -gt "$beta_mid" ] || fail "after the swap the beta provider never served"
[ "$(served alpha-labs)" -eq "$alpha_mid" ] || fail "after the swap alpha was still being called"

# ---------------------------------------------------------------------------
# 4. Model output is untrusted: an answer that fails the caller's acceptance
#    predicate does not become a settled result.
# ---------------------------------------------------------------------------
cat > "$gate_root/reject.json" <<'EOF'
{"schema":"neuron.acceptance-predicate/v1","kind":"contains","value":"A-STRING-NO-PROVIDER-EMITS"}
EOF
served_before_reject="$(served beta-systems)"
set +e
"$binary" agent run "$node_dir" swapper --goal "an unacceptable ledger question" \
    --acceptance "$gate_root/reject.json" --json >"$gate_root/run-reject.json" 2>/dev/null
set -e
python3 - "$gate_root/run-reject.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["status"] == "failed", f"a model answer settled without passing acceptance: {d}"
PY
# The model really was called — this is a judgement failure, not a call that
# never happened. That distinction is the whole point of "untrusted".
[ "$(served beta-systems)" -gt "$served_before_reject" ] || \
    fail "the model was never called, so the acceptance failure proves nothing"

# ---------------------------------------------------------------------------
# 5. A device declares sensor versus actuator, and an actuator without a human
#    gate is not admissible at all.
# ---------------------------------------------------------------------------
out="$("$binary" interface describe "$device" --kind device --id device/ungated \
    --device-role actuator --mode command --output "$gate_root/ungated.json" 2>&1 || true)"
case "$out" in
    *InterfaceSafetyGateMissing*) ;;
    *) fail "an actuator with no human gate was describable: $out" ;;
esac

# A sensor may not be a command: the split is structural, not advisory.
out="$("$binary" interface describe "$device" --kind device --id device/badsensor \
    --device-role sensor --mode command --output "$gate_root/badsensor.json" 2>&1 || true)"
case "$out" in
    *InterfaceDeviceRoleInvalid*) ;;
    *) fail "a sensor was admissible as a command: $out" ;;
esac

"$binary" interface describe "$device" --kind device --id device/arm \
    --device-role actuator --mode command --approval-interface "$human" \
    --output "$gate_root/arm.json" >/dev/null
arm="$(admit "$gate_root/arm.json")"

# ---------------------------------------------------------------------------
# 6. No approval, an explicit refusal, and a forged subject each leave the
#    device untouched.
# ---------------------------------------------------------------------------
silent="ARM-TO-7"
"$binary" interface call "$node_dir" --interface "$arm" --input "$silent" >/dev/null
[ "$(dispatch_field failure)" = "InterfaceApprovalMissing" ] || \
    fail "an unapproved actuator effect did not report a missing approval"
[ -z "$(ls -A "$device")" ] || fail "the device moved with no human approval"

refused="ARM-TO-DANGER"
refused_hex="$(sha "$refused")"
cat > "$inbox/$refused_hex.json" <<EOF
{"schema":"neuron.human-decision/v1","subject":"$refused_hex","decision":"reject","note":"unsafe travel"}
EOF
"$binary" interface call "$node_dir" --interface "$arm" --input "$refused" >/dev/null
[ "$(dispatch_field failure)" = "InterfaceApprovalDenied" ] || \
    fail "an explicitly refused effect did not report a denial"
[ -z "$(ls -A "$device")" ] || fail "the device moved after a human refused"

forged="ARM-TO-11"
forged_hex="$(sha "$forged")"
other_hex="$(sha "a completely different effect")"
cat > "$inbox/$forged_hex.json" <<EOF
{"schema":"neuron.human-decision/v1","subject":"$other_hex","decision":"approve","note":"approves other bytes"}
EOF
"$binary" interface call "$node_dir" --interface "$arm" --input "$forged" >/dev/null
[ "$(dispatch_field failure)" = "InterfaceApprovalMalformed" ] || \
    fail "an approval naming different bytes was accepted for this effect"
[ -z "$(ls -A "$device")" ] || fail "the device moved on an approval for different bytes"

# A gate that is not a human approval boundary is not a gate. The actuator names
# the *model* interface as its approver; admission cannot tell, but the dispatch
# path must.
python3 - "$gate_root/arm.json" "$gate_root/badgate.json" "$alpha" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["approval_interface"] = sys.argv[3]
d["id"] = "device/badgate"
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY
badgate="$(admit "$gate_root/badgate.json")"
"$binary" interface call "$node_dir" --interface "$badgate" --input "ARM-VIA-BAD-GATE" >/dev/null
[ "$(dispatch_field failure)" = "InterfaceSafetyGateMissing" ] || \
    fail "an actuator gated by a non-human interface was allowed to proceed"
[ -z "$(ls -A "$device")" ] || fail "the device moved through a non-human gate"

# ---------------------------------------------------------------------------
# 7. An approved effect crosses once and settles on an independent read-back.
# ---------------------------------------------------------------------------
approved="ARM-TO-9"
approved_hex="$(sha "$approved")"
cat > "$inbox/$approved_hex.json" <<EOF
{"schema":"neuron.human-decision/v1","subject":"$approved_hex","decision":"approve","note":"operator cleared travel"}
EOF
"$binary" interface call "$node_dir" --interface "$arm" --input "$approved" >/dev/null
"$binary" interface dispatch "$node_dir" --json >"$gate_root/dispatch.json"
python3 - "$gate_root/dispatch.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["acknowledged"] == 1, d
assert d["reconciled"] is True, d
assert d["failure"] == "", d
assert d["receipt"], "an acknowledged effect recorded no receipt"
PY

# The device really holds the approved bytes, addressed by their content.
[ -f "$device/$approved_hex" ] || fail "the approved effect never reached the device"
[ "$(cat "$device/$approved_hex")" = "$approved" ] || \
    fail "the device state is not the approved content"

# Exactly one effect landed: the three refused ones never crossed.
landed="$(ls -1 "$device" | wc -l | tr -d ' ')"
[ "$landed" = "1" ] || fail "expected exactly one device effect, found $landed"

# Redelivering the same approved content re-queues nothing and re-applies
# nothing: identity, not resemblance, decides.
"$binary" interface call "$node_dir" --interface "$arm" --input "$approved" >/dev/null 2>&1 || true
"$binary" interface dispatch "$node_dir" --json >"$gate_root/redeliver.json" 2>/dev/null || true
landed_after="$(ls -1 "$device" | wc -l | tr -d ' ')"
[ "$landed_after" = "1" ] || fail "a redelivery became a second device effect"

# ---------------------------------------------------------------------------
# 8. The sensor reads the device's own state back — a different code path than
#    the one that wrote it.
# ---------------------------------------------------------------------------
"$binary" interface describe "$device" --kind device --id device/arm-sensor \
    --device-role sensor --mode read --output "$gate_root/sensor.json" >/dev/null
sensor="$(admit "$gate_root/sensor.json")"
observed="$("$binary" interface call "$node_dir" --interface "$sensor" --input "$approved_hex" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["output"])')"
[ "$observed" = "$approved" ] || fail "the sensor did not observe the actuator's effect: $observed"

# ---------------------------------------------------------------------------
# 9. Durable record: every admitted Phase 4 kind is present and non-deterministic
#    boundaries are recorded as such.
# ---------------------------------------------------------------------------
"$binary" interface list "$node_dir" --json >"$gate_root/list.json"
python3 - "$gate_root/list.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
kinds = {i["kind"] for i in d["admitted"]}
for required in ("model", "device", "human"):
    assert required in kinds, f"{required} missing from the admitted record: {kinds}"
for i in d["admitted"]:
    if i["kind"] in ("model", "human"):
        assert i["deterministic"] is False, f"{i['id']} recorded as deterministic"
PY

echo "model-device-human gate: PASS"
