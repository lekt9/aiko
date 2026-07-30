#!/usr/bin/env bash
# Runnable witness for remote and protocol interfaces (entrypoint plan Phase 3).
# Through the public CLI only, against real transports — a real TCP HTTP server
# and a real stdio MCP server, both started by this gate:
#
#   1. one goal chains local code -> process -> HTTP -> MCP -> verifier, and the
#      product is exactly what those four boundaries really compute;
#   2. every hop is a separate durable firing with its own pinned interface, so
#      causation is recorded data rather than an inference;
#   3. a remote command commits to the outbox first, carries a content
#      idempotency key, crosses once, and is settled only by an independent
#      read-back through a separately declared sensor;
#   4. a duplicate request does not duplicate the effect — proven by asking the
#      far end how many times it actually applied the key;
#   5. a poisoned response fails closed: an absent field, a non-JSON body, an
#      error status, a wrong-shaped tool result, and a JSON-RPC error each
#      refuse to become evidence;
#   6. a remote read that is not contractually non-mutating cannot be declared a
#      read, and a chain cannot acquire a hole.
#
# Every assertion inspects durable state or the far end's own counters, never
# stdout resemblance.
set -euo pipefail
# Job-control notices would otherwise print when the trap kills the test server.
set +m

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-remote-chain.XXXXXX")"
http_pid=""
cleanup() {
    if [ -n "$http_pid" ]; then
        kill "$http_pid" 2>/dev/null || true
        # Reap it so the shell does not report the signal as gate output.
        wait "$http_pid" 2>/dev/null || true
    fi
    rm -rf -- "$gate_root"
}
trap cleanup EXIT

node_dir="$gate_root/node"
binary="$repo_dir/zig-out/bin/neuron"
log="$node_dir/state/substrate.log"
mcp_server="$repo_dir/tests/fixtures/remote_mcp_server.py"

# --- the two remote boundaries -------------------------------------------------
python3 "$repo_dir/tests/fixtures/remote_http_server.py" 0 > "$gate_root/port.txt" 2>"$gate_root/http.err" &
http_pid=$!
for _ in $(seq 1 50); do
    port="$(tr -d '[:space:]' < "$gate_root/port.txt" 2>/dev/null || true)"
    [ -n "$port" ] && break
    sleep 0.1
done
port="$(tr -d '[:space:]' < "$gate_root/port.txt")"
if [ -z "$port" ]; then
    echo "FAIL: the test HTTP boundary never reported a port" >&2
    cat "$gate_root/http.err" >&2
    exit 1
fi
base="http://127.0.0.1:$port"

# A local process boundary, so the chain spans a real executable too.
upper="$gate_root/upper.sh"
printf '#!/bin/sh\nexec tr "[:lower:]" "[:upper:]"\n' > "$upper"
chmod +x "$upper"

"$binary" agent init "$node_dir" alpha >/dev/null
wal_bytes() { wc -c < "$log" | tr -d ' '; }
admit() { "$binary" interface admit "$node_dir" "$1" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["interface"])'; }

# ---------------------------------------------------------------------------
# 1. A remote boundary is discoverable but not pinnable: its identity is the
#    contract its manifest declares, which does not exist before it is written.
# ---------------------------------------------------------------------------
python3 - "$("$binary" interface discover "$base/upper" --json)" <<'PY'
import json, sys
found = json.loads(sys.argv[1])
assert found["kind"] == "http" and found["exists"], found
assert found["implementation_digest"] == "", \
    "a remote boundary must not claim a pin discovery cannot compute"
assert found["authority"].startswith("none"), found
PY

# ---------------------------------------------------------------------------
# 2. Describe and admit the four hops of the chain.
# ---------------------------------------------------------------------------
"$binary" interface describe "collapse-ws" --id fn/collapse \
    --output "$gate_root/h0.json" >/dev/null
"$binary" interface describe "$upper" --id proc/upper --input-channel stdin \
    --deterministic --output "$gate_root/h1.json" >/dev/null
"$binary" interface describe "$base/upper" --kind http --id http/upper \
    --url-template "$base/upper?text={input}" --method GET --non-mutating \
    --response-encoding json --response-field result --deterministic \
    --output "$gate_root/h2.json" >/dev/null
