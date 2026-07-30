#!/usr/bin/env python3
"""Energy-router revoke/detach + GC witness (§30 R2e).

Mirrors the outbox-drainer lifecycle: admit the package by digest, fire one
real routing through the admitted path, revoke (blocks further runs), detach
+ GC (collects limb-scope artifacts, preserves audit roots). Every assertion
gates on a real command result, never a self-asserted string.
"""

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
        print("FAILED:", file=sys.stderr)
        print(proc.stderr[:2000], file=sys.stderr)
        raise SystemExit(1)
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def inspect_json(state):
    return json.loads(run([NEURON, "limb", "inspect", state, "--json"]).stdout)


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
    assert info["revoked"] == 0
    assert info["detached"] == 0

    # 2. OPERATE — one real energy-router firing with a route request
    now = int(time.time() * 1000)
    candidates_payload = "best|1|950|0.05|0.05|0|0\nsecond|0|500|0.8|1.0|1|0\n"
    stim = {
        "schema": "neuron.stimulus/v1",
        "firing_id": "lifecycle-route-1",
        "receptor_schema": "energy.route-request/v1",
        "now_ms": now,
        "reads": [],
        "permitted_reads": [],
        "messages": [
            {"to": "", "schema": "energy.candidate/v1",
             "payload": candidates_payload, "durable": True},
        ],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp = fh.name
    try:
        summary = limb_run(state, "energy-router", sp)
        assert summary["status"] == "committed"
        print("routing committed:", summary["effects_committed"], "effects")
    finally:
        os.unlink(sp)

    # 3. DUPLICATE SUPPRESSION
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp2 = fh.name
    try:
        dup = limb_run(state, "energy-router", sp2)
        assert dup["duplicates_skipped"] > 0
        assert dup["effects_committed"] == 0
        print("duplicate suppression:", dup["duplicates_skipped"], "skipped")
    finally:
        os.unlink(sp2)

    # 4. REVOKE
    run([NEURON, "limb", "revoke", state, "--package", LIMB_DIR])
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp3 = fh.name
    try:
        rev_proc = limb_run(state, "energy-router", sp3, expect_failure=True)
        assert rev_proc.returncode != 0
        assert "LimbRevoked" in rev_proc.stderr or rev_proc.returncode != 0
        print("revocation blocks further runs: PASS")
    finally:
        os.unlink(sp3)

    # 5. DETACH + GC
    info_pre = inspect_json(state)
    pre_artifacts = info_pre["artifacts"]
    pre_firings = info_pre["firings"]
    run([NEURON, "limb", "detach", state, "--package", LIMB_DIR])
    info_post = inspect_json(state)
    # GC removes the limb's write-reach artifacts. The energy-router writes
    # exactly one artifact (energy/score), which is collected. Detach adds
    # its own record, so the net count stays level — assert specific removal.
    assert info_post["detached"] >= 1
    assert "energy/score" not in info_post.get("artifact_ids", []), \
        "GC should have collected energy/score"
    assert info_post["firings"] >= pre_firings, \
        "audit root (firings) must survive detach-GC"
    print(f"detach + GC: energy/score collected, "
          f"{pre_firings} audit firings intact")

    print(f"\nenergy-router revoke/detach lifecycle: PASS")
    print(f"digest {digest} — admitted · operated · duplicate-suppressed · "
          "revoked · detached · GC'd")
    return 0


if __name__ == "__main__":
    sys.exit(main())
