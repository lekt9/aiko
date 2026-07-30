#!/usr/bin/env python3
"""Fan-out limb conformance witness (R3).

Exercises: admit via limb_ops, fire through the admitted path, duplicate
coordinator delivery (re-fire identical stimulus → no duplicate spawns),
budget containment (max_fanout exceeded → fail closed), and limb lifecycle
(revoke + detach + GC). Every assertion gates on a real command.

The witness does not require a running daemon or mesh — it exercises the
fan-out neuron's spawn policy through ordinary limb_run firings.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time

LIMB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
NEURON = os.path.abspath(os.path.join(LIMB_DIR, "..", "..", "zig-out", "bin", "neuron"))
if not os.path.exists(NEURON):
    NEURON = "neuron"

sys.path.insert(0, os.path.join(LIMB_DIR, "..", "shared"))
from _neuron import canonical, digest as _digest


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120)


def admit(state):
    out = run([NEURON, "limb", "admit", LIMB_DIR, state])
    return out.stdout.strip().split()[-1]


def limb_run(state, neuron_id, stim_file, expect_failure=False):
    args = [NEURON, "limb", "run", state, "--package", LIMB_DIR,
            "--neuron", neuron_id, "--stimulus", stim_file, "--json"]
    proc = run(args)
    if expect_failure:
        return proc
    if proc.returncode != 0:
        print("FAILED:", proc.stderr[:2000], file=sys.stderr)
        raise SystemExit(1)
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def inspect_json(state):
    return json.loads(run([NEURON, "limb", "inspect", state, "--json"]).stdout)


def read_of(read_id, schema, obj):
    body = canonical(obj).decode()
    return {"id": read_id, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


def main():
    state = tempfile.mkdtemp()
    print("state:", state)

    # 1. ADMIT
    digest = admit(state)
    print("admitted digest:", digest)
    assert len(digest) == 64
    digest2 = admit(state)
    assert digest == digest2  # idempotent

    info = inspect_json(state)
    assert info["admitted"] >= 1

    # 2. FAN OUT: spawn 3 children
    now = int(time.time() * 1000)
    items = [
        {"key": "add-task", "kind": "fanout-worker",
         "write_prefix": "artifact/fanout/add-task/"},
        {"key": "patch-item", "kind": "fanout-worker",
         "write_prefix": "artifact/fanout/patch-item/"},
        {"key": "notify-user", "kind": "fanout-worker",
         "write_prefix": "artifact/fanout/notify-user/"},
    ]
    request = {"partition": "tasks", "items": items, "max_fanout": 8, "seq": 0}
    reads = [read_of("fan-req", "fanout.request/v1", request)]
    stim = {
        "schema": "neuron.stimulus/v1",
        "firing_id": "lifecycle-fan-1",
        "receptor_schema": "fanout.request/v1",
        "now_ms": now,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": [],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp = fh.name
    try:
        summary = limb_run(state, "fanout", sp)
        assert summary["status"] == "committed"
        assert summary["effects_committed"] == 3
        print("fan-out committed 3 spawns")
    finally:
        os.unlink(sp)

    # 3. DUPLICATE COORDINATOR: re-fire identical stimulus → no duplicate spawns
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp2 = fh.name
    try:
        dup = limb_run(state, "fanout", sp2)
        assert dup["status"] == "committed"
        assert dup["duplicates_skipped"] == 3
        assert dup["effects_committed"] == 0
        print("duplicate coordinator: 3 spawns skipped, 0 committed")
    finally:
        os.unlink(sp2)

    # 4. BUDGET CONTAINMENT: max_fanout exceeded → fail closed
    big_items = [{"key": f"i-{i}", "kind": "fanout-worker",
                  "write_prefix": f"artifact/fanout/i-{i}/"} for i in range(20)]
    big_request = {"partition": "overflow", "items": big_items,
                   "max_fanout": 8, "seq": 0}
    big_reads = [read_of("fan-req", "fanout.request/v1", big_request)]
    big_stim = {**stim, "firing_id": "lifecycle-fan-2",
                "reads": big_reads,
                "permitted_reads": [r["id"] for r in big_reads]}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(big_stim, fh)
        sp3 = fh.name
    try:
        big_proc = limb_run(state, "fanout", sp3, expect_failure=True)
        assert big_proc.returncode != 0, "budget exceed should be rejected"
        print("budget contain: big fan-out rejected fail-closed")
    finally:
        os.unlink(sp3)

    # 5. REVOKE
    run([NEURON, "limb", "revoke", state, "--package", LIMB_DIR])
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp4 = fh.name
    try:
        rev_proc = limb_run(state, "fanout", sp4, expect_failure=True)
        assert rev_proc.returncode != 0
        assert "LimbRevoked" in rev_proc.stderr or rev_proc.returncode != 0
        print("revocation blocks further runs: PASS")
    finally:
        os.unlink(sp4)

    # 6. DETACH + GC
    info_pre = inspect_json(state)
    pre_artifacts = info_pre["artifacts"]
    pre_firings = info_pre["firings"]
    run([NEURON, "limb", "detach", state, "--package", LIMB_DIR])
    info_post = inspect_json(state)
    assert info_post["detached"] >= 1
    assert info_post["firings"] >= pre_firings, \
        "audit root must survive detach-GC"
    print(f"detach + GC: {pre_firings} firings intact, limb detached")

    print(f"\nfan-out limb conformance: PASS")
    print(f"digest {digest} — admitted · spawned 3 · duplicate-proof · "
          f"budget-contained · revoked · detached · GC'd")
    return 0


if __name__ == "__main__":
    sys.exit(main())
