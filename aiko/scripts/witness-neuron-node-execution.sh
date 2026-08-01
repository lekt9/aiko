#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONTRACT_ROOT=$(CDPATH= cd -- "$ROOT/../contract/libcontract" && pwd)
TMP=$(mktemp -d)
mkdir -p "$ROOT/target"
SANDBOX_TMP=$(mktemp -d "$ROOT/target/neuron-sandbox-witness.XXXXXX")
trap 'rm -rf "$TMP" "$SANDBOX_TMP"' EXIT HUP INT TERM

case "$(uname -s)" in
  Darwin) CONTRACT_LIBRARY="$CONTRACT_ROOT/zig-out/lib/libcontract.dylib" ;;
  Linux) CONTRACT_LIBRARY="$CONTRACT_ROOT/zig-out/lib/libcontract.so" ;;
  *) echo "unsupported Contract witness platform" >&2; exit 2 ;;
esac

(cd "$CONTRACT_ROOT" && zig build test && zig build)
export AIKO_CONTRACT_LIBRARY="$CONTRACT_LIBRARY"

PROJECT="$TMP/project"
mkdir -p "$PROJECT/.claude"
python3 - "$PROJECT" "$CONTRACT_LIBRARY" <<'PY'
import ctypes, hashlib, json, os, pathlib, stat, struct, sys

project, library = pathlib.Path(sys.argv[1]), sys.argv[2]
os.chdir(project)
native = ctypes.CDLL(library)
symbols = (
    "contract_expand_json",
    "contract_neuron_skill_node_claim_json",
    "contract_neuron_skill_node_settle_json",
)
for name in symbols:
    function = getattr(native, name)
    function.argtypes = [ctypes.c_char_p]
    function.restype = ctypes.c_void_p
native.contract_free.argtypes = [ctypes.c_void_p]

def call(name, payload, required=True):
    pointer = getattr(native, name)(json.dumps(payload, separators=(",", ":")).encode())
    if not pointer:
        if required:
            raise AssertionError(f"{name} rejected a valid request")
        return None
    try:
        return json.loads(ctypes.string_at(pointer))
    finally:
        native.contract_free(pointer)

def sha256_fields(parts):
    digest = hashlib.sha256()
    for part in parts:
        encoded = str(part).encode()
        digest.update(struct.pack("<Q", len(encoded)))
        digest.update(encoded)
    return digest.hexdigest()

def node_decision(occurrence, outcome, evidence, now_ms):
    if outcome == "satisfied":
        canonical = (
            "{"
            + ",".join(
                json.dumps(key, separators=(",", ":"))
                + ":"
                + json.dumps(evidence[key], separators=(",", ":"))
                for key in occurrence["evidence_requirements"]
            )
            + "}"
        ).encode()
    else:
        canonical = b"{}"
    evidence_digest = hashlib.sha256(canonical).hexdigest()
    payload_digest = sha256_fields((
        "contract.neuron-skill-node.stimulus/v1",
        occurrence["execution_id"],
        occurrence["attempt"],
    ))
    effects = [{
        "kind": "write",
        "target": f"artifact:{evidence_digest}",
        "schema": "contract.neuron-skill-node-effect/v1",
        "payload_digest": evidence_digest,
        "bytes": len(canonical),
        "idempotency_key": (
            f"{occurrence['execution_id']}/{occurrence['attempt']}/0"
        ),
    }]
    if outcome == "satisfied" and not occurrence["read_only"]:
        kind = {
            "external_message": "send",
            "publish": "send",
            "process_spawn": "spawn",
        }.get(occurrence["effect_scope"], "write")
        effects.append({
            "kind": kind,
            "target": f"scope:{occurrence['effect_scope']}",
            "schema": "contract.neuron-skill-node-effect/v1",
            "payload_digest": evidence_digest,
            "bytes": 0,
            "idempotency_key": (
                f"{occurrence['execution_id']}/{occurrence['attempt']}/1"
            ),
        })
    return {
        "control": {"kind": "continue", "value": outcome},
        "effects": effects,
        "evidence": [{
            "claim": "typed Skill node returned its declared evidence shape",
            "sources": [payload_digest],
            "method": "Aiko Neuron execution adapter",
            "digest": evidence_digest,
            "producer": f"skill/{occurrence['skill_id']}/{occurrence['key']}",
            "observed_at_ms": now_ms,
            "confidence_milli": 1000 if outcome == "satisfied" else 0,
        }],
    }

def node(key, dependencies, bindings, evidence, authorization="approved"):
    return {
        "key": key,
        "plan": f"run {key}",
        "action": "skill:witness-skill@1.0.0:aiko",
        "depends_on": dependencies,
        "input_bindings": bindings,
        "requires_authorization": authorization != "approved",
        "authorization": authorization,
        "effect_scope": "read_only",
        "read_only": True,
        "reversible": False,
        "timeout_ms": 30000,
        "skill_id": "witness-skill",
        "skill_version": "1.0.0",
        "worker": "aiko",
        "adapter": None,
        "script": None,
        "script_digest": None,
        "evidence": evidence,
        "activation": "matched",
        "admission": "build_embedded",
    }

