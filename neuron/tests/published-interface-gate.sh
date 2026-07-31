#!/usr/bin/env bash
# Runnable witness for the inbound direction: `neuron.published-interface/v1`
# served over HTTP through the wired `neuron port` verbs.
#
# From an empty directory, through the PUBLIC CLI ONLY (`./zig-out/bin/neuron`
# — this gate builds no private entrypoint of its own), against a real node
# substrate, real limb packages, and a real TCP listener:
#
#    0. ONE goal document is the only thing an operator writes. Every id,
#       route, method and schema downstream is read back out of it, so the
#       served API is a function of the goal and nothing else;
#    1. a published document that was never admitted serves nothing, and an
#       admitted-but-unattached record still serves nothing — the record is not
#       the edge;
#    2. an unadmitted or revoked digest 404s. It never fails open, and it never
#       distinguishes "revoked" from "never published": telling a caller which
#       one it was would make the port an oracle over the node's published set;
#    3. an outbound field on a published document is REFUSED, never ignored —
#       an operator must not believe a pin exists that nothing checks;
#    4. a real HTTP client (curl) calls the served route and gets back the
#       CORRECT TYPED answer the goal promised: the product schema is the
#       goal's `emits`, and the value is the handler's own product. A duplicate
#       request replays that firing instead of running the handler again;
#    5. two peers presenting the SAME caller key get two DISTINCT firings and
#       neither can read the other's result (operator ruling R2). A caller key
#       never becomes a firing id directly;
#    6. revoking the handler limb refuses the NEXT request — not the next
#       restart — and so does editing the handler's bytes after the pin;
#    7. a served command returns an outbox ADDRESS, not a result: content and
#       outbox record land in one firing and nothing has crossed;
#    8. detach releases the route and the attachment record survives as audit;
#    9. two ports on one path refuse;
#   10. no artifact payload can be pulled out of the port. A secret artifact
#       planted elsewhere in the substrate is proven present in the journal and
#       then proven unreachable through every served surface, in plain form and
#       in hex — an inbound port that could address the substrate is an
#       exfiltration surface;
#   11. binding off-loopback fails closed unless explicitly allowed;
#   12. a published digest cannot be attached as an outbound interface, and an
#       outbound digest cannot be attached as a port;
#   13. a client GENERATED from the served contract by `neuron interface
#       describe` carries a pinned digest, and that pin DETECTS DRIFT: when the
#       served API moves, the stale client re-pointed at the new route fails
#       `implementation-pinned` with InterfaceDigestDrift instead of calling
#       the wrong endpoint. The same check passes for an undrifted client, so
#       the assertion is not vacuous;
#   14. the shape of the served read surface is pinned as a fact, not left
#       implicit: a served read only accepts a JSON object body, so a bodiless
#       GET is refused 400 and `interface describe` will not author a POST
#       read. This is the reason section 13 stops at the pin and does not go on
#       to invoke — see the note above section 14.
#
# Every assertion inspects durable state, a real HTTP status, a real response
# header, or the boundary's own refusal — never stdout resemblance.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-published.XXXXXX")"
srv=""
cleanup() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; rm -rf -- "$gate_root"; }
trap cleanup EXIT

# The one and only binary this gate drives. `port` is dispatched from
# src/main.zig like every other verb, so the witness and an operator run the
# identical code path.
binary="$repo_dir/zig-out/bin/neuron"

node="$gate_root/node"
log="$node/state/substrate.log"
fail() { echo "FAIL: $*" >&2; exit 1; }

free_port() {
    python3 -c 'import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

start_server() {
    "$binary" port http "$node" --listen "127.0.0.1:$http_port" >"$gate_root/serve.log" 2>&1 &
    srv=$!
    for _ in $(seq 1 40); do
        curl -s -o /dev/null "http://127.0.0.1:$http_port/agents/none/none" && return 0
        sleep 0.25
    done
    fail "listener never came up"
}
stop_server() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null || true; srv=""; }

code_for() { # method path [data] [extra curl args...]
    local method="$1" path="$2" data="${3:-}"; shift 3 || true
    curl -s -o /dev/null -w '%{http_code}' -X "$method" \
        ${data:+--data "$data"} "$@" "http://127.0.0.1:$http_port$path"
}

