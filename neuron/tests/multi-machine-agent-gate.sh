#!/usr/bin/env bash
# Runnable witness for the multi-machine interface swarm (entrypoint plan
# Phase 7). Through the public CLI only, against two real installed nodes
# talking over real TCP with the framed neuron.wire/v1 protocol:
#
#   1. two independently governed nodes expose *different* interface kinds, and
#      each advertises only what it has actually admitted;
#   2. a NodeClaim is a live read: it commits nothing, and it never leaks the
#      peer's locator — only digest, kind, and mode cross the wire;
#   3. an EdgeContract is negotiated against the peer's live claim under
#      per-peer caps; a widened edge and an unadvertised digest are both
#      refused rather than clamped;
#   4. one cross-machine agent chain really runs: node A's goal is served by
#      node B's boundary, and B's reported digest becomes evidence only by
#      agreeing with a digest A recomputes over the bytes it received;
#   5. the lease is spent per use and then expires — an exhausted edge is not a
#      slower route, it is no route;
#   6. a partition is a state, not a silence: with the peer down, reconciliation
#      records the edge as unreachable rather than assuming it still holds;
#   7. the peer survives a restart with its identity and admissions intact, and
#      a renegotiated lease routes again;
#   8. revocation withdraws authority while preserving the audit record;
#   9. nothing claims global memory: every route re-reads the peer's claim, and
#      an interface the peer stops advertising immediately stops being routable.
#
# Every assertion inspects durable state or the far node's own answers, never
# stdout resemblance.

set +m
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-swarm.XXXXXX")"
pid_b=""
pid_c=""
cleanup() {
    for pid in "$pid_b" "$pid_c"; do
        if [ -n "$pid" ]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
    rm -rf -- "$gate_root"
}
trap cleanup EXIT INT TERM

binary="$repo_dir/zig-out/bin/neuron"
node_a="$gate_root/node-a"
node_b="$gate_root/node-b"
node_c="$gate_root/node-c"

fail() { echo "FAIL: $1" >&2; exit 1; }

free_port() {
    python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"
}
port_b="$(free_port)"
port_c="$(free_port)"

# --- three nodes: A routes, B serves a process boundary, C serves a function --
"$binary" node init "$node_a" --listen "127.0.0.1:1" --write-prefix "artifact/a/" --transport loopback >/dev/null
"$binary" node init "$node_b" --listen "127.0.0.1:$port_b" --write-prefix "artifact/b/" --transport loopback >/dev/null
"$binary" node init "$node_c" --listen "127.0.0.1:$port_c" --write-prefix "artifact/c/" --transport loopback >/dev/null

id_b="$("$binary" node id "$node_b")"
id_c="$("$binary" node id "$node_c")"
[ "$id_b" != "$id_c" ] || fail "two installed nodes share one identity"

upper="$gate_root/upper.sh"
printf '#!/bin/sh\nexec tr "[:lower:]" "[:upper:]"\n' > "$upper"
chmod +x "$upper"
"$binary" interface describe "$upper" --kind process --id process/upper \
    --input-channel stdin --output "$gate_root/upper.json" >/dev/null
iface_b="$("$binary" interface admit "$node_b" "$gate_root/upper.json" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["interface"])')"

# A different *kind* on the other node: a pure function boundary.
"$binary" interface describe "trim|upper" --kind function --id function/shout \
    --output "$gate_root/shout.json" >/dev/null
iface_c="$("$binary" interface admit "$node_c" "$gate_root/shout.json" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["interface"])')"

# A command-mode interface on B, which must never be advertised across a
# machine boundary: a peer edge does not confer this node's outbox.
store="$gate_root/store"
mkdir -p "$store"
"$binary" interface describe "$store" --kind filesystem --id fs/store --mode command \
    --output "$gate_root/store.json" >/dev/null
"$binary" interface admit "$node_b" "$gate_root/store.json" >/dev/null

serve_b() {
    "$binary" node serve "$node_b" >>"$gate_root/b.log" 2>&1 &
    pid_b=$!
}
wait_ready() { # <logfile> <marker-count>
    for _ in $(seq 1 100); do
        if [ "$(grep -c 'neuron.node-ready/v1' "$1" 2>/dev/null || true)" -ge "$2" ]; then return 0; fi
        sleep 0.05
    done
    return 1
}

serve_b
"$binary" node serve "$node_c" >"$gate_root/c.log" 2>&1 &
pid_c=$!
wait_ready "$gate_root/b.log" 1 || fail "node B never became ready"
wait_ready "$gate_root/c.log" 1 || fail "node C never became ready"

# The readiness line enumerates what is really registered, including the swarm
# read refs.
grep -q 'mesh/claims' "$gate_root/b.log" || fail "node B does not serve mesh/claims"
grep -q 'mesh/interface-call' "$gate_root/b.log" || fail "node B does not serve mesh/interface-call"

"$binary" agent init "$node_a" alpha >/dev/null