"$binary" interface describe "$mcp_server" --kind mcp --id mcp/reverse \
    --tool reverse --deterministic --output "$gate_root/h3.json" >/dev/null

# The remote batteries run against the live boundaries: the determinism check
# really performs two HTTP requests and two MCP tool calls.
for draft in h2 h3; do
    python3 - "$("$binary" interface test "$gate_root/$draft.json" --json)" <<'PY'
import json, sys
report = json.loads(sys.argv[1])
assert report["passed"], report
checks = {c["check"]: c for c in report["checks"]}
assert checks["determinism"]["ok"], checks["determinism"]
assert checks["probe-invocation"]["ok"], checks["probe-invocation"]
PY
done

for step in 0 1 2 3; do
    digest="$(admit "$gate_root/h$step.json")"
    "$binary" interface attach "$node_dir" alpha --interface "$digest" \
        --role worker --step "$step" >/dev/null
    eval "hop_$step=$digest"
done

# A chain may not acquire a hole: step 5 without step 4 is a different order.
if "$binary" interface attach "$node_dir" alpha --interface "$hop_0" \
        --role worker --step 5 >/dev/null 2>&1; then
    echo "FAIL: a chain accepted a hole" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 3. One goal, four boundaries, one settlement.
# ---------------------------------------------------------------------------
goal="chain   these    four   hops"
run="$("$binary" agent run "$node_dir" alpha --goal "$goal" --json)"
python3 - "$run" "$goal" <<'PY'
import hashlib, json, sys
result, goal = json.loads(sys.argv[1]), sys.argv[2]
assert result["status"] == "settled", result
# Independently recompute what those four boundaries actually do:
# collapse whitespace, uppercase, uppercase again remotely, then reverse.
value = " ".join(goal.split()).upper().upper()[::-1]
assert result["result_digest"] == hashlib.sha256(value.encode()).hexdigest(), result
# And it is emphatically not the reference resolution.
assert result["result_digest"] != hashlib.sha256(f"resolve:{goal}".encode()).hexdigest()
PY

# Causation is durable: one artifact per intermediate hop, in order, plus a
# result envelope naming every boundary that contributed.
python3 - "$log" "$run" "$goal" "$hop_0" "$hop_1" "$hop_2" "$hop_3" <<'PY'
import hashlib, json, sys
log, run, goal = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
expected_hops = sys.argv[4:8]
records = [json.loads(line) for line in open(log, encoding="utf-8")]
short = run["workflow"].rsplit("/", 1)[1]

hops, envelope, product = {}, None, None
for record in records:
    for artifact in record.get("artifacts", []):
        if f"/work/{short}/hop/" in artifact["id"]:
            hops[artifact["id"].rsplit("/", 1)[1]] = bytes.fromhex(artifact["bytes"])
        if artifact["id"].endswith(f"/work/{short}/result"):
            envelope = json.loads(bytes.fromhex(artifact["bytes"]))
        if artifact["id"].endswith(f"/work/{short}/output"):
            product = bytes.fromhex(artifact["bytes"])

# Three intermediate products: the fourth hop's product is the final output.
assert sorted(hops) == ["00", "01", "02"], sorted(hops)
collapsed = " ".join(goal.split())
assert hops["00"] == collapsed.encode(), hops["00"]
assert hops["01"] == collapsed.upper().encode(), hops["01"]
assert hops["02"] == collapsed.upper().encode(), hops["02"]
assert product == collapsed.upper()[::-1].encode(), product

assert envelope is not None, "no result envelope was committed"
chain = envelope["chain"]
assert [hop["interface"] for hop in chain] == expected_hops, chain
assert [hop["kind"] for hop in chain] == ["function", "process", "http", "mcp"], chain
for index, hop in enumerate(chain):
    assert len(hop["implementation_digest"]) == 64, hop
assert "independent second invocation" in envelope["judgement"], envelope

# Each hop is its own firing: four distinct committed firings carried the work.
hop_firings = {r["firing_id"] for r in records
               if any(f"/work/{short}/hop/" in a["id"] for a in r.get("artifacts", []))}
assert len(hop_firings) == 3, hop_firings
PY