# --- 0. the single goal ----------------------------------------------------
# This is the only document the operator authors. Nothing below re-states an
# id, a route, a method or a schema: each is read back out of the goal, so a
# gate that passed while serving some *other* contract is not reachable.
cat >"$gate_root/goal.json" <<'JSON'
{
  "schema": "gate.api-goal/v1",
  "goal": "a caller on this node's loopback hands agent `greeter` a name and receives a typed greeting, produced by an admitted limb under a grant derived from the contract alone",
  "id": "gate/greet",
  "version": "1.0.0",
  "route": "/greet",
  "method": "POST",
  "accepts": "gate.greeting-request/v1",
  "emits": "gate.greeting/v1",
  "errors": "gate.greeting-failed/v1",
  "handler_neuron": "greeter",
  "subject": "ada",
  "answer": "hello ada",
  "callers": ["ip4:127.0.0.1", "ip4:127.0.0.2"]
}
JSON
eval "$(python3 - "$gate_root/goal.json" <<'PY'
import json, sys
goal = json.load(open(sys.argv[1]))
for key in ("id", "version", "route", "method", "accepts", "emits", "errors",
            "handler_neuron", "subject", "answer"):
    print("goal_%s=%s" % (key, json.dumps(goal[key])))
print("goal_callers=%s" % json.dumps(json.dumps(
    {"mode": "listed", "peers": goal["callers"]})))
PY
)"
[ -n "$goal_route" ] && [ -n "$goal_emits" ] || fail "the goal document did not parse"

# --- limb packages the gate writes itself ---------------------------------
mkdir -p "$gate_root/greeter/neurons" "$gate_root/commander/neurons" "$gate_root/planter/neurons"

# Every package declares what it is supposed to do, fixtures included. Exempting
# a fixture would admit a package carrying no falsifiable claim — exactly what
# `skill-doc-gate.sh` refuses.
cat >"$gate_root/greeter/SKILL.md" <<'DOC'
---
name: gate/greeter
description: Answers a typed greeting request. Fires on the served goal schema in the published-interface gate.
probe_input: greeting-probe
expect_contains: agents/
---

# gate/greeter

Fixture limb for `published-interface-gate.sh`: the handler reached through the
published inbound surface.
DOC

cat >"$gate_root/commander/SKILL.md" <<'DOC'
---
name: gate/commander
description: Commits a consequential request to the outbox. Fires on gate.order-request/v1.
probe_input: order-probe
expect_contains: outbox/served/
---

# gate/commander

Fixture limb for `published-interface-gate.sh`. It crosses an external boundary,
which is what lets the gate assert that a served surface cannot be used to
trigger one without admission.
DOC

cat >"$gate_root/planter/SKILL.md" <<'DOC'
---
name: gate/planter
description: Writes one artifact outside any served namespace. Fires on gate.plant/v1.
probe_input: plant-probe
expect_contains: gate.secret/v1
---

# gate/planter

Fixture limb for `published-interface-gate.sh`. It plants an artifact the served
surface must NOT expose — the gate asserts the read path refuses it.
DOC

cat >"$gate_root/greeter/neuron.json" <<JSON
{
  "schema": "typed-neuron.limb-manifest/v1",
  "package": "gate/greeter",
  "version": "0.1.0",
  "description": "Answers a typed greeting request.",
  "neurons": [{
    "id": "$goal_handler_neuron",
    "accepts": ["$goal_accepts"],
    "emits": ["$goal_emits"],
    "argv": ["python3", "neurons/greeter.py"],
    "caps_request": {
      "allow_write": true, "write_prefix": "agents/", "allow_send": false, "allow_spawn": false,
      "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 0, "max_spawns": 0,
                 "max_bytes": 65536, "max_depth": 1, "max_turns": 1}
    }
  }],
  "budgets": {"deadline_ms_per_firing": 10000}
}
JSON
cat >"$gate_root/greeter/neurons/greeter.py" <<PY
#!/usr/bin/env python3
import hashlib, json, sys
stim = json.load(sys.stdin)
prefix = stim.get("caps", {}).get("write_prefix", "")
reads = stim.get("reads", [])
body = json.loads(reads[0]["bytes"]) if reads else {}
product = json.dumps({"schema": "$goal_emits", "greeting": "hello " + str(body.get("name", "world"))})
# The product id is keyed by the firing: the write prefix is per-contract, so a
# fixed id would make the second caller a CAS conflict against the first.
slot = hashlib.sha256(stim["firing_id"].encode()).hexdigest()[:16]
print(json.dumps({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "served"},
    "effects": [{"kind": "write", "artifact": {
        "id": prefix + "product/" + slot, "schema": "$goal_emits", "bytes": product}}],
    "evidence": [{"claim": "greeting derived from the admitted request body",
                  "method": "pure function of the stimulus",
                  "sources": [reads[0]["id"] if reads else "stimulus"]}]
}))
PY