children = [
    node("witness-skill--observe", [], {}, ["observation"]),
    node(
        "witness-skill--settle",
        ["witness-skill--observe"],
        {"input": "witness-skill--observe.observation"},
        ["settlement"],
    ),
]
graph = call("contract_expand_json", {
    "root_id": "caf00d91",
    "plan": "typed fixed point",
    "action": "neuron:cell",
    "cwd": str(project),
    "agent": "skill:aiko-meta-agent@1.0.0",
    "children": children,
})
assert graph["abi_version"] == 12 and len(graph["waves"]) == 2
claim = {
    "schema": "contract.neuron-skill-node.claim/v1",
    "root_id": "caf00d91",
    "root_occurrence": "once:witness",
    "owner": "witness-worker",
    "now_ms": 100,
    "lease_ms": 1000,
    "max_nodes": 4,
}
first = call("contract_neuron_skill_node_claim_json", claim)
assert first["status"] == "wave" and len(first["nodes"]) == 1
occurrence = first["nodes"][0]
assert occurrence["adapter"] is None
assert occurrence["script"] is None
assert occurrence["script_digest"] is None
competing = call("contract_neuron_skill_node_claim_json", {
    **claim, "owner": "competing-worker", "now_ms": 101,
})
assert competing["status"] == "waiting"
settlement = {
    "schema": "contract.neuron-skill-node.settle/v1",
    "root_id": claim["root_id"],
    "root_occurrence": claim["root_occurrence"],
    "owner": claim["owner"],
    "execution_id": occurrence["execution_id"],
    "attempt": occurrence["attempt"],
    "outcome": "satisfied",
    "evidence": {"observation": "private-witness-evidence"},
    "detail": "private-witness-detail",
    "now_ms": 102,
}
settlement["decision"] = node_decision(
    occurrence, settlement["outcome"], settlement["evidence"], settlement["now_ms"]
)
assert call("contract_neuron_skill_node_settle_json", {
    **settlement, "owner": "competing-worker",
}, False) is None
assert call("contract_neuron_skill_node_settle_json", {
    **settlement, "evidence": {},
}, False) is None
committed = call("contract_neuron_skill_node_settle_json", settlement)
replayed_at = settlement["now_ms"]
replayed = call("contract_neuron_skill_node_settle_json", {
    **settlement,
    "now_ms": replayed_at,
    "decision": node_decision(
        occurrence, settlement["outcome"], settlement["evidence"], replayed_at
    ),
})
assert committed["status"] == "committed"
assert replayed["status"] == "replayed", replayed
assert replayed["firing_id"] == committed["firing_id"]
assert call("contract_neuron_skill_node_settle_json", {
    **settlement,
    "evidence": {"observation": "contradictory"},
    "now_ms": 5000,
}, False) is None

claim["now_ms"] = 103
second = call("contract_neuron_skill_node_claim_json", claim)
assert second["nodes"][0]["inputs"] == {"input": "private-witness-evidence"}
occurrence = second["nodes"][0]
settlement.update({
    "execution_id": occurrence["execution_id"],
    "attempt": occurrence["attempt"],
    "evidence": {
        "settlement": {
            "completed": True,
            "retryable": False,
            "evidence": "observed fixed point",
        }
    },
    "now_ms": 104,
})
settlement["decision"] = node_decision(
    occurrence, settlement["outcome"], settlement["evidence"], settlement["now_ms"]
)
call("contract_neuron_skill_node_settle_json", settlement)
claim["now_ms"] = 105
complete = call("contract_neuron_skill_node_claim_json", claim)
assert complete["status"] == "complete"
assert complete["terminal_evidence"]["settlement"]["completed"] is True

held_node = node(
    "witness-skill--send", [], {}, ["provider_ack"], "pending_authorization"
)
call("contract_expand_json", {
    "root_id": "caf00d92",
    "plan": "held effect",
    "action": "neuron:cell",
    "cwd": str(project),
    "agent": "skill:aiko-meta-agent@1.0.0",
    "children": [held_node],
})
held = call("contract_neuron_skill_node_claim_json", {
    **claim,
    "root_id": "caf00d92",
    "root_occurrence": "once:held",
    "now_ms": 106,
})
assert held["status"] == "held" and held["nodes"] == []

ledger = (project / ".claude/contracts.jsonl").read_text()
assert ledger.count('"event":"neuron_transaction"') == 2
assert ledger.count('"event":"neuron_fired"') == 2
assert ledger.count('"event":"neuron_skill_node_settled"') == 2
assert '"evidence_payload":{"observation":"private-witness-evidence"}' in ledger
assert "private-witness-detail" not in ledger
assert "agent:aiko" not in ledger
artifacts = list((project / ".claude/neuron-artifacts").glob("*.json"))
assert len(artifacts) == 2
assert all(stat.S_IMODE(path.stat().st_mode) & 0o077 == 0 for path in artifacts)
print("Contract node lease/evidence/replay/HOLD fixed point: PASS")
PY

