#!/usr/bin/env bash
# Runnable witness for the universal interface membrane (§17.3 / entrypoint
# plan Phase 2). Through the public CLI only, from an empty directory:
#
#   1. discovery and description confer no authority;
#   2. three different interface kinds — a pure function, an admitted test
#      binary, and a local store — are described, tested, admitted, and used
#      through one membrane with one audit trail;
#   3. an untyped binary, argv injection, capability widening, a timeout, a
#      path traversal, and digest drift are each rejected, committing nothing;
#   4. reads happen inside a firing; a command commits to the outbox first,
#      crosses only on dispatch, and settles only after independent read-back;
#   5. a real agent goal is performed by a real boundary and the product is
#      independently reproduced before the snapshot advances;
#   6. revocation and detachment stop new calls while preserving the audit.
#
# Every assertion inspects durable state, not stdout resemblance.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-universal-interface.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT
node_dir="$gate_root/node"
store_dir="$gate_root/store"
binary="$repo_dir/zig-out/bin/neuron"
log="$node_dir/state/substrate.log"
mkdir -p "$store_dir"

# The admitted test binary: deterministic, no environment, stdin to stdout.
probe="$gate_root/shout.sh"
printf '#!/bin/sh\nexec tr "[:lower:]" "[:upper:]"\n' > "$probe"
chmod +x "$probe"
# A boundary that never answers, for the deadline case.
hang="$gate_root/hang.sh"
printf '#!/bin/sh\nsleep 30\n' > "$hang"
chmod +x "$hang"

"$binary" agent init "$node_dir" alpha >/dev/null
test -s "$log"

wal_bytes() { wc -c < "$log" | tr -d ' '; }
# Counting must tolerate a store the boundary has not written into yet: under
# `pipefail` a `find` over a missing directory would abort the gate.
count_products() {
    local total=0
    if [ -d "$store_dir/out" ]; then
        total="$(find "$store_dir/out" -type f | wc -l | tr -d ' ')"
    fi
    printf '%s' "$total"
}

# ---------------------------------------------------------------------------
# 1. Discovery is a read: it names a boundary and grants nothing.
# ---------------------------------------------------------------------------
wal_before="$(wal_bytes)"
found="$("$binary" interface discover "$probe" --json)"
python3 - "$found" <<'PY'
import json, sys
c = json.loads(sys.argv[1])
assert c["kind"] == "process" and c["exists"] and c["executable"], c
assert len(c["implementation_digest"]) == 64, c
assert c["authority"].startswith("none"), c
PY
# A pipeline is recognized as pure code and pinned by the code itself.
python3 - "$("$binary" interface discover 'collapse-ws|upper' --json)" <<'PY'
import json, sys
c = json.loads(sys.argv[1])
assert c["kind"] == "function" and len(c["implementation_digest"]) == 64, c
PY
# Describing writes only the draft file the operator asked for.
"$binary" interface describe "$probe" --id proc/shout --input-channel stdin \
    --deterministic --output "$gate_root/proc.json" >/dev/null
"$binary" interface describe 'collapse-ws|upper' --id text/normalize --output "$gate_root/fn.json" >/dev/null
"$binary" interface describe "$store_dir" --kind filesystem --mode command \
    --id store/products --target-template "out/{digest}.txt" --output "$gate_root/store.json" >/dev/null
"$binary" interface describe "$store_dir" --kind filesystem --mode read \
    --id store/reader --target-template "{input}" --output "$gate_root/read.json" >/dev/null
test "$(wal_bytes)" = "$wal_before"  # discovery + description committed nothing

# The draft is already usable: `--input-channel stdin` carries the whole goal as
# one value, and `--deterministic` is the claim the battery will make it prove.
python3 - "$gate_root/proc.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assert m["input_channel"] == "stdin" and m["argv_template"] == [m["locator"]], m
assert m["invocation"]["deterministic"] is True, m
PY

