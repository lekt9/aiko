#!/usr/bin/env bash
# Runnable witness for the optional economic profile (entrypoint plan Phase 5).
# Through the public CLI only, against a real x402-compatible TCP resource and a
# real signing executable, both started by this gate:
#
#   1. a paid resource really answers 402 with a typed quote, and admission does
#      not require paying — being challenged is correct behaviour, not a defect;
#   2. an under-budget, under-threshold call pays exactly once and returns the
#      resource's typed result;
#   3. a retry does not repay — proven by the resource's own settlement counter
#      and by there being exactly one durable payment receipt;
#   4. over-budget, over-cumulative, wrong-asset, unapproved, and no-policy
#      calls never sign — proven by the wallet's own invocation log, which does
#      not grow;
#   5. a quote at or above the approval threshold needs a human approval bound
#      to that exact quote digest; an approval of a different quote does not
#      authorize it;
#   6. payment success and resource correctness are recorded and judged
#      separately: a rejected proof is distinguishable from a challenge, and a
#      paid answer is still judged on its own bytes.
#
# Wallet semantics live entirely in an admitted adapter — the core decides
# whether a payment is permitted and never signs one (plan §10).
#
# Every assertion inspects durable state, the wallet's log, or the far end's own
# counters, never stdout resemblance.

set +m
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-paid.XXXXXX")"
resource_pid=""
cleanup() {
    if [ -n "$resource_pid" ]; then
        kill "$resource_pid" 2>/dev/null || true
        wait "$resource_pid" 2>/dev/null || true
    fi
    rm -rf -- "$gate_root"
}
trap cleanup EXIT

node_dir="$gate_root/node"
binary="$repo_dir/zig-out/bin/neuron"
inbox="$gate_root/inbox"
signer="$gate_root/signer.sh"
signlog="$gate_root/signatures.log"
mkdir -p "$inbox"
: > "$signlog"

fail() { echo "FAIL: $1" >&2; exit 1; }

# The wallet. Keys and signing live here, outside the Neuron core; it records
# every invocation so "never signed" is a checkable claim rather than a belief.
cat > "$signer" <<EOF
#!/bin/sh
challenge="\$(cat)"
printf '%s\n' "\$challenge" >> "$signlog"
printf 'paid:%s' "\$(printf '%s' "\$challenge" | shasum -a 256 | cut -d' ' -f1)"
EOF
chmod +x "$signer"
# Only signatures over a real payment challenge count. Admitting the wallet
# exercises it with the battery's probe input, which is correct behaviour and
# must not be mistaken for a payment.
# `grep -c` prints 0 *and* exits non-zero on no match, so the count is captured
# with `|| true` rather than an `|| echo 0` that would emit a second line.
signatures() {
    local n
    n="$(grep -c 'neuron.payment-quote/v1' "$signlog" 2>/dev/null || true)"
    printf '%s' "${n:-0}"
}

python3 "$repo_dir/tests/fixtures/x402_resource_server.py" 0 \
    > "$gate_root/port.txt" 2>"$gate_root/resource.err" &
resource_pid=$!
for _ in $(seq 1 50); do
    port="$(tr -d '[:space:]' < "$gate_root/port.txt" 2>/dev/null || true)"
    [ -n "$port" ] && break
    sleep 0.1
done
port="$(tr -d '[:space:]' < "$gate_root/port.txt")"
[ -n "$port" ] || { cat "$gate_root/resource.err" >&2; fail "the paid resource never reported a port"; }
base="http://127.0.0.1:$port"

"$binary" agent init "$node_dir" payer >/dev/null

admit() { "$binary" interface admit "$node_dir" "$1" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["interface"])'; }
charges() { curl -s "$base/charges?resource=$1" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])'; }
sha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
# Every durable payment receipt this node has committed.
receipts() {
    python3 - "$node_dir" <<'PY'
import json, os, sys
log = os.path.join(sys.argv[1], "state", "substrate.log")
ids = set()
with open(log) as fh:
    for line in fh:
        try:
            d = json.loads(line)
        except Exception:
            continue
        for art in (d.get("artifacts") or []):
            i = art.get("id", "")
            if i.startswith("interfaces/payments/"):
                ids.add(i)
print(len(ids))
PY
}

