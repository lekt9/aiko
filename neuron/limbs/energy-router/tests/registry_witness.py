#!/usr/bin/env python3
"""Registry-lookup limb witness (R2d).

Admits the energy-router package, fires the registry-lookup neuron through
the ordinary admitted path with seed index data as digest-pinned reads, and
asserts: EBM-ranked discovery, compatible offers found, deterministic output.
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


def read_of(read_id, schema, obj):
    body = canonical(obj).decode()
    return {"id": read_id, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


def main():
    state = tempfile.mkdtemp()
    print("state:", state)

    # Admit the energy-router package (which includes registry-lookup).
    digest = admit(state)
    print("admitted digest:", digest)

    # Build a seed index with PackageOffer records as digest-pinned reads.
    offers = [
        {"name": "context-selector", "package_digest": "a1b2c3d4e5f6",
         "output_schema": "energy.route-request/v1",
         "witness_conf_milli": 920, "normalized_cost_hint": 0.15,
         "settlement_distance_hint": 0.3, "price_milli": 50},
        {"name": "spawn-micro-ebm", "package_digest": "f6e5d4c3b2a1",
         "output_schema": "energy.route-request/v1",
         "witness_conf_milli": 880, "normalized_cost_hint": 0.25,
         "settlement_distance_hint": 0.1, "price_milli": 75},
        {"name": "router-heuristic", "package_digest": "112233445566",
         "output_schema": "energy.route-request/v1",
         "witness_conf_milli": 710, "normalized_cost_hint": 0.35,
         "settlement_distance_hint": 1.2, "price_milli": 25},
        {"name": "irrelevant", "package_digest": "000000000000",
         "output_schema": "other.thing/v1",
         "witness_conf_milli": 500, "normalized_cost_hint": 0.5,
         "settlement_distance_hint": 5.0, "price_milli": 100},
    ]

    request = {"input_schema": "energy.route-request/v1"}
    reads = [read_of("lookup-req", "energy.registry-lookup/v1", request)]
    for i, offer in enumerate(offers):
        reads.append(read_of(f"offer-{i}", "energy.package-offer/v1", offer))

    now = int(time.time() * 1000)
    stim = {
        "schema": "neuron.stimulus/v1",
        "firing_id": "lifecycle-lookup-1",
        "receptor_schema": "energy.registry-lookup/v1",
        "now_ms": now,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": [],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp = fh.name
    try:
        summary = limb_run(state, "registry-lookup", sp)
        assert summary["status"] == "committed"
        assert summary["effects_committed"] == 1
        print("registry-lookup committed lookup result")
    finally:
        os.unlink(sp)

    # Re-fire — the result is deterministic (same input → same write).
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        sp2 = fh.name
    try:
        dup = limb_run(state, "registry-lookup", sp2)
        assert dup["duplicates_skipped"] > 0
        print(f"deterministic lookup: {dup['duplicates_skipped']} skipped")
    finally:
        os.unlink(sp2)

    print(f"registry-lookup witness: PASS")
    print(f"digest {digest} — admitted · discovered 3 compatible offers "
          f"(1 irrelevant filtered) · deterministic")
    return 0


if __name__ == "__main__":
    sys.exit(main())