# An inert draft is not callable: nothing is admitted yet.
draft_digest="$(python3 -c '
import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$gate_root/proc.json")"
if "$binary" interface call "$node_dir" --interface "$draft_digest" --input x >/dev/null 2>&1; then
    echo "FAIL: an unadmitted interface was callable" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 2. The battery proves before admission grants.
# ---------------------------------------------------------------------------
report="$("$binary" interface test "$gate_root/proc.json" --json)"
python3 - "$report" <<'PY'
import json, sys
r = json.loads(sys.argv[1])
assert r["passed"], r
names = {c["check"]: c for c in r["checks"]}
for required in ("implementation-pinned", "caps-least-authority", "probe-invocation",
                 "determinism", "argv-whole-element", "budget-bounded"):
    assert names[required]["ok"], (required, names[required])
PY
test "$(wal_bytes)" = "$wal_before"  # `test` is a read: it admits nothing

# ---------------------------------------------------------------------------
# 3. Adversarial manifests are each rejected, and commit nothing.
# ---------------------------------------------------------------------------
reject() { # reject <name> <manifest>
    if "$binary" interface admit "$node_dir" "$2" >/dev/null 2>&1; then
        echo "FAIL: $1 was admitted" >&2
        exit 1
    fi
}
python3 - "$gate_root/proc.json" "$gate_root" <<'PY'
import json, sys
base, out = json.load(open(sys.argv[1])), sys.argv[2]

def variant(name, **changes):
    m = dict(base)
    for key, value in changes.items():
        if key == "invocation":
            m[key] = {**base[key], **value}
        else:
            m[key] = value
    json.dump(m, open(f"{out}/{name}.json", "w"))

# An interface with no declared typed surface is not describable.
variant("untyped", accepts=[], emits=[], errors=[])
# `{input}` inside a larger argument is the injection shape.
variant("inject", argv_template=[base["locator"], "cat {input}"], input_channel="argv")
# argv[0] must be the pinned executable, not a different program.
variant("swapped", argv_template=["/bin/sh", "{input}"], input_channel="argv")
# An adapter may not widen its caller's authority.
variant("widened", requested_caps={"allow_write": True, "write_prefix": "",
                                   "allow_spawn": True, "spawn_prefix": ""})
# A locator that is inert data cannot be relabelled into a different kind.
variant("mislabelled", kind="filesystem")
PY
reject "an untyped binary" "$gate_root/untyped.json"
reject "argv injection" "$gate_root/inject.json"
reject "a locator/argv0 mismatch" "$gate_root/swapped.json"
reject "capability widening" "$gate_root/widened.json"
reject "a mislabelled kind" "$gate_root/mislabelled.json"

# A boundary that never answers dies on its declared deadline, not ours.
"$binary" interface describe "$hang" --id proc/hang --timeout-ms 400 --output "$gate_root/hang.json" >/dev/null
started="$(python3 -c 'import time; print(time.time())')"
reject "a boundary that outran its deadline" "$gate_root/hang.json"
python3 - "$started" <<'PY'
import sys, time
elapsed = time.time() - float(sys.argv[1])
# The 30s sleep must have been killed at its 400ms deadline, not waited out.
assert elapsed < 10, f"deadline was not enforced: {elapsed:.1f}s"
PY

test "$(wal_bytes)" = "$wal_before"  # six rejections, zero commits

# ---------------------------------------------------------------------------
# 4. Admission: three kinds through one membrane.
# ---------------------------------------------------------------------------
admit() { "$binary" interface admit "$node_dir" "$1" --json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["interface"])'; }
fn_id="$(admit "$gate_root/fn.json")"
proc_id="$(admit "$gate_root/proc.json")"
store_id="$(admit "$gate_root/store.json")"
read_id="$(admit "$gate_root/read.json")"
test "$(wal_bytes)" != "$wal_before"  # admission is the write

# Re-admitting the identical manifest is idempotent, not a conflict.
wal_pre_reamdit="$(wal_bytes)"
test "$(admit "$gate_root/fn.json")" = "$fn_id"
test "$(wal_bytes)" = "$wal_pre_reamdit"