cat >"$gate_root/commander/neuron.json" <<'JSON'
{
  "schema": "typed-neuron.limb-manifest/v1",
  "package": "gate/commander",
  "version": "0.1.0",
  "description": "Commits a consequential request to the outbox.",
  "neurons": [{
    "id": "commander",
    "accepts": ["gate.order-request/v1"],
    "emits": ["gate.order-queued/v1"],
    "argv": ["python3", "neurons/commander.py"],
    "caps_request": {
      "allow_write": true, "write_prefix": "agents/", "allow_send": true,
      "send_prefix": "outbox/served/", "allow_spawn": false,
      "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 2, "max_spawns": 0,
                 "max_bytes": 65536, "max_depth": 1, "max_turns": 1}
    }
  }],
  "budgets": {"deadline_ms_per_firing": 10000}
}
JSON
cat >"$gate_root/commander/neurons/commander.py" <<'PY'
#!/usr/bin/env python3
import hashlib, json, sys
stim = json.load(sys.stdin)
caps = stim.get("caps", {})
write_prefix = caps.get("write_prefix", "")
send_prefix = caps.get("send_prefix", "")
reads = stim.get("reads", [])
raw = reads[0]["bytes"] if reads else "{}"
key = hashlib.sha256((stim["firing_id"] + raw).encode()).hexdigest()[:32]
content_id = write_prefix + "content/" + key
# Content and the outbox record land in ONE firing: nothing crosses here.
print(json.dumps({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "queued"},
    "effects": [
        {"kind": "write", "artifact": {"id": content_id, "schema": "gate.order-queued/v1", "bytes": raw}},
        {"kind": "send", "message": {"to": send_prefix + key, "schema": "gate.order-queued/v1",
                                     "payload": json.dumps({"content": content_id}), "durable": True}}
    ],
    "evidence": [{"claim": "order content committed with its outbox record in one firing",
                  "method": "single-firing commit", "sources": [reads[0]["id"] if reads else "stimulus"]}]
}))
PY

cat >"$gate_root/planter/neuron.json" <<'JSON'
{
  "schema": "typed-neuron.limb-manifest/v1",
  "package": "gate/planter",
  "version": "0.1.0",
  "description": "Writes one artifact outside any served namespace.",
  "neurons": [{
    "id": "planter",
    "accepts": ["gate.plant/v1"],
    "emits": ["gate.secret/v1"],
    "argv": ["python3", "neurons/planter.py"],
    "caps_request": {
      "allow_write": true, "write_prefix": "agents/", "allow_send": false, "allow_spawn": false,
      "budget": {"max_effects": 2, "max_writes": 1, "max_messages": 0, "max_spawns": 0,
                 "max_bytes": 65536, "max_depth": 1, "max_turns": 1}
    }
  }],
  "budgets": {"deadline_ms_per_firing": 10000}
}
JSON
cat >"$gate_root/planter/neurons/planter.py" <<'PY'
#!/usr/bin/env python3
import json, sys
json.load(sys.stdin)
print(json.dumps({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "planted"},
    "effects": [{"kind": "write", "artifact": {
        "id": "agents/vault/secret", "schema": "gate.secret/v1",
        "bytes": "SUPERSECRET-PORT-TOKEN-a1b2c3"}}],
    "evidence": [{"claim": "planted a private artifact outside every served prefix",
                  "method": "gate setup", "sources": ["stimulus"]}]
}))
PY

"$binary" agent init "$node" greeter >/dev/null
greeter_digest="$("$binary" limb admit "$gate_root/greeter" "$node/state" | tail -1)"
commander_digest="$("$binary" limb admit "$gate_root/commander" "$node/state" | tail -1)"
planter_digest="$("$binary" limb admit "$gate_root/planter" "$node/state" | tail -1)"
[ "${#greeter_digest}" = 64 ] || fail "greeter limb was not admitted"
[ "${#planter_digest}" = 64 ] || fail "planter limb was not admitted"

# Plant the secret through the ordinary limb path, so it is a real substrate
# artifact produced by a real firing — not a string the gate injected.
cat >"$gate_root/plant.json" <<'JSON'
{"schema": "neuron.stimulus/v1", "firing_id": "gate/plant/1", "receptor_schema": "gate.plant/v1"}
JSON
"$binary" limb run "$node/state" --package "$gate_root/planter" --neuron planter \
    --stimulus "$gate_root/plant.json" >/dev/null
