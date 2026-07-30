#!/usr/bin/env python3
"""Compare the installed Aiko and Grok CLIs on identical offline ARC-AGI-3 games."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ARC_REPO = Path(os.environ.get("ARC_AGI3_REPO", "/Users/lewis/Unbrowse/ARC-AGI-3-Agents"))
ENVIRONMENTS = ARC_REPO / "environment_files"
RUN_ROOT = Path(os.environ.get("ARC_AGI3_RUN_ROOT", ROOT / "benchmarks/arc-agi3/latest"))
JSON_OUT = Path(os.environ.get("ARC_AGI3_JSON_OUT", ROOT / "docs/AIKO-VS-GROK-ARC-AGI3.json"))
MD_OUT = Path(os.environ.get("ARC_AGI3_MD_OUT", ROOT / "docs/AIKO-VS-GROK-ARC-AGI3.md"))
AIKO = os.environ.get("AIKO_BIN", "/Users/lewis/bin/aiko")
GROK = os.environ.get(
    "GROK_BIN",
    str(ROOT / "benchmarks/tools/grok-cli/node_modules/.bin/grok"),
)
GAMES = [g for g in os.environ.get("ARC_AGI3_GAMES", "ls20").split(",") if g]
MAX_ACTIONS = int(os.environ.get("ARC_AGI3_MAX_ACTIONS", "3"))
MAX_TURNS = int(os.environ.get("ARC_AGI3_MAX_TURNS", "3"))
TURN_TIMEOUT = int(os.environ.get("ARC_AGI3_TURN_TIMEOUT", "240"))
CONCURRENCY = int(os.environ.get("ARC_AGI3_CONCURRENCY", "1"))

os.environ["ENVIRONMENTS_DIR"] = str(ENVIRONMENTS)
sys.path.insert(0, str(ARC_REPO))

from arc_agi import Arcade, OperationMode  # noqa: E402
from arcengine import FrameData, GameAction, GameState  # noqa: E402


def version(binary: str) -> str:
    result = subprocess.run([binary, "--version"], text=True, capture_output=True, timeout=10)
    return (result.stdout or result.stderr).strip()


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


def compact_grid(frame: FrameData) -> str:
    grid = frame.frame[-1]
    return "\n".join("".join(str(int(cell)) for cell in row) for row in grid)


def prompt_for(game: str, frame: FrameData, history: list[dict[str, Any]]) -> str:
    legal = [int(action) for action in (frame.available_actions or [])]
    return f"""You are controlling one unseen ARC-AGI-3 interactive puzzle through an offline evaluator.
Infer the rule from the current 64x64 color grid and prior transitions, then choose exactly ONE legal action.
Actions are integer IDs. ACTION6 is a click and requires x=column, y=row, each 0..63.
Return only compact JSON: {{"action":N,"x":N|null,"y":N|null,"reason":"brief falsifiable prediction"}}.
Do not request tools, inspect files, explain outside JSON, or assume access to the game implementation.