python3 - "$("$binary" interface list "$node_dir" --json)" <<'PY'
import json, sys
listing = json.loads(sys.argv[1])
kinds = {i["kind"] for i in listing["admitted"]}
assert kinds == {"function", "process", "filesystem"}, kinds
modes = {i["id"]: i["mode"] for i in listing["admitted"]}
assert modes["store/products"] == "command", modes
assert modes["text/normalize"] == "read", modes
PY

# ---------------------------------------------------------------------------
# 5. Reads: performed inside the firing, recorded as provenance.
# ---------------------------------------------------------------------------
fn_out="$("$binary" interface call "$node_dir" --interface "$fn_id" --input '  hello   membrane  ' --json)"
python3 - "$fn_out" <<'PY'
import hashlib, json, sys
r = json.loads(sys.argv[1])
assert r["status"] == "read", r
# Independent recomputation of the declared pipeline: collapse-ws then upper.
assert r["output"] == "HELLO MEMBRANE", r
assert r["output_digest"] == hashlib.sha256(b"HELLO MEMBRANE").hexdigest(), r
assert r["receipt"].startswith("interfaces/receipts/"), r
PY

# No shell is involved: metacharacters come back as literal data.
hostile='; rm -rf / && echo pwned'
proc_out="$("$binary" interface call "$node_dir" --interface "$proc_id" --input "$hostile" --json)"
python3 - "$proc_out" "$hostile" <<'PY'
import json, sys
r, hostile = json.loads(sys.argv[1]), sys.argv[2]
assert r["output"].strip() == hostile.upper(), r
PY

# A traversal smuggled through a read input is rejected after substitution.
printf 'secret\n' > "$gate_root/outside.txt"
if "$binary" interface call "$node_dir" --interface "$read_id" \
        --input "../outside.txt" >/dev/null 2>&1; then
    echo "FAIL: a path traversal resolved" >&2
    exit 1
fi
# The same interface reads a legitimate path under its root.
mkdir -p "$store_dir/notes"
printf 'inside\n' > "$store_dir/notes/today.txt"
python3 - "$("$binary" interface call "$node_dir" --interface "$read_id" --input "notes/today.txt" --json)" <<'PY'
import json, sys
assert json.loads(sys.argv[1])["output"].strip() == "inside", sys.argv[1]
PY

# ---------------------------------------------------------------------------
# 6. Commands: outbox first, boundary second, reconciliation last.
# ---------------------------------------------------------------------------
# A command is not invocable as a read, whatever it is called.
if "$binary" interface attach "$node_dir" alpha --interface "$store_id" --role worker >/dev/null 2>&1; then
    echo "FAIL: a command was attached to the read-only worker role" >&2
    exit 1
fi

files_before="$(count_products)"
queued="$("$binary" interface call "$node_dir" --interface "$store_id" --input 'product bytes' --json)"
python3 - "$queued" <<'PY'
import json, sys
r = json.loads(sys.argv[1])
assert r["status"] == "queued", r
assert r["outbox"].startswith("outbox/interface/"), r
PY
# Committing the record must not have crossed the boundary.
test "$(count_products)" = "$files_before"

dispatched="$("$binary" interface dispatch "$node_dir" --json)"
python3 - "$dispatched" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
assert d["drained"] == 1 and d["acknowledged"] == 1 and d["parked"] == 0, d
assert d["reconciled"], "the effect was acknowledged without independent read-back"
assert d["receipt"].startswith("interfaces/receipts/"), d
PY
# Content addressing: the product landed under its own digest, byte-exact.
product_digest="$(python3 -c '
import hashlib; print(hashlib.sha256(b"product bytes").hexdigest())')"
test "$(cat "$store_dir/out/$product_digest.txt")" = "product bytes"