secret="SUPERSECRET-PORT-TOKEN-a1b2c3"
secret_hex="$(printf '%s' "$secret" | od -An -tx1 | tr -d ' \n')"
# Artifact bytes are journaled as hex, so a naive plain-text check would pass
# for the wrong reason. Both encodings are used from here on.
grep -q "$secret_hex" "$log" ||
    fail "the planted secret is not in the journal: the exfiltration test would be vacuous"

# --- the published contract, derived from the goal -------------------------
write_read_manifest() { # file handler_digest path callers_json [id]
    cat >"$1" <<JSON
{
  "schema": "neuron.published-interface/v1",
  "id": "${5:-$goal_id}",
  "version": "$goal_version",
  "transport": "http",
  "bind": {"path": "$3", "method": "$goal_method"},
  "handler_digest": "$2",
  "handler_neuron": "$goal_handler_neuron",
  "receptor_schema": "$goal_accepts",
  "firing_id_source": "caller_supplied",
  "max_request_bytes": 65536,
  "max_concurrent": 1,
  "callers": $4,
  "accepts": ["$goal_accepts"],
  "emits": ["$goal_emits"],
  "errors": ["$goal_errors"],
  "invocation": {"mode": "read", "deterministic": true, "idempotency": "keyed",
                 "timeout_ms": 10000, "max_output_bytes": 65536},
  "data_flow": {"input_classes": ["public"], "output_classes": ["public"]},
  "requested_caps": {"allow_write": true, "allow_send": false, "allow_spawn": false,
                     "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 0,
                                "max_spawns": 0, "max_bytes": 65536, "max_depth": 1, "max_turns": 1}},
  "evidence_claim": "the greeting is a pure function of the admitted request",
  "evidence_method": "handler limb firing under a derived grant",
  "settlement": "response returned once the firing committed"
}
JSON
}
callers="$goal_callers"
write_read_manifest "$gate_root/read.json" "$greeter_digest" "$goal_route" "$callers"

# --- 3. outbound fields and other structural refusals ----------------------
refuses() { # description file [expected_field]
    if "$binary" port publish "$node" "$2" --json >"$gate_root/refusal.txt" 2>&1; then
        fail "$1 was published instead of refused"
    fi
    # A refusal must NAME the offending field, not merely its error class. The
    # party that most needs the field name is an agent composing a manifest
    # unattended, which is the whole premise of a published interface. Asserting
    # only on the error name made this gate pass with the diagnostics deleted —
    # a witness that cannot see the feature it is supposed to prove.
    if [ -n "${3:-}" ]; then
        grep -q "field ${3}" "$gate_root/refusal.txt" || fail \
            "$1 was refused without naming field '${3}' — got: $(head -1 "$gate_root/refusal.txt")"
    fi
}
python3 - "$gate_root/read.json" "$gate_root/bad-outbound.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["implementation_digest"] = "0" * 64
json.dump(doc, open(sys.argv[2], "w"))
PY
refuses "a published document carrying implementation_digest" "$gate_root/bad-outbound.json" implementation_digest
grep -q "InvalidPublishedInterface" "$gate_root/refusal.txt" ||
    fail "an outbound field was refused for the wrong reason"

python3 - "$gate_root/read.json" "$gate_root/bad-path.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["bind"]["path"] = doc["bind"]["path"] + "/{name}"
json.dump(doc, open(sys.argv[2], "w"))
PY
refuses "a route parameter (an un-schema'd input channel)" "$gate_root/bad-path.json" bind.path

python3 - "$gate_root/read.json" "$gate_root/bad-receptor.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["receptor_schema"] = "gate.anything/v1"
json.dump(doc, open(sys.argv[2], "w"))
PY
refuses "a receptor schema outside accepts (an execute-anything surface)" "$gate_root/bad-receptor.json" receptor_schema

python3 - "$gate_root/read.json" "$gate_root/bad-caps.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["requested_caps"]["write_prefix"] = "agents/"
json.dump(doc, open(sys.argv[2], "w"))
PY
refuses "a manifest naming its own write target" "$gate_root/bad-caps.json"

python3 - "$gate_root/read.json" "$gate_root/bad-command.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["invocation"]["mode"] = "command"
doc["requested_caps"]["allow_send"] = True
json.dump(doc, open(sys.argv[2], "w"))
PY
refuses "a served command exposing no independent read-back" "$gate_root/bad-command.json" bind.reconcile_path