GAME={game}
STATE={frame.state.name}
LEVELS_COMPLETED={frame.levels_completed or 0}
WIN_LEVELS={frame.win_levels}
AVAILABLE_ACTIONS={legal}
RECENT_TRANSITIONS={json.dumps(history[-4:], separators=(',', ':'))}
GRID_ROWS_BEGIN
{compact_grid(frame)}
GRID_ROWS_END"""


def parse_json_object(text: str) -> dict[str, Any] | None:
    text = text.strip()
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass
    for match in re.finditer(r"\{[^{}]*\}", text, re.DOTALL):
        try:
            value = json.loads(match.group(0))
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and "action" in value:
            return value
    return None


def choose(binary: str, model: str, cwd: Path, prompt: str) -> dict[str, Any]:
    command = [
        binary,
        "--single",
        prompt,
        "--cwd",
        str(cwd),
        "--model",
        model,
        "--max-turns",
        str(MAX_TURNS),
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
        "--no-memory",
        "--no-subagents",
        "--disable-web-search",
        "--no-plan",
    ]
    started = time.perf_counter()
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            capture_output=True,
            timeout=TURN_TIMEOUT,
        )
    except subprocess.TimeoutExpired as error:
        return {
            "ok": False,
            "durationMs": round((time.perf_counter() - started) * 1000, 2),
            "error": f"timeout after {TURN_TIMEOUT}s",
            "stdout": error.stdout or "",
            "stderr": error.stderr or "",
        }
    elapsed = round((time.perf_counter() - started) * 1000, 2)
    envelope: dict[str, Any] | None = None
    try:
        parsed = json.loads(result.stdout)
        envelope = parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    answer = str((envelope or {}).get("text", result.stdout))
    action = parse_json_object(answer)
    return {
        "ok": result.returncode == 0 and action is not None,
        "durationMs": elapsed,
        "exitCode": result.returncode,
        "stopReason": (envelope or {}).get("stopReason"),
        "answer": answer,
        "action": action,
        "stderr": result.stderr,
    }


def make_action(blob: dict[str, Any] | None, legal: list[int]) -> GameAction:
    try:
        action_id = int((blob or {}).get("action"))
    except (TypeError, ValueError):
        action_id = legal[0] if legal else 1
    if legal and action_id not in legal:
        action_id = legal[0]
    action = GameAction.from_id(action_id)
    if action_id == 6:
        try:
            x = max(0, min(63, int((blob or {}).get("x", 32))))
            y = max(0, min(63, int((blob or {}).get("y", 32))))
        except (TypeError, ValueError):
            x, y = 32, 32
        action.set_data({"x": x, "y": y})
    return action


def run_game(harness: str, binary: str, model: str, game: str) -> dict[str, Any]:
    workspace = (RUN_ROOT / harness / game).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    arcade = Arcade(operation_mode=OperationMode.OFFLINE)
    card = arcade.open_scorecard()
    environment = arcade.make(game, scorecard_id=card)
    started = time.perf_counter()
    calls: list[dict[str, Any]] = []
    history: list[dict[str, Any]] = []
    error: str | None = None
    actions = 0
    if environment is None:
        error = "offline environment unavailable"
        latest = None
    else:
        latest = frame_data(environment.observation_space)
        reset = GameAction.RESET
        latest = frame_data(environment.step(reset, data=reset.action_data.model_dump()))
        for step in range(MAX_ACTIONS):
            if latest.state is GameState.WIN:
                break
            decision = choose(binary, model, workspace, prompt_for(game, latest, history))
            calls.append(decision)
            if not decision["ok"]:
                error = decision.get("error") or decision.get("stderr") or "invalid response"
                break
            legal = [int(action) for action in (latest.available_actions or [])]
            action = make_action(decision.get("action"), legal)
            before_level = int(latest.levels_completed or 0)
            before_state = latest.state.name
            latest = frame_data(
                environment.step(action, data=action.action_data.model_dump())
            )
            actions += 1
            history.append(
                {
                    "step": step + 1,
                    "action": int(action.value),
                    "x": getattr(action.action_data, "x", None),
                    "y": getattr(action.action_data, "y", None),
                    "beforeLevel": before_level,
                    "afterLevel": int(latest.levels_completed or 0),
                    "beforeState": before_state,
                    "afterState": latest.state.name,
                }
            )
    try:
        arcade.close_scorecard(card)
    except Exception:
        pass
    return {
        "harness": harness,
        "model": model,
        "game": game,
        "levelsCompleted": int(latest.levels_completed or 0) if latest else 0,
        "winLevels": int(latest.win_levels or 0) if latest else 0,
        "won": bool(latest and latest.state is GameState.WIN),
        "actions": actions,
        "modelCalls": len(calls),
        "durationMs": round((time.perf_counter() - started) * 1000, 2),
        "error": error,
        "transitions": history,
        "calls": calls,
    }


def main() -> None:
    if not ENVIRONMENTS.is_dir():
        raise SystemExit(f"ARC-AGI-3 environments not found: {ENVIRONMENTS}")
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    harnesses = [
        ("aiko", AIKO, os.environ.get("AIKO_MODEL", "mimo-v2.5")),
        ("grok", GROK, os.environ.get("GROK_MODEL", "grok-4.5")),
    ]
    jobs = [(game, harness, binary, model) for game in GAMES for harness, binary, model in harnesses]
    trials = []
    if CONCURRENCY > 1:
        with ThreadPoolExecutor(max_workers=min(CONCURRENCY, len(jobs))) as pool:
            pending = {}
            for game, harness, binary, model in jobs:
                print(f"running {harness} on {game} ({MAX_ACTIONS} actions max)...", flush=True)
                pending[pool.submit(run_game, harness, binary, model, game)] = (game, harness)
            for future in as_completed(pending):
                trials.append(future.result())
        order = {(game, harness): index for index, (game, harness, _, _) in enumerate(jobs)}
        trials.sort(key=lambda trial: order[(trial["game"], trial["harness"])])
    else:
        for game, harness, binary, model in jobs:
            print(f"running {harness} on {game} ({MAX_ACTIONS} actions max)...", flush=True)
            trials.append(run_game(harness, binary, model, game))
    summary = {}
    for harness, _, _ in harnesses:
        selected = [trial for trial in trials if trial["harness"] == harness]
        summary[harness] = {
            "games": len(selected),
            "levelsCompleted": sum(t["levelsCompleted"] for t in selected),
            "wins": sum(1 for t in selected if t["won"]),
            "actions": sum(t["actions"] for t in selected),
            "modelCalls": sum(t["modelCalls"] for t in selected),
            "durationMs": round(sum(t["durationMs"] for t in selected), 2),
            "errors": sum(1 for t in selected if t["error"]),
        }
    report = {
        "schemaVersion": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "benchmark": "ARC-AGI-3 offline interactive harness comparison",
        "fairness": {
            "games": GAMES,
            "maxActionsPerGame": MAX_ACTIONS,
            "oneFreshCliInvocationPerAction": True,
            "maxHarnessTurnsPerAction": MAX_TURNS,
            "sameRawGridAndTransitionPrompt": True,
            "sourceAndReplaysHiddenFromPrompt": True,
            "parallelIndependentScorecards": CONCURRENCY > 1,
            "scoring": "exact levels_completed from local arc_agi engine",
        },
        "versions": {"aiko": version(AIKO), "grok": version(GROK)},
        "summary": summary,
        "trials": trials,
    }
    JSON_OUT.parent.mkdir(parents=True, exist_ok=True)
    JSON_OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    rows = "\n".join(
        f"| {t['game']} | {t['harness']} | {t['model']} | {t['levelsCompleted']} | {t['actions']} | {t['modelCalls']} | {t['durationMs']/1000:.1f} | {t['error'] or 'none'} |"
        for t in trials
    )
    MD_OUT.write_text(
        f"""# Aiko versus Grok on ARC-AGI-3

