#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build
zig build test
python3 limbs/auto-attacher/tests/conformance.py >/dev/null
python3 limbs/introspection-trigger/tests/conformance.py >/dev/null
python3 limbs/dispatch-router/tests/conformance.py >/dev/null
python3 limbs/preemptor/tests/conformance.py >/dev/null

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-self-construct.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT
state_dir="$gate_root/state"
binary="$repo_dir/zig-out/bin/neuron"
log="$state_dir/substrate.log"

attacher_digest="$("$binary" limb admit limbs/auto-attacher "$state_dir")"
trigger_digest="$("$binary" limb admit limbs/introspection-trigger "$state_dir")"
dispatcher_digest="$("$binary" limb admit limbs/dispatch-router "$state_dir")"
preemptor_digest="$("$binary" limb admit limbs/preemptor "$state_dir")"
export attacher_digest trigger_digest dispatcher_digest preemptor_digest

# Admission is one atomic firing: immutable record and durable lifecycle event
# occur in the same WAL entry for every package.
python3 - "$log" <<'PY'
import json
import os
import sys

records = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]
for digest in (
    os.environ["attacher_digest"],
    os.environ["trigger_digest"],
    os.environ["dispatcher_digest"],
    os.environ["preemptor_digest"],
):
    firing = f"admission/{digest}"
    matches = [r for r in records if r.get("op") == "commit" and r.get("firing_id") == firing]
    assert len(matches) == 1, (firing, len(matches))
    record = matches[0]
    assert record["effects_committed"] == 2
    assert any(a["id"] == f"artifact/limbs/admitted/{digest}" for a in record["artifacts"])
    assert any(
        m["to"] == "event/neuron.limb-admission/v1"
        and m["msg_schema"] == "neuron.limb-admission/v1"
        and m["durable"]
        for m in record["messages"]
    )
PY

# Build a digest-pinned admission stimulus from the durable journal. The real
# admitted auto-attacher script then fires through Runtime.validate+commit.
python3 - "$log" "$preemptor_digest" "$gate_root/attach.json" <<'PY'
import hashlib
import json
import sys

log, digest, output = sys.argv[1:]
artifact_id = f"artifact/limbs/admitted/{digest}"
artifact = None
for line in open(log, encoding="utf-8"):
    record = json.loads(line)
    for candidate in record.get("artifacts", []):
        if candidate["id"] == artifact_id:
            artifact = candidate