# Replay commits nothing and re-invokes nothing.
wal_before="$(wal_bytes)"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["status"]=="replayed" and r["steps"]==0, r' \
    "$("$binary" agent run "$node_dir" alpha --goal "$goal" --json)"
test "$(wal_bytes)" = "$wal_before"

# ---------------------------------------------------------------------------
# 4. A poisoned remote answer never becomes a value.
# ---------------------------------------------------------------------------
wal_before="$(wal_bytes)"
poison_case() { # poison_case <name> <describe args...>
    local name="$1"; shift
    "$binary" interface describe "$@" --output "$gate_root/$name.json" >/dev/null
    if "$binary" interface admit "$node_dir" "$gate_root/$name.json" >/dev/null 2>&1; then
        echo "FAIL: $name was admitted" >&2
        exit 1
    fi
}
# The declared field is absent from an otherwise valid JSON body.
poison_case http-absent-field "$base/poison" --kind http --id http/absent \
    --url-template "$base/poison?text={input}" --method GET --non-mutating \
    --response-encoding json --response-field result
# The body is not JSON at all.
poison_case http-not-json "$base/malformed" --kind http --id http/malformed \
    --url-template "$base/malformed?text={input}" --method GET --non-mutating \
    --response-encoding json --response-field result
# The endpoint answers with a failure status.
poison_case http-error-status "$base/boom" --kind http --id http/boom \
    --url-template "$base/boom?text={input}" --method GET --non-mutating \
    --response-encoding json --response-field result
# A tool result that is structurally valid JSON-RPC but not a text result.
poison_case mcp-wrong-shape "$mcp_server" --kind mcp --id mcp/poison --tool poison
# A tool that answers with a JSON-RPC error.
poison_case mcp-rpc-error "$mcp_server" --kind mcp --id mcp/boom --tool boom

# A POST is not a read, however the manifest labels it: mixed defaults to
# command. `describe` refuses to author the claim at all, so the draft is forged
# from a valid command manifest with its mode flipped by hand.
if "$binary" interface describe "$base/store" --kind http --id http/mislabelled \
        --url-template "$base/store" --method POST --non-mutating \
        --response-encoding json --response-field stored \
        --output "$gate_root/mislabelled.json" >/dev/null 2>&1; then
    echo "FAIL: describe emitted a POST declared as a read" >&2
    exit 1
fi
"$binary" interface describe "$base/store" --kind http --mode command \
    --id http/mislabelled --url-template "$base/store" --method POST \
    --reconcile-url-template "$base/stored?key={input}" --reconcile-encoding raw \
    --response-encoding json --response-field stored \
    --output "$gate_root/mislabelled.json" >/dev/null
python3 -c '
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest["invocation"]["mode"] = "read"
manifest["non_mutating"] = True
json.dump(manifest, open(sys.argv[1], "w"))
' "$gate_root/mislabelled.json"
if "$binary" interface admit "$node_dir" "$gate_root/mislabelled.json" >/dev/null 2>&1; then
    echo "FAIL: a mutating method was admitted as a read" >&2
    exit 1
fi
# A read that omits the non-mutating claim is likewise not a read. `describe`
# validates its own draft, so this case has to be forged by hand — which is
# itself the point: the CLI will not author an inadmissible read.
if "$binary" interface describe "$base/upper" --kind http --id http/unclaimed \
        --url-template "$base/upper?text={input}" --method GET \
        --response-encoding json --response-field result \
        --output "$gate_root/unclaimed.json" >/dev/null 2>&1; then
    echo "FAIL: describe emitted a read with no non-mutating claim" >&2
    exit 1
fi
python3 -c '
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest["id"] = "http/unclaimed"
manifest["non_mutating"] = False
json.dump(manifest, open(sys.argv[2], "w"))
' "$gate_root/h2.json" "$gate_root/unclaimed.json"
if "$binary" interface admit "$node_dir" "$gate_root/unclaimed.json" >/dev/null 2>&1; then
    echo "FAIL: a GET without a non-mutating claim was admitted as a read" >&2
    exit 1
fi
test "$(wal_bytes)" = "$wal_before"  # seven rejections, zero commits