Generated: `{report['generatedAt']}`

This is a local offline ARC-AGI-3 comparison, not a leaderboard submission. Both harnesses received the same raw frame and transition format, one fresh model turn per action, and a {MAX_ACTIONS}-action cap per game. Exact progress comes from the local `arc_agi` engine.

| Game | Harness | Model | Levels | Actions | Model calls | Seconds | Error |
|---|---|---|---:|---:|---:|---:|---|
{rows}

## Aggregate

| Harness | Games | Levels | Wins | Actions | Calls | Seconds | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| Aiko | {summary['aiko']['games']} | {summary['aiko']['levelsCompleted']} | {summary['aiko']['wins']} | {summary['aiko']['actions']} | {summary['aiko']['modelCalls']} | {summary['aiko']['durationMs']/1000:.1f} | {summary['aiko']['errors']} |
| Grok | {summary['grok']['games']} | {summary['grok']['levelsCompleted']} | {summary['grok']['wins']} | {summary['grok']['actions']} | {summary['grok']['modelCalls']} | {summary['grok']['durationMs']/1000:.1f} | {summary['grok']['errors']} |
""",
        encoding="utf-8",
    )
    print(json.dumps({"summary": summary, "json": str(JSON_OUT), "markdown": str(MD_OUT)}, indent=2))


if __name__ == "__main__":
    main()