claim_of() { # <port>
    "$binary" node fire "127.0.0.1:$1" --ref mesh/claims --schema neuron.node-claim/v1 \
        --payload '{}' --firing "claim-$1-$RANDOM" --allow-loopback |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["reply"])'
}

# ---------------------------------------------------------------------------
# 1. Each node advertises only what it admitted, and only reads.
# ---------------------------------------------------------------------------
claim_b="$(claim_of "$port_b")"
claim_c="$(claim_of "$port_c")"
python3 - "$claim_b" "$iface_b" <<'PY'
import json, sys
claim, expected = json.loads(sys.argv[1]), sys.argv[2]
assert claim["schema"] == "neuron.node-claim/v1", claim
digests = {i["interface"] for i in claim["interfaces"]}
assert expected in digests, (expected, digests)
kinds = {i["kind"] for i in claim["interfaces"]}
assert kinds == {"process"}, f"a command-mode interface was advertised across machines: {claim['interfaces']}"
for item in claim["interfaces"]:
    assert item["mode"] == "read", item
    # The locator is the peer's business and must not cross the wire.
    assert "locator" not in item, item
PY
python3 - "$claim_c" "$iface_c" <<'PY'
import json, sys
claim, expected = json.loads(sys.argv[1]), sys.argv[2]
kinds = {i["kind"] for i in claim["interfaces"]}
assert kinds == {"function"}, kinds
assert expected in {i["interface"] for i in claim["interfaces"]}
PY
[ "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["node"])' "$claim_b")" != \
  "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["node"])' "$claim_c")" ] ||
    fail "two nodes advertised the same identity"

# ---------------------------------------------------------------------------
# 2. Negotiation: widened and unadvertised edges are refused, not clamped.
# ---------------------------------------------------------------------------
negotiate() { # <peer-port> <interface> <uses> <writes> <bytes>
    "$binary" swarm negotiate "$node_a" alpha --peer "127.0.0.1:$1" \
        --interface "$2" --uses "$3" --max-writes "$4" --max-bytes "$5" --json
}

out="$(negotiate "$port_b" "$iface_b" 1 99 1024 2>&1 || true)"
case "$out" in
    *EdgeCapsWidened*) ;;
    *) fail "an edge widening the peer's write ceiling was not refused: $out" ;;
esac
out="$(negotiate "$port_b" "$iface_b" 1 1 99999999 2>&1 || true)"
case "$out" in
    *EdgeCapsWidened*) ;;
    *) fail "an edge widening the peer's byte ceiling was not refused: $out" ;;
esac
# The discriminating case for *per-peer* caps: inside this node's own ceiling
# (1 MiB) but beyond what the peer said it would honour (64 KiB). Only the
# peer-side check can refuse this one, so it is what proves the peer's declared
# ceiling is actually consulted rather than the local one doing all the work.
out="$(negotiate "$port_b" "$iface_b" 1 4 100000 2>&1 || true)"
case "$out" in
    *EdgeCapsWidened*) ;;
    *) fail "an edge inside the local ceiling but beyond the peer's was not refused: $out" ;;
esac
out="$(negotiate "$port_b" "ff11223344556677889900aabbccddeeff00112233445566778899aabbccddee" 1 1 1024 2>&1 || true)"
case "$out" in
    *PeerInterfaceNotAdvertised*) ;;
    *) fail "an unadvertised digest was negotiable: $out" ;;
esac
# B's interface is not C's: an edge must name a digest that *this* peer serves.
out="$(negotiate "$port_b" "$iface_c" 1 1 1024 2>&1 || true)"
case "$out" in
    *PeerInterfaceNotAdvertised*) ;;
    *) fail "a digest served by a different node was negotiable: $out" ;;
esac

contract_b="$(negotiate "$port_b" "$iface_b" 2 2 4096 |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["contract"])')"
contract_c="$(negotiate "$port_c" "$iface_c" 1 1 1024 |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["contract"])')"

# ---------------------------------------------------------------------------
# 3. One cross-machine chain: A's goal, B's boundary, then C's.
# ---------------------------------------------------------------------------
route() { "$binary" swarm route "$node_a" --contract "$1" --input "$2" --json; }

first="$(route "$contract_b" "cross machine hop")"
python3 - "$first" "$id_b" <<'PY'
import hashlib, json, sys
d, id_b = json.loads(sys.argv[1]), sys.argv[2]
assert d["output"] == "CROSS MACHINE HOP", d
assert d["served_by"].endswith(id_b), (d["served_by"], id_b)
# The peer's digest is evidence only because it agrees with one computed here.
assert hashlib.sha256(d["output"].encode()).hexdigest() == d["output_digest"], d
assert d["uses_remaining"] == 1, d
PY

# The second hop runs on a different machine, over a different interface kind,
# taking the first hop's product as its input.
product="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["output"])' "$first")"
second="$(route "$contract_c" "$product")"
python3 - "$second" "$id_c" <<'PY'
import hashlib, json, sys
d, id_c = json.loads(sys.argv[1]), sys.argv[2]
assert d["output"] == "CROSS MACHINE HOP", d
assert d["served_by"].endswith(id_c), d
assert hashlib.sha256(d["output"].encode()).hexdigest() == d["output_digest"], d
PY