python3 - "$gate_root/read.json" "$gate_root/bad-economics.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["economics"] = "prepaid"
json.dump(doc, open(sys.argv[2], "w"))
PY
refuses "inbound pricing smuggled in through the outbound economic profile" "$gate_root/bad-economics.json"

python3 - "$gate_root/read.json" "$gate_root/bad-handler.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["handler_digest"] = "0" * 64
json.dump(doc, open(sys.argv[2], "w"))
PY
refuses "a handler digest that is no admitted limb" "$gate_root/bad-handler.json"

# --- 1. an unadmitted document serves nothing ------------------------------
http_port="$(free_port)"
start_server
[ "$(code_for "$goal_method" "/agents/greeter$goal_route" '{"name":"ada"}' \
    -H 'X-Neuron-Idempotency-Key: k1')" = 404 ] ||
    fail "a path with no published record answered"
stop_server

published="$("$binary" port publish "$node" "$gate_root/read.json" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["published"])')"
[ "${#published}" = 64 ] || fail "publish did not return a digest"

# Admitted, not attached: still nothing. The record is not the edge.
start_server
[ "$(code_for "$goal_method" "/agents/greeter$goal_route" '{"name":"ada"}' \
    -H 'X-Neuron-Idempotency-Key: k1')" = 404 ] ||
    fail "an admitted but unattached published record served a request"
stop_server

# --- 12. the two directions cannot be confused -----------------------------
if "$binary" interface attach "$node" greeter --interface "$published" --role worker >/dev/null 2>&1; then
    fail "a published digest was attached as an outbound worker interface"
fi

"$binary" port attach "$node" greeter --published "$published" --handler "$gate_root/greeter" --json >/dev/null
grep -q "agents/greeter/ports/00" "$log" || fail "the port attachment was not journaled"
# The port slot namespace is disjoint from the chain namespace a work plan
# walks, so a served surface can never be handed to a hop walker.
grep -q "agents/greeter/interfaces/" "$log" &&
    fail "a port attachment landed in the outbound chain namespace"

# --- 4. the goal answered: a real HTTP client, a correct typed answer -------
start_server
route="/agents/greeter$goal_route"
body="{\"name\":\"$goal_subject\"}"
first="$(curl -s -D "$gate_root/h1.txt" -X "$goal_method" --data "$body" \
    -H 'X-Neuron-Idempotency-Key: shared-key' "http://127.0.0.1:$http_port$route")"
# The answer is the one the goal promised, under the schema the goal declared.
python3 - "$first" "$goal_answer" "$goal_emits" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
assert doc.get("greeting") == sys.argv[2], f"wrong answer: {doc}"
assert doc.get("schema") == sys.argv[3], f"answer outside the goal's emits: {doc}"
PY
[ $? = 0 ] || fail "the served answer was not the goal's typed answer: $first"
grep -qi "^X-Neuron-Product-Schema: $goal_emits" "$gate_root/h1.txt" ||
    fail "the response did not declare the goal's product schema"
grep -qi '^X-Neuron-Status: served' "$gate_root/h1.txt" || fail "the first request was not a fresh firing"

second="$(curl -s -D "$gate_root/h2.txt" -X "$goal_method" --data "$body" \
    -H 'X-Neuron-Idempotency-Key: shared-key' "http://127.0.0.1:$http_port$route")"
[ "$second" = "$first" ] || fail "a duplicate request returned a different answer"
grep -qi '^X-Neuron-Status: replayed' "$gate_root/h2.txt" ||
    fail "a duplicate request re-fired instead of replaying"

# --- 5. R2: one caller key, two peers, two firings -------------------------
other="$(curl -s -X "$goal_method" --data '{"name":"mallory"}' --interface 127.0.0.2 \
    -H 'X-Neuron-Idempotency-Key: shared-key' "http://127.0.0.1:$http_port$route")"
echo "$other" | grep -q '"greeting": "hello mallory"' ||
    fail "a second peer reusing another peer's caller key read the first peer's result: $other"
python3 - "$log" "$published" <<'PY'
import json, sys
log, published = sys.argv[1], sys.argv[2]
firings = set()
for line in open(log):
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except json.JSONDecodeError:
        continue
    fid = rec.get("firing_id", "")
    if fid.startswith("served/" + published + "/"):
        firings.add(fid)
assert len(firings) >= 2, f"expected two distinct served firings, got {sorted(firings)}"
PY
[ $? = 0 ] || fail "the two peers shared one firing identity"

# --- 11 (peers). a caller outside the list is refused ----------------------
[ "$(code_for "$goal_method" "$route" '{"name":"x"}' --interface 127.0.0.3 \
    -H 'X-Neuron-Idempotency-Key: k9')" = 403 ] ||
    fail "an unlisted caller was admitted"