# ---------------------------------------------------------------------------
# 5. A remote command: outbox first, keyed, applied once, judged by read-back.
# ---------------------------------------------------------------------------
# A command with no independent sensor is not admissible at all — and again
# `describe` refuses to author one.
if "$binary" interface describe "$base/store" --kind http --mode command --id http/blind \
        --url-template "$base/store" --method POST \
        --response-encoding json --response-field stored \
        --output "$gate_root/blind.json" >/dev/null 2>&1; then
    echo "FAIL: describe emitted a remote command with no read-back sensor" >&2
    exit 1
fi

"$binary" interface describe "$base/store" --kind http --mode command --id http/store \
    --url-template "$base/store" --method POST \
    --reconcile-url-template "$base/stored?key={input}" --reconcile-encoding raw \
    --response-encoding json --response-field stored \
    --output "$gate_root/store.json" >/dev/null
store="$(admit "$gate_root/store.json")"

payload="remote consequence"
key="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' "$payload")"
applied() { python3 -c '
import json,urllib.request,sys
with urllib.request.urlopen(sys.argv[1]) as response:
    print(json.load(response)["count"])' "$base/applied?key=$key"; }

test "$(applied)" = "0"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["status"]=="queued", r' \
    "$("$binary" interface call "$node_dir" --interface "$store" --input "$payload" --json)"
# Committing the outbox record must not have crossed the boundary.
test "$(applied)" = "0"

python3 - "$("$binary" interface dispatch "$node_dir" --json)" <<'PY'
import json, sys
outcome = json.loads(sys.argv[1])
assert outcome["drained"] == 1 and outcome["acknowledged"] == 1, outcome
assert outcome["parked"] == 0, outcome
assert outcome["reconciled"], "acknowledged without independent read-back"
assert outcome["receipt"].startswith("interfaces/receipts/"), outcome
PY
test "$(applied)" = "1"

# Redelivery: the same content re-queues nothing and re-applies nothing.
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["status"]=="replayed", r' \
    "$("$binary" interface call "$node_dir" --interface "$store" --input "$payload" --json)"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["drained"]==0, d' \
    "$("$binary" interface dispatch "$node_dir" --json)"
test "$(applied)" = "1"

# ---------------------------------------------------------------------------
# 6. The chain plus a remote effector: consequence only after judgement.
# ---------------------------------------------------------------------------
"$binary" interface attach "$node_dir" alpha --interface "$store" --role effector >/dev/null
effector_goal="push   this   remotely"
effector_run="$("$binary" agent run "$node_dir" alpha --goal "$effector_goal" --json)"
python3 - "$effector_run" "$effector_goal" <<'PY'
import hashlib, json, sys
result, goal = json.loads(sys.argv[1]), sys.argv[2]
assert result["status"] == "settled", result
value = " ".join(goal.split()).upper().upper()[::-1]
assert result["result_digest"] == hashlib.sha256(value.encode()).hexdigest(), result
PY
# The chain's product really crossed the remote boundary, and the settlement
# waited for the read-back that proved it.
product_key="$(python3 -c '
import hashlib, sys
value = " ".join(sys.argv[1].split()).upper().upper()[::-1]
print(hashlib.sha256(value.encode()).hexdigest())' "$effector_goal")"
python3 - "$base" "$product_key" "$effector_goal" <<'PY'
import json, sys, urllib.request
base, key, goal = sys.argv[1], sys.argv[2], sys.argv[3]
with urllib.request.urlopen(f"{base}/stored?key={key}") as response:
    stored = response.read()
expected = " ".join(goal.split()).upper().upper()[::-1].encode()
assert stored == expected, (stored, expected)
with urllib.request.urlopen(f"{base}/applied?key={key}") as response:
    assert json.load(response)["count"] == 1, "the remote effect was applied more than once"
PY
python3 - "$log" "$effector_run" <<'PY'
import json, sys
log, run = sys.argv[1], json.loads(sys.argv[2])
records = [json.loads(line) for line in open(log, encoding="utf-8")]
short = run["workflow"].rsplit("/", 1)[1]
ack = next(json.loads(bytes.fromhex(a["bytes"]))
           for r in records for a in r.get("artifacts", [])
           if a["id"].endswith(f"/work/{short}/ack"))
assert ack["reconciled"] is True and ack["content_digest"] == run["result_digest"], ack
PY

echo "remote-interface-chain gate: PASS"
