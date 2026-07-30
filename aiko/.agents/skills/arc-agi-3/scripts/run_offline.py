#!/usr/bin/env python3
"""Run the ported Aiko ARC-AGI-3 organs against the real offline engine."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

ARC_REPO = Path(
    os.environ.get("ARC_AGI3_REPO", "/Users/lewis/Unbrowse/ARC-AGI-3-Agents")
).expanduser().resolve()
os.environ.setdefault("ENVIRONMENTS_DIR", str(ARC_REPO / "environment_files"))
os.environ.setdefault("ARC_MECHANICAL", "1")
sys.path.insert(0, str(ARC_REPO))

from arc_agi import Arcade, OperationMode  # noqa: E402
from arcengine import FrameData, GameAction, GameState  # noqa: E402
from arc_skill import ArcSkill  # noqa: E402


def frame_data(raw: Any) -> FrameData:
    return FrameData(
        game_id=raw.game_id,
        frame=[grid.tolist() for grid in raw.frame],
        state=raw.state,
        levels_completed=raw.levels_completed,
        win_levels=raw.win_levels,
        guid=raw.guid,
        full_reset=raw.full_reset,
        available_actions=raw.available_actions,
    )


def make_action(action_id: int, x: int | None, y: int | None) -> GameAction:
    action = GameAction.from_id(int(action_id))
    if int(action_id) == 6:
        action.set_data(
            {
                "x": max(0, min(63, 32 if x is None else int(x))),
                "y": max(0, min(63, 32 if y is None else int(y))),
            }
        )
    return action


def run(game: str, max_actions: int) -> dict[str, Any]:
    arcade = Arcade(operation_mode=OperationMode.OFFLINE)
    scorecard = arcade.open_scorecard()
    environment = arcade.make(game, scorecard_id=scorecard)
    if environment is None:
        raise RuntimeError(f"offline ARC environment unavailable: {game}")
    reset = GameAction.RESET
    latest = frame_data(environment.step(reset, data=reset.action_data.model_dump()))
    skill = ArcSkill()
    transitions: list[dict[str, Any]] = []
    started = time.perf_counter()
    try:
        for step in range(max_actions):
            if latest.state in (GameState.WIN, GameState.GAME_OVER):
                break
            action_id, x, y, organ = skill.decide(latest)
            legal = [int(value) for value in (latest.available_actions or [])]
            if legal and int(action_id) not in legal:
                raise RuntimeError(f"solver selected illegal action {action_id}; legal={legal}")
            before = int(latest.levels_completed or 0)
            action = make_action(action_id, x, y)
            latest = frame_data(environment.step(action, data=action.action_data.model_dump()))
            transitions.append(
                {
                    "step": step + 1,
                    "action": int(action_id),
                    "x": x,
                    "y": y,
                    "organ": organ,
                    "levelsBefore": before,
                    "levelsAfter": int(latest.levels_completed or 0),
                    "state": latest.state.name,
                }
            )
    finally:
        arcade.close_scorecard(scorecard)
    return {
        "solver": "aiko-arc-skill",
        "mode": "offline-mechanical",
        "game": game,
        "actions": len(transitions),
        "levelsCompleted": int(latest.levels_completed or 0),
        "winLevels": int(latest.win_levels or 0),
        "state": latest.state.name,
        "durationMs": round((time.perf_counter() - started) * 1000, 2),
        "contractCalls": int(getattr(skill, "_contract_calls", 0)),
        "contractLibrary": str(getattr(getattr(skill, "_contract", None), "path", "")) or None,
        "transitions": transitions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", default="ls20")
    parser.add_argument("--max-actions", type=int, default=10)
    parser.add_argument("--output")
    args = parser.parse_args()
    report = run(args.game, args.max_actions)
    payload = json.dumps(report, indent=2)
    if args.output:
        Path(args.output).write_text(payload + "\n")
    print(payload)


if __name__ == "__main__":
    main()