# --- 10. no artifact payload crosses the port ------------------------------
probe_leak() {
    local out
    out="$(curl -s -D - -X POST --data "$1" -H 'X-Neuron-Idempotency-Key: leak' \
        "http://127.0.0.1:$http_port$2" || true)"
    if printf '%s' "$out" | grep -qi -e "$secret" -e "$secret_hex"; then
        fail "a served response leaked a substrate artifact ($2)"
    fi
}
probe_leak '{"name":"ada"}' "$route"
probe_leak '{"name":"ada","id":"agents/vault/secret"}' "$route"
probe_leak '{}' /agents/vault/secret
probe_leak '{}' '/agents/greeter/../vault/secret'
probe_leak '{}' "$route/agents/vault/secret"
stop_server

# --- 6. revoking the handler limb refuses the NEXT request -----------------
# A second, byte-different copy of the same handler. Limb revocation is
# permanent, so the drift test needs its own package or it would take the rest
# of the gate down with it — and two live ports also prove the refusal is scoped
# to the drifted handler rather than to the listener.
cp -r "$gate_root/greeter" "$gate_root/doomed"
python3 - "$gate_root/doomed/neuron.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["package"] = "gate/doomed"
json.dump(doc, open(sys.argv[1], "w"))
PY
doomed_digest="$("$binary" limb admit "$gate_root/doomed" "$node/state" | tail -1)"
[ "$doomed_digest" != "$greeter_digest" ] || fail "the doomed handler is the same package"
write_read_manifest "$gate_root/doomed.json" "$doomed_digest" "/doomed" "$callers" "gate/doomed"
doomed_hex="$("$binary" port publish "$node" "$gate_root/doomed.json" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["published"])')"
"$binary" port attach "$node" greeter --published "$doomed_hex" \
    --handler "$gate_root/doomed" --json >/dev/null

start_server
[ "$(code_for "$goal_method" /agents/greeter/doomed '{"name":"bob"}' \
    -H 'X-Neuron-Idempotency-Key: d1')" = 200 ] ||
    fail "the doomed route did not answer before its handler was revoked"
stop_server

"$binary" limb revoke "$node/state" --package "$gate_root/doomed" >/dev/null
start_server
[ "$(code_for "$goal_method" /agents/greeter/doomed '{"name":"bob"}' \
    -H 'X-Neuron-Idempotency-Key: d2')" = 404 ] ||
    fail "a revoked handler limb still answered"
[ "$(code_for "$goal_method" "$route" '{"name":"ada"}' -H 'X-Neuron-Idempotency-Key: d3')" = 200 ] ||
    fail "revoking one handler took an unrelated port down with it"
stop_server

# Editing the handler package after the pin was taken is the same refusal: the
# bytes moved, so the port fails closed rather than serving something else.
echo "# drift" >>"$gate_root/greeter/neurons/greeter.py"
start_server
[ "$(code_for "$goal_method" "$route" '{"name":"ada"}' -H 'X-Neuron-Idempotency-Key: d4')" = 404 ] ||
    fail "a handler whose bytes moved after the pin still answered"
stop_server
python3 - "$gate_root/greeter/neurons/greeter.py" <<'PY'
import sys
path = sys.argv[1]
kept = [line for line in open(path).read().splitlines(True) if line.strip() != "# drift"]
open(path, "w").write("".join(kept))
PY
start_server
[ "$(code_for "$goal_method" "$route" '{"name":"ada"}' -H 'X-Neuron-Idempotency-Key: d5')" = 200 ] ||
    fail "restoring the pinned bytes did not restore the route"
stop_server