python3 "$ROOT/scripts/test-contract-native-skills.py"
(
  cd "$ROOT"
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell --lib \
    contract_native::skill_registry::tests::native_node_execution_runs_the_meta_agent_fixed_point_without_opaque_agent \
    -- --ignored --exact --nocapture
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell --lib \
    contract_native::tests::node_result_contract_and_terminal_verdict_are_exact \
    -- --exact
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell --lib \
    contract_native::tests::limb_leaf_evidence_is_wired_into_the_meta_agent_join \
    -- --exact
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell --lib \
    contract_native::tests::admitted_script_runs_directly_and_crosses_the_exact_type_boundary \
    -- --exact
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell --lib \
    contract_native::tests::admitted_script_output_limit_terminates_the_process_before_timeout \
    -- --exact
  CARGO_INCREMENTAL=0 cargo build -p xai-grok-pager-bin --bin aiko
)

SANDBOX_PROJECT="$SANDBOX_TMP/project"
SANDBOX_SKILL_ROOT="$SANDBOX_TMP/admitted-skill"
SANDBOX_SCRIPT="$SANDBOX_SKILL_ROOT/scripts/neuron-script"
OUTSIDE_READ="$SANDBOX_TMP/outside-read"
OUTSIDE_WRITE="$SANDBOX_TMP/outside-write"
mkdir -p "$SANDBOX_PROJECT" "$SANDBOX_SKILL_ROOT/scripts"
printf 'outside capability boundary\n' >"$OUTSIDE_READ"
cat >"$SANDBOX_SCRIPT" <<EOF
#!/bin/sh
if command cat "$OUTSIDE_READ" >/dev/null 2>&1; then
  exit 42
fi
if (printf 'escaped\n' >"$OUTSIDE_WRITE") 2>/dev/null; then
  exit 43
fi
IFS= read -r request
printf '%s\n' '{"schema":"aiko.neuron-script.result/v1","completed":true,"retryable":false,"evidence":{"proof":{"observed":"kernel sandbox active"}},"summary":"sandboxed script settled"}'
EOF
chmod 700 "$SANDBOX_SCRIPT"
SCRIPT_DIGEST=$(python3 -c 'import hashlib,pathlib,sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())' "$SANDBOX_SCRIPT")
SANDBOX_RESULT=$(
  printf '%s\n' '{"schema":"aiko.neuron-script.invoke/v1","inputs":{},"evidence_requirements":["proof"]}' |
    env -i \
      PATH="$PATH" \
      HOME="$SANDBOX_PROJECT" \
      TMPDIR="$SANDBOX_PROJECT" \
      AIKO_NEURON_SCRIPT_RUNNER_V1=1 \
      AIKO_NEURON_SCRIPT_PATH="$SANDBOX_SCRIPT" \
      AIKO_NEURON_SCRIPT_SKILL_ROOT="$SANDBOX_SKILL_ROOT" \
      AIKO_NEURON_SCRIPT_DIGEST="$SCRIPT_DIGEST" \
      AIKO_NEURON_SCRIPT_CWD="$SANDBOX_PROJECT" \
      AIKO_NEURON_SCRIPT_SANDBOX=read-only \
      "$ROOT/target/debug/aiko"
)
python3 -c 'import json,sys; value=json.loads(sys.argv[1]); assert value["schema"]=="aiko.neuron-script.result/v1" and value["evidence"]["proof"]["observed"]=="kernel sandbox active"' "$SANDBOX_RESULT"
test ! -e "$OUTSIDE_WRITE"
if env -i \
  PATH="$PATH" \
  HOME="$SANDBOX_PROJECT" \
  TMPDIR="$SANDBOX_PROJECT" \
  AIKO_NEURON_SCRIPT_RUNNER_V1=1 \
  AIKO_NEURON_SCRIPT_PATH="$SANDBOX_SCRIPT" \
  AIKO_NEURON_SCRIPT_SKILL_ROOT="$SANDBOX_SKILL_ROOT" \
  AIKO_NEURON_SCRIPT_DIGEST=0000000000000000000000000000000000000000000000000000000000000000 \
  AIKO_NEURON_SCRIPT_CWD="$SANDBOX_PROJECT" \
  AIKO_NEURON_SCRIPT_SANDBOX=read-only \
  "$ROOT/target/debug/aiko" </dev/null >/dev/null 2>&1
then
  echo "sandbox runner accepted a forged script digest" >&2
  exit 1
fi

rg -q 'execute_claim_neuron_graph' "$ROOT/crates/codegen/xai-grok-pager-bin/src/main.rs"
rg -q 'AIKO_NEURON_GRAPH_EXECUTION' \
  "$ROOT/crates/codegen/xai-grok-shell/src/contract_native.rs"

echo "Neuron node execution witness: PASS"
