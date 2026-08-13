#!/usr/bin/env python3
"""Synthetic Hoysan meta-fractal benchmark.

Measures the real local path without reading customer files:
Cell authoring -> authored tool -> Aiko self-seat -> aiko-doctor binding ->
Smithers runCell. Correctness is binding; timings are observational except for a
very generous hang guard.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
CELL = ROOT / "cell"
DOCTOR = ROOT / "zig-out/bin/aiko-doctor"
BUN_TEST = ROOT / "aiko-flow/packages/components/tests/runCell.test.js"


def run(cmd: list[str], *, cwd: Path = ROOT, expect: int = 0) -> tuple[float, subprocess.CompletedProcess[str]]:
    start = time.perf_counter()
    proc = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, timeout=30)
    elapsed = (time.perf_counter() - start) * 1000
    if proc.returncode != expect:
        raise RuntimeError(
            f"command returned {proc.returncode}, expected {expect}: {' '.join(cmd)}\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    return elapsed, proc


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int((len(ordered) - 1) * fraction)))]


def one_iteration(work: Path, index: int, hoysan_input: Path) -> tuple[dict[str, float], dict[str, str]]:
    iteration = work / str(index)
    iteration.mkdir()
    gap = iteration / "gap.json"
    gap.write_text(json.dumps({"gap": {"need": "roster level for hoysan shift fill"}}))
    authored = iteration / "authored"
    timings: dict[str, float] = {}

    timings["author_ms"], _ = run([
        "python3", str(CELL / "run.py"), "run", str(CELL / "primitives/author.cell.yaml"),
        "--inputs", str(gap), "--out", str(authored),
    ])
    raw = json.loads((authored / "cell_yaml.json").read_text())
    if not isinstance(raw, str) or "roster-level" not in raw:
        raise RuntimeError("author did not emit the bounded roster-level Cell")
    roster_cell = iteration / "roster-level.cell.yaml"
    roster_cell.write_text(raw)

    inputs = iteration / "fill.json"
    inputs.write_text(json.dumps({
        "requirement": {"target": 2, "shift": "D", "max_consecutive": 5},
        "workers": {"items": [
            {"id": "W01", "klass": "local", "name": "W01", "last_worked": "2026-08-01", "consecutive": 1},
            {"id": "W02", "klass": "ts", "name": "W02", "last_worked": "2026-08-02", "consecutive": 1},
            {"id": "W03", "klass": "nts", "name": "W03", "last_worked": "2026-08-03", "consecutive": 1},
        ]},
    }))
    roster_out = iteration / "roster-out"
    timings["tool_ms"], _ = run([
        "python3", str(CELL / "run.py"), "run", str(roster_cell),
        "--inputs", str(inputs), "--out", str(roster_out),
    ])
    roster = json.loads((roster_out / "roster.json").read_text())
    if roster.get("assigned") != ["W01", "W02"] or roster.get("count") != 2:
        raise RuntimeError(f"wrong deterministic roster: {roster}")

    hoysan_out = iteration / "hoysan-out"
    timings["hoysan_cell_ms"], _ = run([
        "python3", str(CELL / "run.py"), "run", str(CELL / "patterns/hoysan-draft/hoysan-draft.cell.yaml"),
        "--inputs", str(hoysan_input), "--out", str(hoysan_out),
    ])
    hoysan = json.loads((hoysan_out / "result.json").read_text())
    if hoysan.get("stats") != {"cranes_requested": 3, "cranes_filled": 3, "workers_deployed": 15}:
        raise RuntimeError(f"actual Hoysan Cell produced an invalid draft: {hoysan.get('stats')}")

    seat_inputs = iteration / "seat.json"
    seat_inputs.write_text(json.dumps({
        "account": {"tenant": "synthetic", "origin": "https://ops.invalid", "account_id": "aiko-foreman"},
        "role": "deployment-foreman", "outcome": "own daily pre-shift fill",
    }))
    seat_out = iteration / "seat-out"
    timings["self_wire_ms"], _ = run([
        "python3", str(CELL / "run.py"), "run", str(CELL / "patterns/fde/self-wire.cell.yaml"),
        "--inputs", str(seat_inputs), "--out", str(seat_out),
    ])
    handoff = json.loads((seat_out / "handoff.json").read_text())
    if handoff.get("agent") != "aiko" or not str(handoff.get("handle_id", "")).startswith("cred:"):
        raise RuntimeError(f"Aiko was not seated by opaque handle: {handoff}")
    serialized = json.dumps(handoff)
    if any(word in serialized.lower() for word in ('api_key', 'access_token', 'refresh_token', 'password')):
        raise RuntimeError("handoff leaked a secret-shaped field")

    if not DOCTOR.is_file():
        raise RuntimeError("aiko-doctor missing; run `zig build` before benchmarking")
    bind_path = iteration / "bind.json"
    timings["bind_ms"], bound = run([str(DOCTOR), "bind-workflow", str(roster_cell), "--plan"])
    bind_path.write_text(bound.stdout)
    binding = json.loads(bound.stdout)
    if binding["walk"]["nodes"][0]["id"] != "roster-level":
        raise RuntimeError("doctor did not bind the authored Cell")

    timings["total_ms"] = sum(timings.values())
    identities = {
        "authored_cell": sha(roster_cell),
        "roster": sha(roster_out / "roster.json"),
        "hoysan_result": sha(hoysan_out / "result.json"),
        "handoff": sha(seat_out / "handoff.json"),
        "binding_cell_digest": binding["cell"]["digest"],
    }
    return timings, identities


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=7)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.iterations < 2:
        parser.error("--iterations must be at least 2 to test determinism")

    all_timings: list[dict[str, float]] = []
    identities: list[dict[str, str]] = []
    smithers_ms, _ = run(
        ["bun", "test", "tests/runCell.test.js", "tests/hoysanRunCell.test.js"],
        cwd=ROOT / "aiko-flow/packages/components",
    )
    with tempfile.TemporaryDirectory(prefix="aiko-hoysan-bench-") as tmp:
        work = Path(tmp)
        synthetic = work / "synthetic"
        run(["python3", str(ROOT / "tests/fixtures/hoysan-synthetic/generate.py"), "--out", str(synthetic)])
        hoysan_input = synthetic / "feasible.json"
        # Refusal is part of performance and correctness: the broad product gap must stay closed.
        bad = work / "unbound.json"
        bad.write_text(json.dumps({"gap": {"need": "excel-native cloudflare neon hoysan product ui"}}))
        refusal_ms, refused = run([
            "python3", str(CELL / "run.py"), "run", str(CELL / "primitives/author.cell.yaml"),
            "--inputs", str(bad), "--out", str(work / "unbound-out"),
        ], expect=1)
        for i in range(args.iterations):
            timing, identity = one_iteration(work, i, hoysan_input)
            all_timings.append(timing)
            identities.append(identity)

    keys = list(all_timings[0])
    metrics = {
        key: {
            "median_ms": round(statistics.median(row[key] for row in all_timings), 3),
            "p95_ms": round(percentile([row[key] for row in all_timings], 0.95), 3),
            "min_ms": round(min(row[key] for row in all_timings), 3),
            "max_ms": round(max(row[key] for row in all_timings), 3),
        }
        for key in keys
    }
    stable = {key: len({row[key] for row in identities}) == 1 for key in identities[0]}
    report = {
        "schema": "aiko.hoysan-fractal-benchmark/v1",
        "fixture": "synthetic-only",
        "iterations": args.iterations,
        "refusal_ms": round(refusal_ms, 3),
        "smithers_run_cell_suite_ms": round(smithers_ms, 3),
        "deterministic": stable,
        "metrics": metrics,
        "pass": all(stable.values()) and refused.returncode != 0,
    }
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