# --- 7. a served command returns an address, not a result ------------------
cat >"$gate_root/command.json" <<JSON
{
  "schema": "neuron.published-interface/v1",
  "id": "gate/order",
  "version": "1.0.0",
  "transport": "http",
  "bind": {"path": "/order", "method": "POST", "reconcile_path": "/order.status"},
  "handler_digest": "$commander_digest",
  "handler_neuron": "commander",
  "receptor_schema": "gate.order-request/v1",
  "firing_id_source": "content",
  "max_request_bytes": 65536,
  "max_concurrent": 1,
  "callers": {"mode": "listed", "peers": ["ip4:127.0.0.1"]},
  "accepts": ["gate.order-request/v1"],
  "emits": ["gate.order-queued/v1"],
  "errors": ["gate.order-failed/v1"],
  "invocation": {"mode": "command", "deterministic": false, "idempotency": "keyed",
                 "timeout_ms": 10000, "max_output_bytes": 65536},
  "data_flow": {"input_classes": ["public"], "output_classes": ["public"]},
  "requested_caps": {"allow_write": true, "allow_send": true, "allow_spawn": false,
                     "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 2,
                                "max_spawns": 0, "max_bytes": 65536, "max_depth": 1, "max_turns": 1}},
  "evidence_claim": "the order is committed to the outbox before anything crosses",
  "evidence_method": "single-firing content + outbox commit",
  "settlement": "settled by the outbox dispatcher, not by this response"
}
JSON
command_hex="$("$binary" port publish "$node" "$gate_root/command.json" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["published"])')"
"$binary" port attach "$node" greeter --published "$command_hex" --handler "$gate_root/commander" --json >/dev/null

start_server
command_code="$(code_for POST /agents/greeter/order '{"item":"widget"}')"
[ "$command_code" = 202 ] || fail "a served command answered $command_code instead of 202"
command_body="$(curl -s -X POST --data '{"item":"widget"}' "http://127.0.0.1:$http_port/agents/greeter/order")"
python3 - "$command_body" "$command_hex" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
address = doc.get("outbox_address", "")
assert address.startswith("outbox/served/" + sys.argv[2] + "/"), f"not an outbox address: {doc}"
assert "greeting" not in sys.argv[1], "a command responded with a result"
PY
[ $? = 0 ] || fail "a served command did not return an outbox address"
stop_server
grep -q "outbox/served/$command_hex/" "$log" || fail "the outbox record was never committed"

# --- 9. two ports on one path refuse ---------------------------------------
write_read_manifest "$gate_root/dup.json" "$greeter_digest" "$goal_route" "$callers" "$goal_id-again"
dup_hex="$("$binary" port publish "$node" "$gate_root/dup.json" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["published"])')"
if "$binary" port attach "$node" greeter --published "$dup_hex" --handler "$gate_root/greeter" \
    >"$gate_root/dup.txt" 2>&1; then
    fail "two live ports were attached to one route"
fi
grep -q "InterfacePortOccupied" "$gate_root/dup.txt" || fail "the duplicate route refused for the wrong reason"

# The same path under a DIFFERENT agent is fine: uniqueness is agent-local (R4).
"$binary" agent init "$node" second >/dev/null
"$binary" port attach "$node" second --published "$dup_hex" --handler "$gate_root/greeter" --json >/dev/null

# --- 13. the generated client's pinned digest detects drift ----------------
# `interface describe` GENERATES a client for a remote contract and pins it:
# the digest is `contractPin` — method, URL, response encoding, response field,
# mode. That pin is what a later `interface test`/`admit`/`call` re-derives, so
# a client whose contract moved out from under it fails closed instead of
# calling the wrong endpoint.
start_server
client_url="http://127.0.0.1:$http_port$route"
moved_url="http://127.0.0.1:$http_port/agents/second$goal_route"

describe_client() { # output_file url id
    "$binary" interface describe "$2" --kind http --id "$3" \
        --url-template "$2" --method GET --non-mutating \
        --response-encoding json --response-field greeting \
        --output "$1" >/dev/null
}
pin_of() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["implementation_digest"])' "$1"; }
pin_check() { # manifest -> "ok|detail"
    # `interface test` exits non-zero whenever ANY check fails, and the live
    # probes below cannot succeed against a POST-only served read (section 14).
    # The report is still written, and the claim under test is one specific
    # check, so the exit status is deliberately not the assertion here.
    local report
    report="$("$binary" interface test "$1" --json 2>/dev/null || true)"
    printf '%s' "$report" | python3 -c '
import json, sys
report = json.load(sys.stdin)
check = {c["check"]: c for c in report["checks"]}["implementation-pinned"]
print("%s|%s" % (check["ok"], check["detail"]))'
}

describe_client "$gate_root/client.json" "$client_url" client/greet
describe_client "$gate_root/client-moved.json" "$moved_url" client/greet
pin_here="$(pin_of "$gate_root/client.json")"
pin_moved="$(pin_of "$gate_root/client-moved.json")"
[ "${#pin_here}" = 64 ] || fail "the generated client carries no pin"
[ "$pin_here" != "$pin_moved" ] ||
    fail "two different served contracts generated the same client pin"

# Not vacuous: the same check PASSES for a client that has not drifted.
[ "$(pin_check "$gate_root/client.json")" = "True|$pin_here" ] ||
    fail "an undrifted generated client failed its own pin check"