assert artifact is not None
body = bytes.fromhex(artifact["bytes"]).decode()
stimulus = {
    "schema": "neuron.stimulus/v1",
    "firing_id": "gate/auto-attach",
    "receptor_schema": "neuron.limb-admission/v1",
    "permitted_reads": [artifact_id],
    "reads": [{
        "id": artifact_id,
        "schema": artifact["schema"],
        "bytes": body,
        "digest": hashlib.sha256(body.encode()).hexdigest(),
    }],
    "messages": [],
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(stimulus, handle, sort_keys=True, separators=(",", ":"))
PY

attach_result="$("$binary" limb run "$state_dir" \
    --package limbs/auto-attacher --neuron attacher \
    --stimulus "$gate_root/attach.json" --json)"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["effects_committed"] == 2' "$attach_result"

# The router consumes the newly committed edge after a fresh substrate open;
# no process restart or built-in limb registration is needed.
python3 - "$log" "$preemptor_digest" "$gate_root/dispatch.json" <<'PY'
import hashlib
import json
import sys

log, digest, output = sys.argv[1:]
prefix = f"topology/edges/{digest}/"
edge = None
for line in open(log, encoding="utf-8"):
    record = json.loads(line)
    for candidate in record.get("artifacts", []):
        if candidate["id"].startswith(prefix) and candidate["schema"] == "neuron.edge-manifest/v1":
            edge = candidate
assert edge is not None
body = bytes.fromhex(edge["bytes"]).decode()
stimulus = {
    "schema": "neuron.stimulus/v1",
    "firing_id": "gate/live-dispatch",
    "receptor_schema": "neuron.preempt-request/v1",
    "permitted_reads": [edge["id"]],
    "reads": [{
        "id": edge["id"],
        "schema": edge["schema"],
        "bytes": body,
        "digest": hashlib.sha256(body.encode()).hexdigest(),
    }],
    "messages": [],
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(stimulus, handle, sort_keys=True, separators=(",", ":"))
PY

dispatch_result="$("$binary" limb run "$state_dir" \
    --package limbs/dispatch-router --neuron dispatcher \
    --stimulus "$gate_root/dispatch.json" --json)"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["effects_committed"] == 2' "$dispatch_result"
python3 - "$log" "$preemptor_digest" <<'PY'
import json
import sys

log, digest = sys.argv[1:]
record = next(
    r for r in map(json.loads, open(log, encoding="utf-8"))
    if r.get("firing_id") == "gate/live-dispatch"
)
assert any(m["to"] == f"neuron/limb/{digest}/preemptor" for m in record["messages"])
PY

# Two real trigger firings prove state reconstruction and CAS update across
# process/substrate restarts.
python3 - "$gate_root/trigger-1.json" <<'PY'
import json
import sys
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump({
        "schema": "neuron.stimulus/v1",
        "firing_id": "gate/trigger-1",
        "receptor_schema": "neuron.firing-settled/v1",
        "permitted_reads": [],
        "reads": [],
        "messages": [],
    }, handle, sort_keys=True, separators=(",", ":"))
PY
"$binary" limb run "$state_dir" --package limbs/introspection-trigger \
    --neuron trigger --stimulus "$gate_root/trigger-1.json" --json >/dev/null

python3 - "$log" "$gate_root/trigger-2.json" <<'PY'
import hashlib
import json
import sys

log, output = sys.argv[1:]
state = None
for line in open(log, encoding="utf-8"):
    record = json.loads(line)
    for candidate in record.get("artifacts", []):
        if candidate["id"] == "introspection-trigger/state":
            state = candidate
assert state is not None
body = bytes.fromhex(state["bytes"]).decode()
stimulus = {
    "schema": "neuron.stimulus/v1",
    "firing_id": "gate/trigger-2",
    "receptor_schema": "neuron.firing-settled/v1",
    "permitted_reads": [state["id"]],
    "reads": [{
        "id": state["id"],
        "schema": state["schema"],
        "bytes": body,
        "digest": hashlib.sha256(body.encode()).hexdigest(),
    }],
    "messages": [],
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(stimulus, handle, sort_keys=True, separators=(",", ":"))
PY
"$binary" limb run "$state_dir" --package limbs/introspection-trigger \
    --neuron trigger --stimulus "$gate_root/trigger-2.json" --json >/dev/null

python3 - "$log" <<'PY'
import json
import sys

latest = None
firings = set()
for line in open(sys.argv[1], encoding="utf-8"):
    record = json.loads(line)
    firings.add(record.get("firing_id"))
    for artifact in record.get("artifacts", []):
        if artifact["id"] == "introspection-trigger/state":
            latest = json.loads(bytes.fromhex(artifact["bytes"]).decode())
assert {"gate/trigger-1", "gate/trigger-2"} <= firings
assert latest["firings_since_introspection"] == 2
PY

# Retirement removes the live topology owned by the package digest while
# preserving admission/revocation/detachment audit roots. Routing then falls
# back safely.
"$binary" limb revoke "$state_dir" --package limbs/preemptor
"$binary" limb detach "$state_dir" --package limbs/preemptor >/dev/null
inspect="$("$binary" limb inspect "$state_dir" --json)"
python3 - "$inspect" "$preemptor_digest" <<'PY'
import json
import sys
state = json.loads(sys.argv[1])
digest = sys.argv[2]
assert state["revoked"] == 1 and state["detached"] == 1
assert f"artifact/limbs/admitted/{digest}" in state["artifact_ids"]
assert f"artifact/limbs/revoked/{digest}" in state["artifact_ids"]
assert f"artifact/limbs/detached/{digest}" in state["artifact_ids"]
assert not any(x.startswith(f"topology/edges/{digest}/") for x in state["artifact_ids"])
PY

python3 - "$gate_root/fallback.json" <<'PY'
import json
import sys
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump({
        "schema": "neuron.stimulus/v1",
        "firing_id": "gate/fallback",
        "receptor_schema": "neuron.preempt-request/v1",
        "permitted_reads": [],
        "reads": [],
        "messages": [],
    }, handle, sort_keys=True, separators=(",", ":"))
PY
fallback="$("$binary" limb run "$state_dir" --package limbs/dispatch-router \
    --neuron dispatcher --stimulus "$gate_root/fallback.json" --json)"
python3 -c 'import json,sys; assert json.loads(sys.argv[1])["effects_committed"] == 1' "$fallback"
python3 - "$log" <<'PY'
import json
import sys
record = next(
    r for r in map(json.loads, open(sys.argv[1], encoding="utf-8"))
    if r.get("firing_id") == "gate/fallback"
)
logs = [
    json.loads(bytes.fromhex(a["bytes"]).decode())
    for a in record["artifacts"]
    if a["id"] == "dispatch/gate/fallback"
]
assert len(logs) == 1 and logs[0]["decision"] == "model"
PY

# Compaction + replay is the final restart witness.
"$binary" compact "$state_dir" >/dev/null
"$binary" limb inspect "$state_dir" --json >/dev/null

echo "self-constructing-agent gate: PASS"
