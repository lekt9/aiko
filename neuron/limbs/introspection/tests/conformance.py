#!/usr/bin/env python3
"""Introspection limb conformance witness.

Admits the introspection package, fires the inspector neuron through the
admitted path with a minimal inspect request, and asserts a capability-map
artifact is committed. Lifecycle: duplicate suppression, revoke, detach+GC.
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

    # Admit
    digest = admit(state)
    print("admitted digest:", digest)
    assert len(digest) == 64
    assert digest == admit(state)

    # Fire inspector with a minimal inspect request
    now = int(time.time() * 1000)
    request = {"filters": {}, "include_metrics": False}
    reads = [read_of("insp-req", "neuron.inspect-request/v1", request)]
    stim = {
        "schema": "neuron.stimulus/v1",
        "firing_id": "lifecycle-inspect-1",
        "receptor_schema": "neuron.inspect-request/v1",
        "now_ms": now,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": [],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp = fh.name
    try:
        summary = limb_run(state, "inspector", sp)
        assert summary["status"] == "committed"
        assert summary["effects_committed"] == 1, f"got {summary['effects_committed']}"
        print("inspector committed capability map")
    finally:
        os.unlink(sp)

    # Duplicate suppression
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp2 = fh.name
    try:
        dup = limb_run(state, "inspector", sp2)
        assert dup["duplicates_skipped"] > 0
        print(f"duplicate: {dup['duplicates_skipped']} skipped")
    finally:
        os.unlink(sp2)

    # Revoke
    run([NEURON, "limb", "revoke", state, "--package", LIMB_DIR])
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp3 = fh.name
    try:
        rev = limb_run(state, "inspector", sp3, expect_failure=True)
        assert rev.returncode != 0
        assert "LimbRevoked" in rev.stderr or rev.returncode != 0
        print("revoke: PASS")
    finally:
        os.unlink(sp3)

    # Detach + GC
    info_pre = inspect_json(state)
    pre_firings = info_pre["firings"]
    run([NEURON, "limb", "detach", state, "--package", LIMB_DIR])
    info_post = inspect_json(state)
    assert info_post["detached"] >= 1
    assert info_post["firings"] >= pre_firings
    print(f"detach + GC: {pre_firings} audit firings intact")

    print(f"\nintrospection limb conformance: PASS")
    print(f"digest {digest} — admitted · inspected · duplicate-proof · revoked · detached")
    return 0


if __name__ == "__main__":
    sys.exit(main())