# --- the wallet and the human treasurer ---------------------------------------
"$binary" interface describe "$signer" --kind process --id wallet/signer \
    --input-channel stdin --output "$gate_root/signer.json" >/dev/null
wallet="$(admit "$gate_root/signer.json")"

"$binary" interface describe "$inbox" --kind human --id human/treasurer \
    --human-interaction approval --output "$gate_root/human.json" >/dev/null
treasurer="$(admit "$gate_root/human.json")"

paid_iface() { # <id> <route> <outfile>
    "$binary" interface describe "$base/$2?text={input}" --kind http --id "$1" \
        --method GET --non-mutating --response-encoding json --response-field result \
        --economics x402 --payment-adapter "$wallet" \
        --payment-approval-interface "$treasurer" --output "$3" >/dev/null
}

# ---------------------------------------------------------------------------
# 1. An economic profile is incomplete without an adapter and an approver.
# ---------------------------------------------------------------------------
out="$("$binary" interface describe "$base/paid/answer?text={input}" --kind http --id api/nogate \
    --method GET --non-mutating --response-encoding json --response-field result \
    --economics x402 --output "$gate_root/nogate.json" 2>&1 || true)"
case "$out" in
    *InterfacePaymentProfileIncomplete*) ;;
    *) fail "a paid interface with no adapter or approver was describable: $out" ;;
esac

# ---------------------------------------------------------------------------
# 2. Admission does not require paying: being challenged is correct behaviour.
# ---------------------------------------------------------------------------
paid_iface api/paid paid/answer "$gate_root/paid.json"
"$binary" interface test "$gate_root/paid.json" >"$gate_root/battery.txt"
grep -q "payment-challenged" "$gate_root/battery.txt" ||
    fail "the battery did not record that the paid boundary challenged an unpaid probe"
[ "$(signatures)" = "0" ] || fail "admission testing signed a payment"
[ "$(charges /paid/answer)" = "0" ] || fail "admission testing paid the resource"
paid="$(admit "$gate_root/paid.json")"

# ---------------------------------------------------------------------------
# 3. With no declared policy nothing may be spent.
# ---------------------------------------------------------------------------
out="$("$binary" interface call "$node_dir" --interface "$paid" --input "hello" 2>&1 || true)"
case "$out" in
    *InterfacePaymentProfileIncomplete*) ;;
    *) fail "a paid call proceeded with no spending policy: $out" ;;
esac
[ "$(signatures)" = "0" ] || fail "a call with no policy reached the wallet"
[ "$(charges /paid/answer)" = "0" ] || fail "a call with no policy paid the resource"

cat > "$gate_root/policy.json" <<'EOF'
{"schema":"neuron.spending-policy/v1",
 "max_per_call_micros":5000,
 "cumulative_budget_micros":10000,
 "approval_threshold_micros":3000,
 "allowed_assets":["USDC"],
 "allowed_networks":["base-sepolia"]}
EOF
"$binary" interface policy "$node_dir" "$gate_root/policy.json" >/dev/null

# ---------------------------------------------------------------------------
# 4. An under-budget, under-threshold call pays once and returns the result.
# ---------------------------------------------------------------------------
answer="$("$binary" interface call "$node_dir" --interface "$paid" --input "hello" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["output"])')"
[ "$answer" = "HELLO" ] || fail "the paid resource did not return its typed result: $answer"
[ "$(charges /paid/answer)" = "1" ] || fail "an under-budget call did not pay exactly once"
[ "$(signatures)" = "1" ] || fail "expected exactly one signature, got $(signatures)"
[ "$(receipts)" = "1" ] || fail "expected exactly one durable payment receipt"