# Retry is safe: no second dispatch, no duplicate record, no second write.
wal_pre_retry="$(wal_bytes)"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["drained"]==0, d' \
    "$("$binary" interface dispatch "$node_dir" --json)"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["status"]=="replayed", r' \
    "$("$binary" interface call "$node_dir" --interface "$store_id" --input 'product bytes' --json)"
test "$(count_products)" = "1"
test "$(wal_bytes)" = "$wal_pre_retry"

# ---------------------------------------------------------------------------
# 7. An agent goal performed by a real boundary, verified before settlement.
# ---------------------------------------------------------------------------
"$binary" interface attach "$node_dir" alpha --interface "$proc_id" --role worker >/dev/null
"$binary" interface attach "$node_dir" alpha --interface "$store_id" --role effector >/dev/null

goal="make this goal loud"
run="$("$binary" agent run "$node_dir" alpha --goal "$goal" --json)"
python3 - "$run" "$goal" <<'PY'
import hashlib, json, sys
r, goal = json.loads(sys.argv[1]), sys.argv[2]
assert r["status"] == "settled", r
assert r["goal_digest"] == hashlib.sha256(goal.encode()).hexdigest(), r
# The product is what the real boundary returned — the uppercased goal, with
# no trailing newline, because `tr` adds none — not the reference resolution
# the agent falls back to when nothing is attached.
expected = goal.upper().encode()
assert r["result_digest"] == hashlib.sha256(expected).hexdigest(), r
assert r["result_digest"] != hashlib.sha256(f"resolve:{goal}".encode()).hexdigest()
PY

# The durable record, not stdout, is the evidence: the raw product, the result
# envelope naming the exact boundary, the verdict, the reconciliation
# acknowledgement, and the snapshot advance — in that causal order.
python3 - "$log" "$run" "$goal" "$proc_id" <<'PY'
import json, sys
log, run, goal, proc_id = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3], sys.argv[4]
records = [json.loads(line) for line in open(log, encoding="utf-8")]
short = run["workflow"].rsplit("/", 1)[1]

order, seen = [], {}
for index, record in enumerate(records):
    if record.get("op") == "delivery" and record.get("status") == "acknowledged":
        order.append(("delivery", index))
    for artifact in record.get("artifacts", []):
        name = artifact["id"].rsplit("/", 1)[-1]
        if f"/work/{short}/" in artifact["id"]:
            seen[name] = artifact
            order.append((name, index))

for required in ("output", "result", "verdict", "ack"):
    assert required in seen, (required, sorted(seen))

# The raw product artifact holds exactly the bytes the boundary produced.
assert bytes.fromhex(seen["output"]["bytes"]) == goal.upper().encode(), seen["output"]

# The result envelope pins the boundary and its implementation.
result = json.loads(bytes.fromhex(seen["result"]["bytes"]))
assert result["interface"] == proc_id, result
assert len(result["implementation_digest"]) == 64, result
assert "independent second invocation" in result["judgement"], result

verdict = json.loads(bytes.fromhex(seen["verdict"]["bytes"]))
assert verdict["ok"] is True and verdict["result_digest"] == run["result_digest"], verdict

ack = json.loads(bytes.fromhex(seen["ack"]["bytes"]))
assert ack["reconciled"] is True and ack["content_digest"] == run["result_digest"], ack

# Causal order: verdict → the command crossed and was acknowledged → ack.
positions = {name: index for name, index in order}
assert positions["result"] <= positions["verdict"], order
assert positions["verdict"] <= positions["ack"], order
PY

