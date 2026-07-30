#!/usr/bin/env bash
# Runnable witness for the live observability edge (§28.3). From an empty
# directory, through the public CLI only:
#
#   1. the page, the bootstrap, and the event stream are served;
#   2. firings committed by a *different process* appear on the stream while it
#      is open — this is a live tail of the journal, not a poll of derived state;
#   3. the observer never takes the substrate's exclusive lock, so a node keeps
#      committing while it is watched;
#   4. artifact payloads never cross the wire. The gate writes a recognisable
#      secret into an artifact, confirms it really is in the journal, and then
#      proves it cannot be read back out of any endpoint — in plain form or hex;
#   5. binding off-loopback fails closed unless explicitly allowed.
#
# Assertion 4 is the one that must never regress: an observability port that
# streams payloads is an exfiltration surface, and the journal is hex so a naive
# "does it contain the string" check would miss it. Both encodings are tested.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-observe-live.XXXXXX")"
binary="$repo_dir/zig-out/bin/neuron"
node="$gate_root/node"
srv=""
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; rm -rf -- "$gate_root"; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# A free-ish high port; the gate is loopback-only so collisions are the only risk.
port="$(python3 -c '
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"

"$binary" agent init "$node" watched >/dev/null
"$binary" agent run "$node" watched --goal "before the observer" --json >/dev/null

"$binary" telemetry serve "$node/state" --listen "127.0.0.1:$port" >"$gate_root/serve.log" 2>&1 &
srv=$!
for _ in $(seq 1 40); do
    curl -s -o /dev/null "http://127.0.0.1:$port/" && break
    sleep 0.25
done

# --- 1. the three surfaces answer -----------------------------------------
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")"
[ "$code" = "200" ] || fail "page did not serve (HTTP $code)"
boot="$(curl -s "http://127.0.0.1:$port/graph")"
python3 -c '
import json, sys
d = json.loads(sys.argv[1])
assert d["firings"], "bootstrap carried no firings"
' "$boot" || fail "bootstrap malformed or empty"

# --- 2. a live tail, driven by another process ----------------------------
curl -sN --max-time 10 "http://127.0.0.1:$port/events" >"$gate_root/sse.txt" &
sse=$!
sleep 1.5
before="$(grep -c '^data:' "$gate_root/sse.txt" || true)"
"$binary" agent run "$node" watched --goal "fired while streaming" --json >/dev/null
sleep 2.5
after="$(grep -c '^data:' "$gate_root/sse.txt" || true)"
wait $sse 2>/dev/null || true
[ "$after" -gt "$before" ] ||
    fail "no events arrived for a firing committed while the stream was open ($before → $after)"

# --- 3. the observer holds no lock ----------------------------------------
"$binary" agent run "$node" watched --goal "written while observed" --json >/dev/null ||
    fail "the node could not commit while being observed: the reader took the lock"

# --- 4. payloads never cross the wire -------------------------------------
secret="SUPERSECRET-TOKEN-a1b2c3"
printf '#!/bin/sh\necho "%s"\n' "$secret" > "$gate_root/leak.sh"
chmod +x "$gate_root/leak.sh"
"$binary" interface describe "$gate_root/leak.sh" --kind process --id proc/leak \
    --input-channel stdin --deterministic --output "$gate_root/leak.json" >/dev/null
digest="$(python3 -c '
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$gate_root/leak.json")"
"$binary" interface admit "$node" "$gate_root/leak.json" >/dev/null
"$binary" interface attach "$node" watched --interface "$digest" --role worker --replace >/dev/null
"$binary" agent run "$node" watched --goal "produce a secret" --json >/dev/null

hex_secret="$(printf '%s' "$secret" | xxd -p | tr -d '\n')"
grep -q "$hex_secret" "$node/state/substrate.log" ||
    fail "the secret never reached the journal: assertion 4 would pass vacuously"

for route in "/graph" "/"; do
    body="$(curl -s "http://127.0.0.1:$port$route")"
    case "$body" in
        *"$secret"*) fail "artifact payload leaked in plain form on $route" ;;
    esac
    case "$body" in
        *"$hex_secret"*) fail "artifact payload leaked in hex on $route" ;;
    esac
done
curl -sN --max-time 4 "http://127.0.0.1:$port/events" >"$gate_root/sse2.txt" || true
case "$(cat "$gate_root/sse2.txt")" in
    *"$secret"*|*"$hex_secret"*) fail "artifact payload leaked on the event stream" ;;
esac
# Sizes must survive: the point is redaction, not blindness.
curl -s "http://127.0.0.1:$port/graph" > "$gate_root/g.json"
python3 "$repo_dir/tests/_observe_sizes.py" "$gate_root/g.json" ||
    fail "redaction removed more than payloads"

kill "$srv" 2>/dev/null; srv=""

# --- 5. off-loopback fails closed -----------------------------------------
if "$binary" telemetry serve "$node/state" --listen "0.0.0.0:$port" >/dev/null 2>&1; then
    fail "binding 0.0.0.0 was accepted without --allow-public"
fi

echo "observe-live gate: PASS"