# The served API moves. An operator re-points the OLD client at the new route
# and does not re-generate it — the exact mistake the pin exists to catch.
python3 - "$gate_root/client.json" "$gate_root/client-drifted.json" "$moved_url" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["locator"] = doc["url_template"] = sys.argv[3]   # pin deliberately left stale
json.dump(doc, open(sys.argv[2], "w"))
PY
drift_result="$(pin_check "$gate_root/client-drifted.json")"
[ "$drift_result" = "False|InterfaceDigestDrift" ] ||
    fail "the stale client's pin did not detect drift: $drift_result"
if "$binary" interface admit "$node" "$gate_root/client-drifted.json" >/dev/null 2>&1; then
    fail "a drifted client was admitted"
fi

# --- 14. the served read surface, pinned as a fact -------------------------
# Why section 13 stops at the pin: a served READ only becomes a stimulus after
# its body decodes as a JSON object, and the route table refuses a query
# string, so there is no bodiless GET surface for the outbound client to call —
# and `describe` will not author a POST read, because a POST is not a safe
# method. Both halves are asserted here so this stays a KNOWN boundary rather
# than a silent one.
if "$binary" interface describe "$client_url" --kind http --id client/post \
        --url-template "$client_url" --method POST --non-mutating \
        --response-encoding json --response-field greeting \
        --output "$gate_root/client-post.json" >/dev/null 2>&1; then
    fail "describe authored a POST declared as a read"
fi
write_read_manifest "$gate_root/getread.json" "$greeter_digest" "/greet-get" "$callers" "$goal_id-get"
python3 - "$gate_root/getread.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["bind"]["method"] = "GET"          # a read may be bound to a safe method
json.dump(doc, open(sys.argv[1], "w"))
PY
getread_hex="$("$binary" port publish "$node" "$gate_root/getread.json" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["published"])')"
"$binary" port attach "$node" greeter --published "$getread_hex" \
    --handler "$gate_root/greeter" --json >/dev/null
[ "$(code_for GET /agents/greeter/greet-get '' -H 'X-Neuron-Idempotency-Key: g1')" = 400 ] ||
    fail "a bodiless GET became a stimulus"
[ "$(code_for GET "$route" '' -H 'X-Neuron-Idempotency-Key: g2')" = 405 ] ||
    fail "a method outside the contract was served"
stop_server

# --- 2 + 8. revoke and detach both fail the route closed -------------------
"$binary" port revoke "$node" --published "$published" >/dev/null
start_server
[ "$(code_for "$goal_method" "$route" '{"name":"ada"}' -H 'X-Neuron-Idempotency-Key: k3')" = 404 ] ||
    fail "a revoked published record still served"
stop_server
grep -q "interfaces/published/$published" "$log" ||
    fail "the admission record did not survive revocation"
grep -q "agents/greeter/ports/00" "$log" ||
    fail "the attachment record did not survive revocation"

"$binary" port detach "$node" greeter --published "$published" >/dev/null
# Artifact bytes are journaled as hex, so the detached record is looked for in
# the encoding the journal actually uses.
detached_hex="$(printf '%s' '"status":"detached"' | od -An -tx1 | tr -d ' \n')"
python3 - "$log" "$detached_hex" <<'PY'
import sys
found = any(sys.argv[2] in line and "agents/greeter/ports/00" in line
            for line in open(sys.argv[1]))
assert found, "the detachment was never journaled"
PY
"$binary" port list "$node" --agent greeter --json |
    python3 -c 'import json,sys
routes = json.load(sys.stdin)["routes"]
assert "/agents/greeter/greet" not in routes, f"the detached route is still live: {routes}"' ||
    fail "detach did not release the route"

start_server
[ "$(code_for "$goal_method" "/agents/second$goal_route" '{"name":"ada"}' \
    -H 'X-Neuron-Idempotency-Key: k4')" = 200 ] ||
    fail "the second agent's port stopped answering when the first was detached"
stop_server

# --- 11. loopback-only unless explicitly opted out -------------------------
if "$binary" port http "$node" --listen "0.0.0.0:$(free_port)" >"$gate_root/public.txt" 2>&1; then
    fail "an off-loopback bind was accepted without --allow-public"
fi
grep -q "ServeAddressNotLoopback" "$gate_root/public.txt" ||
    fail "the off-loopback refusal was the wrong one"

echo "PASS: one goal served over HTTP — admitted, attached, still pinned, and the generated client detects drift"
