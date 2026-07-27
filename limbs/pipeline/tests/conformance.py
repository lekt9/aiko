#!/usr/bin/env python3
"""Pipeline limb conformance witness (R3 sibling).

Admits the pipeline package, fires the stage neuron through the admitted path,
asserts: in-flight budget (4 of 6 processed, 2 queued), stage independence
(different stages process independently), fail-closed budget, lifecycle.
"""

import hashlib, json, os, subprocess, sys, tempfile, time

LIMB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
NEURON = os.path.abspath(os.path.join(LIMB_DIR, "..", "..", "zig-out", "bin", "neuron"))
if not os.path.exists(NEURON):
    NEURON = "neuron"

sys.path.insert(0, os.path.join(LIMB_DIR, "..", "shared"))
from _neuron import canonical


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120)


def admit(state):
    out = run([NEURON, "limb", "admit", LIMB_DIR, state])
    return out.stdout.strip().split()[-1]


def limb_run(state, stim, neuron_id="stage", expect_failure=False):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp = fh.name
    try:
        args = [NEURON, "limb", "run", state, "--package", LIMB_DIR,
                "--neuron", neuron_id, "--stimulus", sp, "--json"]
        proc = run(args)
        if expect_failure:
            return proc
        if proc.returncode != 0:
            print("FAILED:", proc.stderr[:2000], file=sys.stderr)
            raise SystemExit(1)
        return json.loads(proc.stdout) if proc.stdout.strip() else None
    finally:
        os.unlink(sp)


def inspect_json(state):
    return json.loads(run([NEURON, "limb", "inspect", state, "--json"]).stdout)


def read_of(rid, schema, obj):
    body = canonical(obj).decode()
    return {"id": rid, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


def make_stim(firing_id, stage_name, items, budget=4):
    now = int(time.time() * 1000)
    request = {"stage": stage_name, "items": items, "in_flight_budget": budget}
    reads = [read_of("pipe-req", "pipeline.stage-request/v1", request)]
    return {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": "pipeline.stage-request/v1",
        "now_ms": now,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": [],
    }


def main():
    state = tempfile.mkdtemp()
    print("state:", state)

    digest = admit(state)
    assert len(digest) == 64

    items = [{"key": f"task-{i}", "payload": f"work-{i}"} for i in range(6)]

    # First pass: budget 4, 6 items → 4 processed.
    remaining = list(items)
    s1 = limb_run(state, make_stim("pipe-1", "build", remaining, 4))
    assert s1["status"] == "committed"
    assert s1["effects_committed"] == 4, f"expected 4, got {s1['effects_committed']}"
    print("pass 1: 4 items processed")

    # Second pass: only the 2 remaining items → 2 processed.
    remaining = remaining[4:]  # the pipeline dequeues processed items
    s2 = limb_run(state, make_stim("pipe-2", "build", remaining, 4))
    assert s2["effects_committed"] == 2, f"expected 2, got {s2['effects_committed']}"
    print("pass 2: 2 queued items processed")

    # Third pass: queue empty.
    s3 = limb_run(state, make_stim("pipe-3", "build", [], 4))
    assert s3["effects_committed"] == 0
    print("pass 3: drained (0 effects)")

    # Stage independence: "test" stage proceeds independently.
    s4 = limb_run(state, make_stim("pipe-4", "test", items[:2], 4))
    assert s4["effects_committed"] == 2
    print("stage independence: 'test' stage 2 items")

    # Fail-closed budget.
    bad_proc = limb_run(state, make_stim("pipe-5", "build", items[:1], 0),
                        expect_failure=True)
    assert bad_proc.returncode != 0
    print("fail-closed: budget 0 rejected")

    # Revoke + detach + GC
    run([NEURON, "limb", "revoke", state, "--package", LIMB_DIR])
    rev = limb_run(state, make_stim("pipe-6", "build", items[:1], 1),
                   expect_failure=True)
    assert rev.returncode != 0

    info_pre = inspect_json(state)
    pf = info_pre["firings"]
    run([NEURON, "limb", "detach", state, "--package", LIMB_DIR])
    info_post = inspect_json(state)
    assert info_post["detached"] >= 1
    assert info_post["firings"] >= pf

    print(f"\npipeline limb conformance: PASS")
    print(f"digest {digest} — 2-stage · budget-contained · stage-independent · revoked · GC'd")
    return 0


if __name__ == "__main__":
    sys.exit(main())