# The receipt records the payment separately from the resource answer, and
# carries what was actually agreed.
python3 - "$node_dir" <<'PY'
import json, os, sys
log = os.path.join(sys.argv[1], "state", "substrate.log")
found = None
with open(log) as fh:
    for line in fh:
        try:
            d = json.loads(line)
        except Exception:
            continue
        for art in (d.get("artifacts") or []):
            if art.get("id", "").startswith("interfaces/payments/"):
                # Artifact bodies are hex-encoded in the WAL.
                found = json.loads(bytes.fromhex(art["bytes"]).decode())
assert found, "no payment receipt body recorded"
assert found["schema"] == "neuron.payment-receipt/v1", found
assert found["amount_micros"] == 1500, found
assert found["asset"] == "USDC", found
assert found["approval_required"] is False, found
assert found["payment_payload"].startswith("paid:"), found
PY

# ---------------------------------------------------------------------------
# 5. A retry does not repay.
# ---------------------------------------------------------------------------
"$binary" interface call "$node_dir" --interface "$paid" --input "hello" --json >/dev/null
"$binary" interface call "$node_dir" --interface "$paid" --input "hello" --json >/dev/null
[ "$(charges /paid/answer)" = "1" ] || fail "a retry repaid the resource"
[ "$(signatures)" = "1" ] || fail "a retry asked the wallet to sign again"
[ "$(receipts)" = "1" ] || fail "a retry recorded a second payment receipt"

# ---------------------------------------------------------------------------
# 6. Over-budget and unacceptable quotes never reach the wallet.
# ---------------------------------------------------------------------------
signatures_before="$(signatures)"

paid_iface api/expensive expensive/answer "$gate_root/expensive.json"
expensive="$(admit "$gate_root/expensive.json")"
out="$("$binary" interface call "$node_dir" --interface "$expensive" --input "hello" 2>&1 || true)"
case "$out" in
    *InterfacePaymentUnaffordable*) ;;
    *) fail "an over-per-call-budget quote was not refused: $out" ;;
esac

paid_iface api/foreign foreign/answer "$gate_root/foreign.json"
foreign="$(admit "$gate_root/foreign.json")"
out="$("$binary" interface call "$node_dir" --interface "$foreign" --input "hello" 2>&1 || true)"
case "$out" in
    *InterfacePaymentUnacceptable*) ;;
    *) fail "a quote in a disallowed asset was not refused: $out" ;;
esac

[ "$(signatures)" = "$signatures_before" ] || fail "a refused quote still reached the wallet"
[ "$(charges /expensive/answer)" = "0" ] || fail "an over-budget resource was paid"
[ "$(charges /foreign/answer)" = "0" ] || fail "a disallowed-asset resource was paid"

# ---------------------------------------------------------------------------
# 7. At or above the approval threshold, a human must approve *this* quote.
# ---------------------------------------------------------------------------
paid_iface api/dear dear/answer "$gate_root/dear.json"
dear="$(admit "$gate_root/dear.json")"

out="$("$binary" interface call "$node_dir" --interface "$dear" --input "hello" 2>&1 || true)"
case "$out" in
    *InterfacePaymentUnapproved*) ;;
    *) fail "a quote above the approval threshold proceeded unapproved: $out" ;;
esac
[ "$(signatures)" = "$signatures_before" ] || fail "an unapproved quote reached the wallet"
[ "$(charges /dear/answer)" = "0" ] || fail "an unapproved quote was paid"

# An approval of a *different* quote does not authorize this one. The quote
# digest is over the exact challenge bytes the resource served.
dear_challenge="$(curl -s "$base/dear/answer?text=hello")"
dear_digest="$(sha "$dear_challenge")"
other_digest="$(sha "a different quote entirely")"
cat > "$inbox/$dear_digest.json" <<EOF
{"schema":"neuron.human-decision/v1","subject":"$other_digest","decision":"approve","note":"approves another quote"}
EOF
out="$("$binary" interface call "$node_dir" --interface "$dear" --input "hello" 2>&1 || true)"
case "$out" in
    *InterfacePaymentUnapproved*) ;;
    *) fail "an approval naming a different quote authorized this one: $out" ;;
