#!/usr/bin/env python3
"""Paired ARC-AGI-3 benchmark: fresh Contract/JESPA substrate vs no-Contract baseline."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SKILL = ROOT / ".agents/skills/arc-agi-3"
RUNNER = SKILL / "scripts/benchmark_native.py"
PYTHON = Path(os.environ.get("ARC_AGI3_PYTHON", "/Users/lewis/Unbrowse/ARC-AGI-3-Agents/.venv/bin/python"))
LIBRARY = Path(os.environ.get("AIKO_CONTRACT_LIBRARY", str(Path.home() / ".aiko/lib/libcontract.dylib")))
BINDINGS = Path(os.environ.get("CONTRACT_PYTHON_BINDINGS", "/Users/lewis/Unbrowse/contract/bindings/python"))


def run_variant(kind: str, games: str, actions: int, seed: int, rounds: int, root: Path) -> list[dict]:
    home = root / f"{kind}-{seed}"
    home.mkdir(parents=True)
    env = dict(os.environ)
    env.update({
        "HOME": str(home),
        "ARC_MECHANICAL": "1",
        "ARC_LEGACY_HEURISTICS": "0",
        "PYTHONHASHSEED": str(seed),
    })
    if kind == "jespa":
        env.update({
            "ARC_CONTRACT_REQUIRED": "1",
            "AIKO_CONTRACT_LIBRARY": str(LIBRARY),
            "CONTRACT_PYTHON_BINDINGS": str(BINDINGS),
        })
    else:
        env.update({
            "ARC_CONTRACT_REQUIRED": "0",
            "AIKO_CONTRACT_LIBRARY": str(home / "missing-libcontract.dylib"),
            "CONTRACT_PYTHON_BINDINGS": str(home / "missing-bindings"),
        })
    reports = []
    for round_number in range(1, rounds + 1):
        output = root / f"{kind}-{seed}-round-{round_number}.json"
        command = [
            str(PYTHON), str(RUNNER), "--games", games,
            "--max-actions", str(actions), "--output", str(output),
        ]
        result = subprocess.run(command, cwd=SKILL / "scripts", env=env, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(f"{kind} seed {seed} round {round_number} failed: {result.stderr or result.stdout}")
        report = json.loads(output.read_text())
        report.update(seed=seed, variant=kind, round=round_number)
        reports.append(report)
    return reports


def completion_actions(report: dict) -> int:
    total = 0
    for trial in report["trials"]:
        for transition in trial.get("transitions", []):
            if int(transition["levelsAfter"]) > int(transition["levelsBefore"]):
                total += int(transition["step"])
    return total


def score(report: dict) -> tuple[int, int, int]:
    # ARC scoring is completion first. For equal completion, fewer actions used
    # to reach the completed levels is the honest efficiency tiebreaker.
    return int(report["levelsCompleted"]), int(report["wins"]), -completion_actions(report)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--games", default="sb26,ls20,ar25")
    parser.add_argument("--max-actions", type=int, default=150)
    parser.add_argument("--seeds", default="11,29")
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--assert-win", action="store_true")
    args = parser.parse_args()
    seeds = [int(value) for value in args.seeds.split(",") if value]
    work = Path(tempfile.mkdtemp(prefix="aiko-arc-jespa-"))
    try:
        trials = []
        for seed in seeds:
            trials.extend(run_variant("jespa", args.games, args.max_actions, seed, args.rounds, work))
            trials.extend(run_variant("baseline", args.games, args.max_actions, seed, args.rounds, work))
        # Earlier rounds are training evidence. Score only the final replay.
        jespa = [trial for trial in trials if trial["variant"] == "jespa" and trial["round"] == args.rounds]
        baseline = [trial for trial in trials if trial["variant"] == "baseline" and trial["round"] == args.rounds]
        if any(trial["errors"] for trial in trials):
            raise RuntimeError("ARC engine reported trial errors")
        if any(trial["contractCalls"] <= 0 for trial in jespa):
            raise RuntimeError("JESPA arm made no native Contract calls")
        if any(trial["contractCalls"] != 0 for trial in baseline):
            raise RuntimeError("baseline unexpectedly used native Contract")
        jespa_score = tuple(sum(score(trial)[i] for trial in jespa) for i in range(3))
        baseline_score = tuple(sum(score(trial)[i] for trial in baseline) for i in range(3))
        won = jespa_score > baseline_score
        game_names = [trial["game"] for trial in jespa[0]["trials"]]
        payload = {
            "benchmark": "ARC-AGI-3 fresh-store Contract/JESPA vs Python cognitive-map baseline",
            "games": game_names,
            "maxActionsPerGame": args.max_actions,
            "seeds": seeds,
            "rounds": args.rounds,
            "metric": "aggregate (levels completed, full-game wins, negative actions-to-completion), lexicographic",
            "jespa": {"levelsCompleted": jespa_score[0], "wins": jespa_score[1], "completionActions": -jespa_score[2]},
            "baseline": {"levelsCompleted": baseline_score[0], "wins": baseline_score[1], "completionActions": -baseline_score[2]},
            "won": won,
            "trials": trials,
        }
        text = json.dumps(payload, indent=2) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text)
        print(json.dumps({
            "games": len(payload["games"]),
            "seeds": seeds,
            "rounds": args.rounds,
            "jespa": payload["jespa"],
            "baseline": payload["baseline"],
            "won": won,
        }, indent=2))
        return 0 if won or not args.assert_win else 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