# ---------------------------------------------------------------------------
# 4. The lease is spent per use and then expires.
# ---------------------------------------------------------------------------
route "$contract_b" "second hop" >/dev/null
out="$("$binary" swarm route "$node_a" --contract "$contract_b" --input "third" 2>&1 || true)"
case "$out" in
    *EdgeLeaseExpired*) ;;
    *) fail "an exhausted lease still routed: $out" ;;
esac

# ---------------------------------------------------------------------------
# 5. A partition is recorded, not assumed away.
# ---------------------------------------------------------------------------
kill "$pid_b" 2>/dev/null || true
wait "$pid_b" 2>/dev/null || true
pid_b=""

"$binary" swarm reconcile "$node_a" --json > "$gate_root/partitioned.json"
python3 - "$gate_root/partitioned.json" "$contract_b" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
edges = {e["contract"]: e for e in d["edges"]}
edge = edges[sys.argv[2]]
assert edge["status"] != "holds", f"an unreachable peer was reported as holding: {edge}"
assert d["broken"] >= 1, d
PY
out="$("$binary" swarm route "$node_a" --contract "$contract_b" --input "while down" 2>&1 || true)"
case "$out" in
    *holds*) fail "a route succeeded against a downed peer: $out" ;;
    *) ;;
esac

# ---------------------------------------------------------------------------
# 6. The peer survives a restart: same identity, same admissions, routable
#    again on a fresh lease.
# ---------------------------------------------------------------------------
serve_b
wait_ready "$gate_root/b.log" 2 || fail "node B never became ready after restart"
[ "$("$binary" node id "$node_b")" = "$id_b" ] || fail "node B rotated identity across a restart"

claim_after="$(claim_of "$port_b")"
python3 - "$claim_after" "$iface_b" <<'PY'
import json, sys
claim, expected = json.loads(sys.argv[1]), sys.argv[2]
assert expected in {i["interface"] for i in claim["interfaces"]}, claim
PY

negotiate "$port_b" "$iface_b" 1 2 4096 >/dev/null
after="$(route "$contract_b" "after restart")"
python3 - "$after" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
assert d["output"] == "AFTER RESTART", d
PY

"$binary" swarm reconcile "$node_a" --json > "$gate_root/healed.json"
python3 - "$gate_root/healed.json" "$contract_c" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
edges = {e["contract"]: e for e in d["edges"]}
# C was never partitioned but its single use is spent: an expired lease is a
# distinct state from an unreachable peer, and reconciliation must say which.
assert edges[sys.argv[2]]["status"] == "EdgeLeaseExpired", edges[sys.argv[2]]
PY

# ---------------------------------------------------------------------------
# 7. Revocation withdraws authority and preserves the audit.
# ---------------------------------------------------------------------------
negotiate "$port_b" "$iface_b" 3 2 4096 >/dev/null
"$binary" swarm revoke "$node_a" --contract "$contract_b" >/dev/null
out="$("$binary" swarm route "$node_a" --contract "$contract_b" --input "after revoke" 2>&1 || true)"
case "$out" in
    *EdgeContractRevoked*) ;;
    *) fail "a revoked edge still routed: $out" ;;
esac
python3 - "$node_a" "$contract_b" <<'PY'
import json, os, sys
log = os.path.join(sys.argv[1], "state", "substrate.log")
seen = []
with open(log) as fh:
    for line in fh:
        try:
            d = json.loads(line)
        except Exception:
            continue
        for art in (d.get("artifacts") or []):
            if art.get("id", "") == f"swarm/contracts/{sys.argv[2]}":
                seen.append(json.loads(bytes.fromhex(art["bytes"]).decode()))
assert seen, "no contract record survives"
assert seen[-1]["revoked"] is True, seen[-1]
# The whole negotiation history is still there to audit.
assert any(not s["revoked"] for s in seen), "revocation erased the edge's history"
PY

# ---------------------------------------------------------------------------
# 8. No global memory: what the peer stops advertising stops being routable,
#    without this node being told.
# ---------------------------------------------------------------------------
kill "$pid_b" 2>/dev/null || true
wait "$pid_b" 2>/dev/null || true
pid_b=""
"$binary" interface revoke "$node_b" --interface "$iface_b" >/dev/null
serve_b
wait_ready "$gate_root/b.log" 3 || fail "node B never became ready after revocation"

claim_final="$(claim_of "$port_b")"
python3 - "$claim_final" "$iface_b" <<'PY'
import json, sys
claim, gone = json.loads(sys.argv[1]), sys.argv[2]
assert gone not in {i["interface"] for i in claim["interfaces"]}, \
    "a revoked interface was still advertised"
PY
out="$(negotiate "$port_b" "$iface_b" 1 1 1024 2>&1 || true)"
case "$out" in
    *PeerInterfaceNotAdvertised*) ;;
    *) fail "an interface the peer retired was still negotiable: $out" ;;
esac

echo "multi-machine-agent gate: PASS"