# The consequence really landed, under the product's own digest.
test "$(cat "$store_dir/out/$(python3 -c '
import json,sys; print(json.loads(sys.argv[1])["result_digest"])' "$run").txt")" = "$(printf '%s' "${goal}" | tr 'a-z' 'A-Z')"

# Replay: nothing new commits and no second file appears.
files_after="$(count_products)"
wal_pre_replay="$(wal_bytes)"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["status"]=="replayed" and r["steps"]==0, r' \
    "$("$binary" agent run "$node_dir" alpha --goal "$goal" --json)"
test "$(wal_bytes)" = "$wal_pre_replay"
test "$(count_products)" = "$files_after"

# ---------------------------------------------------------------------------
# 8. Judgement is real: an acceptance predicate that cannot hold settles failed.
# ---------------------------------------------------------------------------
cat > "$gate_root/impossible.json" <<'JSON'
{"schema":"neuron.acceptance-predicate/v1","kind":"contains","value":"NEVER-PRESENT-MARKER"}
JSON
if "$binary" agent run "$node_dir" alpha --goal "another loud goal" \
        --acceptance "$gate_root/impossible.json" --json >/dev/null 2>&1; then
    echo "FAIL: a goal whose acceptance predicate failed reported success" >&2
    exit 1
fi
# The rejection is durable, not merely an error: a failed snapshot recorded it.
python3 - "$log" <<'PY'
import json, sys
records = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]
failed = [a for r in records for a in r.get("artifacts", [])
          if a["schema"] == "neuron.agent-snapshot/v1"
          and b'"status":"failed"' in bytes.fromhex(a["bytes"])]
assert failed, "a judged-bad goal left no durable failed snapshot"
PY
# And the rejected work pushed nothing across the boundary.
test "$(count_products)" = "$files_after"

# ---------------------------------------------------------------------------
# 9. Drift, revocation, and detachment stop new calls; audit survives.
# ---------------------------------------------------------------------------
printf '#!/bin/sh\nexec tr "[:upper:]" "[:lower:]"\n' > "$probe"   # swap the binary
if "$binary" interface call "$node_dir" --interface "$proc_id" --input hi >/dev/null 2>&1; then
    echo "FAIL: a drifted implementation was still callable" >&2
    exit 1
fi
if "$binary" agent run "$node_dir" alpha --goal "post-drift goal" >/dev/null 2>&1; then
    echo "FAIL: an agent used a drifted boundary" >&2
    exit 1
fi
printf '#!/bin/sh\nexec tr "[:lower:]" "[:upper:]"\n' > "$probe"   # restore

"$binary" interface revoke "$node_dir" --interface "$fn_id" >/dev/null
if "$binary" interface call "$node_dir" --interface "$fn_id" --input hi >/dev/null 2>&1; then
    echo "FAIL: a revoked interface was still callable" >&2
    exit 1
fi

"$binary" interface detach "$node_dir" alpha --role effector >/dev/null
"$binary" interface detach "$node_dir" alpha --role worker >/dev/null
if "$binary" interface detach "$node_dir" alpha --role worker >/dev/null 2>&1; then
    echo "FAIL: detaching an already detached role did not fail closed" >&2
    exit 1
fi

# With nothing attached the agent falls back to the reference resolution, and
# the interface work it did earlier is still fully recorded.
fallback="$("$binary" agent run "$node_dir" alpha --goal "a post-detach goal" --json)"
python3 - "$fallback" <<'PY'
import hashlib, json, sys
r = json.loads(sys.argv[1])
assert r["status"] == "settled", r
assert r["result_digest"] == hashlib.sha256(b"resolve:a post-detach goal").hexdigest(), r
PY

# Compaction folds the WAL; the admitted records, receipts, and attachment
# history all reconstruct in a fresh process.
"$binary" compact "$node_dir/state" >/dev/null
python3 - "$("$binary" interface list "$node_dir" --json)" <<'PY'
import json, sys
listing = json.loads(sys.argv[1])
# A revoked interface is still admitted history: it stays listed, marked.
assert len(listing["admitted"]) == 4, listing
statuses = {i["id"]: i["status"] for i in listing["admitted"]}
assert statuses["text/normalize"] == "revoked", statuses
assert statuses["proc/shout"] == "admitted", statuses
assert listing["revoked"] == 1, listing
assert listing["receipts"] >= 4, listing
statuses = sorted(a["status"] for a in listing["attachments"])
assert statuses == ["detached", "detached"], statuses
PY

echo "universal-interface gate: PASS"
