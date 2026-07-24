#!/usr/bin/env python3
"""Benchmark Aiko's general ARC controller across local environments."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

os.environ.setdefault("ARC_MECHANICAL", "1")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--games", default="all")
    parser.add_argument("--max-actions", type=int, default=500)
    parser.add_argument(
        "--historical-structural",
        action="store_true",
        help=(
            "Reproduce the engine3 controller: enable frame-derived paint/region "
            "planners alongside the game-agnostic cognitive map. This uses no game IDs "
            "or recorded action traces, but is reported separately from strict mode."
        ),
    )
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.historical_structural:
        os.environ["ARC_LEGACY_HEURISTICS"] = "1"
    else:
        os.environ.pop("ARC_LEGACY_HEURISTICS", None)

    # arc_skill reads its mode at import time, so import the runner only after CLI
    # mode selection. Previously this module unconditionally removed the variable,
    # making the retained engine3 path impossible to reproduce.
    from run_offline import ARC_REPO, run
    games = (
        sorted(path.name for path in (ARC_REPO / "environment_files").iterdir() if path.is_dir())
        if args.games == "all"
        else [game.strip() for game in args.games.split(",") if game.strip()]
    )
    trials = []
    for game in games:
        try:
            trials.append(run(game, args.max_actions))
        except Exception as error:
            trials.append({"game": game, "error": f"{type(error).__name__}: {error}"})
    report = {
        "benchmark": (
            "Aiko engine3 structural ARC-AGI-3 controller"
            if args.historical_structural
            else "Aiko strict-general ARC-AGI-3 controller"
        ),
        "gameAgnostic": True,
        "recordedActionReplay": False,
        "legacyHeuristics": args.historical_structural,
        "maxActionsPerGame": args.max_actions,
        "games": len(games),
        "levelsCompleted": sum(int(t.get("levelsCompleted", 0)) for t in trials),
        "wins": sum(t.get("state") == "WIN" for t in trials),
        "errors": sum("error" in t for t in trials),
        "contractRequired": os.environ.get("ARC_CONTRACT_REQUIRED", "") in ("1", "true", "True"),
        "contractCalls": sum(int(t.get("contractCalls", 0)) for t in trials),
        "trials": trials,
    }
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("games", "levelsCompleted", "wins", "errors")}, indent=2))


if __name__ == "__main__":
    main()