esac
[ "$(signatures)" = "$signatures_before" ] || fail "a misbound approval reached the wallet"

# An explicit refusal is still not an authorization.
cat > "$inbox/$dear_digest.json" <<EOF
{"schema":"neuron.human-decision/v1","subject":"$dear_digest","decision":"reject","note":"too dear"}
EOF
out="$("$binary" interface call "$node_dir" --interface "$dear" --input "hello" 2>&1 || true)"
case "$out" in
    *InterfacePaymentUnapproved*) ;;
    *) fail "a refused quote was paid anyway: $out" ;;
esac
[ "$(charges /dear/answer)" = "0" ] || fail "a refused quote was paid"

# Approved, bound to this exact quote: now it may be signed and paid.
cat > "$inbox/$dear_digest.json" <<EOF
{"schema":"neuron.human-decision/v1","subject":"$dear_digest","decision":"approve","note":"treasurer cleared"}
EOF
answer="$("$binary" interface call "$node_dir" --interface "$dear" --input "hello" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["output"])')"
[ "$answer" = "HELLO" ] || fail "the approved paid call did not return its result: $answer"
[ "$(charges /dear/answer)" = "1" ] || fail "the approved call did not pay exactly once"
[ "$(signatures)" -gt "$signatures_before" ] || fail "the approved call never reached the wallet"

# ---------------------------------------------------------------------------
# 8. The cumulative budget is enforced from the durable receipts.
# ---------------------------------------------------------------------------
# 1500 + 4000 spent; the budget is 10000 and the per-call ceiling 5000, so a
# further 4000 quote fits per-call but must eventually exhaust the budget.
cat > "$gate_root/tight.json" <<'EOF'
{"schema":"neuron.spending-policy/v1",
 "max_per_call_micros":5000,
 "cumulative_budget_micros":5000,
 "approval_threshold_micros":3000,
 "allowed_assets":["USDC"],
 "allowed_networks":["base-sepolia"]}
EOF
"$binary" interface policy "$node_dir" "$gate_root/tight.json" >/dev/null
signatures_tight="$(signatures)"
paid_iface api/paid2 paid/answer "$gate_root/paid2.json"
paid2="$(admit "$gate_root/paid2.json")"
out="$("$binary" interface call "$node_dir" --interface "$paid2" --input "another" 2>&1 || true)"
case "$out" in
    *InterfacePaymentUnaffordable*) ;;
    *) fail "a call exceeding the cumulative budget was not refused: $out" ;;
esac
[ "$(signatures)" = "$signatures_tight" ] || fail "a budget-exhausted call reached the wallet"

# ---------------------------------------------------------------------------
# 9. Payment success is not resource correctness: a rejected proof is its own
#    typed condition, distinguishable from a challenge.
# ---------------------------------------------------------------------------
"$binary" interface policy "$node_dir" "$gate_root/policy.json" >/dev/null
paid_iface api/wrong wrong/answer "$gate_root/wrong.json"
wrong="$(admit "$gate_root/wrong.json")"
out="$("$binary" interface call "$node_dir" --interface "$wrong" --input "hello" 2>&1 || true)"
case "$out" in
    *InterfacePaymentProofRejected*) ;;
    *) fail "a resource that refused the proof was not reported as such: $out" ;;
esac

# ---------------------------------------------------------------------------
# 10. An economic profile does not force payment where none is demanded.
# ---------------------------------------------------------------------------
signatures_free="$(signatures)"
paid_iface api/free free/answer "$gate_root/free.json"
free="$(admit "$gate_root/free.json")"
answer="$("$binary" interface call "$node_dir" --interface "$free" --input "hello" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["output"])')"
[ "$answer" = "HELLO" ] || fail "an unchallenged paid-profile call did not return its result: $answer"
[ "$(signatures)" = "$signatures_free" ] || fail "an unchallenged call signed a payment anyway"

echo "paid-interface gate: PASS"
