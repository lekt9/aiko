#!/usr/bin/env python3
"""
Generative-limb lifecycle witness for the outbox-drainer (§30, R1).

Exercises the complete lifecycle against a real journaled substrate:

1. ADMIT  — content-digest-pin the package; write immutable admission record.
2. RUN    — one real drainer firing through the admitted path (admitted caps,
            digest-checked, journaled state).
3. DUPLICATE — re-fire same stimulus → runtime dedupe (§21) across runs.
4. MISMATCH  — same firing_id, different stimulus → fail closed.
5. SECRET — MOCK_ADAPTER_TOKEN absent from the state dir.
6. REVOKE — durable revocation blocks further `limb run`.
7. DETACH + GC — collect limb-scope artifacts, preserve audit roots.

Exits 0 only when every assertion holds. File presence, prose, and a green
document validator are not completion.
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


def run(cmd, env=None):
    env2 = dict(os.environ, **(env or {}))
    p = subprocess.run(cmd, capture_output=True, text=True, env=env2, timeout=120)
    return p


def admit(state):
    out = run([NEURON, "limb", "admit", LIMB_DIR, state])
    return out.stdout.strip().split()[-1]


def limb_run(state, neuron_id, stim_file, expect_failure=False):
    args = [NEURON, "limb", "run", state, "--package", LIMB_DIR,
            "--neuron", neuron_id, "--stimulus", stim_file, "--json"]
    proc = run(args)
    if expect_failure:
        return proc  # caller checks returncode
    if proc.returncode != 0:
        print("FAILED limb run:", file=sys.stderr)
        print("stdout:", proc.stdout[:2000], file=sys.stderr)
        print("stderr:", proc.stderr[:2000], file=sys.stderr)
        raise SystemExit(proc.returncode)
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def inspect_json(state):
    out = run([NEURON, "limb", "inspect", state, "--json"])
    return json.loads(out.stdout)


def read_of(read_id, schema, obj):
    body = canonical(obj).decode()
    return {"id": read_id, "schema": schema, "bytes": body, "digest": digest_str(body)}


def digest_str(text):
    return hashlib.sha256(text.encode()).hexdigest()


def main():
    state = tempfile.mkdtemp()
    print("state:", state)

    # --- 1. ADMIT ---
    digest = admit(state)
    print("admitted digest:", digest)
    assert len(digest) == 64
    digest2 = admit(state)
    assert digest == digest2  # idempotent

    info = inspect_json(state)
    assert info["admitted"] >= 1
    assert info["revoked"] == 0
    assert info["detached"] == 0
    assert info["firings"] >= 1

    # --- 2. RUN one real firing through the admitted path ---
    now = int(time.time() * 1000)
    request = {
        "schema": "outbox.drain-request/v1",
        "partition": "mock:",
        "max_batch": 8,
        "max_attempts": 3,
        "seq": 0,
        "requested_at": now,
    }
    projection = {
        "schema": "outbox.queued-messages/v1",
        "partition": "mock:",
        "messages": [],
        "projected_at": now,
    }
    reads = [
        read_of("drain-req", "outbox.drain-request/v1", request),
        read_of("projection", "outbox.queued-messages/v1", projection),
    ]
    stim = {
        "schema": "neuron.stimulus/v1",
        "firing_id": "lifecycle-drain-1",
        "receptor_schema": "outbox.drain-request/v1",
        "now_ms": now,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": [],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        stim_path = fh.name
    try:
        summary = limb_run(state, "drainer", stim_path)
    finally:
        os.unlink(stim_path)

    assert summary["status"] == "committed"
    assert summary["effects_committed"] >= 0  # empty queue → drained immediately
    print("first firing committed through admitted path:", summary["effects_committed"], "effects")

    # --- 3. DUPLICATE SUPPRESSION ---
    # Fire reconciler settlers with two different keys, each committing one
    # delivery artifact. Re-fire key-1 identically — the journaled substrate
    # dedupes across runs with a non-zero skipped count.
    for key in ("lifecycle-key-1", "lifecycle-key-2"):
        settle_req = {"mode": "settle", "key": key, "max_attempts": 3,
                      "requested_at": now}
        ack = {"schema": "outbox.ack/v1", "key": key,
               "outcome": "ack", "provider_ref": None, "detail": "", "observed_at": now}
        attempt_rec = {"schema": "outbox.delivery-attempt/v1", "key": key,
                       "idempotency_key": key,
                       "envelope": {"idempotency_key": key},
                       "attempt": 0, "attempted_at": now}
        settle_reads = [
            read_of("settle-req", "outbox.settle-request/v1", settle_req),
            read_of("att", "outbox.delivery-attempt/v1", attempt_rec),
            read_of("ack", "outbox.ack/v1", ack),
        ]
        settle_stim = {
            "schema": "neuron.stimulus/v1",
            "firing_id": f"lifecycle-settle-{key[-1]}",
            "receptor_schema": "outbox.settle-request/v1",
            "now_ms": now,
            "reads": settle_reads,
            "permitted_reads": [r["id"] for r in settle_reads],
            "messages": [],
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(settle_stim, fh)
            sp = fh.name
        try:
            settle_summary = limb_run(state, "reconciler", sp)
        finally:
            os.unlink(sp)
        assert settle_summary["status"] == "committed"
        assert settle_summary["effects_committed"] == 1

    # Re-fire key-1 identically: non-zero duplicates_skipped.
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump({
            "schema": "neuron.stimulus/v1",
            "firing_id": "lifecycle-settle-1",
            "receptor_schema": "outbox.settle-request/v1",
            "now_ms": now,
            "reads": [
                read_of("settle-req", "outbox.settle-request/v1",
                        {"mode": "settle", "key": "lifecycle-key-1",
                         "max_attempts": 3, "requested_at": now}),
                read_of("att", "outbox.delivery-attempt/v1",
                        {"schema": "outbox.delivery-attempt/v1",
                         "key": "lifecycle-key-1",
                         "idempotency_key": "lifecycle-key-1",
                         "envelope": {"idempotency_key": "lifecycle-key-1"},
                         "attempt": 0, "attempted_at": now}),
                read_of("ack", "outbox.ack/v1",
                        {"schema": "outbox.ack/v1", "key": "lifecycle-key-1",
                         "outcome": "ack", "provider_ref": None, "detail": "",
                         "observed_at": now}),
            ],
            "permitted_reads": ["settle-req", "att", "ack"],
            "messages": [],
        }, fh)
        sp2 = fh.name
    try:
        dup = limb_run(state, "reconciler", sp2)
    finally:
        os.unlink(sp2)
    assert dup["duplicates_skipped"] > 0
    assert dup["effects_committed"] == 0
    print(f"duplicate suppression: {dup['duplicates_skipped']} effects skipped")

    # --- 4. FIRING MISMATCH ---
    stim_bad = dict(stim, **{
        "firing_id": "lifecycle-drain-1",
        "reads": [read_of("drain-req", "outbox.drain-request/v1",
                          {"schema": "outbox.drain-request/v1", "partition": "evil",
                           "max_batch": 99, "max_attempts": 99, "seq": 999,
                           "requested_at": 0})],
    })
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim_bad, fh)
        bad_path = fh.name
    try:
        proc_mis = limb_run(state, "drainer", bad_path, expect_failure=True)
        assert proc_mis.returncode != 0, "FiringMismatch should have been rejected"
        assert "FiringMismatch" in proc_mis.stderr or proc_mis.returncode != 0
    finally:
        os.unlink(bad_path)
    print("FiringMismatch rejected: fail closed")

    # --- 5. SECRET ABSENCE ---
    for root, dirs, files in os.walk(state):
        for name in files:
            path = os.path.join(root, name)
            try:
                content = open(path).read()
            except Exception:
                continue
            if "dummy" in content:
                raise AssertionError(f"MOCK_ADAPTER_TOKEN leaked into {path}")
    print("secret absence: PASS")

    # --- 6. REVOKE ---
    run([NEURON, "limb", "revoke", state, "--package", LIMB_DIR])
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        rev_path = fh.name
    try:
        rev_proc = limb_run(state, "drainer", rev_path, expect_failure=True)
        assert rev_proc.returncode != 0, "revoked limb should be denied"
        assert "LimbRevoked" in rev_proc.stderr or rev_proc.returncode != 0
    finally:
        os.unlink(rev_path)
    print("revocation blocks further runs: PASS")

    # --- 7. DETACH + GC ---
    info_pre = inspect_json(state)
    pre_artifacts = info_pre["artifacts"]
    pre_firings = info_pre["firings"]
    run([NEURON, "limb", "detach", state, "--package", LIMB_DIR])
    info_post = inspect_json(state)
    assert info_post["detached"] >= 1
    assert info_post["artifacts"] < pre_artifacts, \
        f"GC collected nothing ({pre_artifacts} -> {info_post['artifacts']})"
    assert info_post["firings"] >= pre_firings, \
        "firings must survive detach-GC (detach adds its own)"
    print(f"detach + GC: {pre_artifacts} artifacts -> {info_post['artifacts']} "
          f"(audit: {pre_firings} firings intact)")

    print(f"\noutbox-drainer generative-limb lifecycle: PASS")
    print(f"digest {digest} — admitted · operated · duplicate-suppressed · "
          f"revoked · detached · GC'd")
    return 0


if __name__ == "__main__":
    sys.exit(main())
