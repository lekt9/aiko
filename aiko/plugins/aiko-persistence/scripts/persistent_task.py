#!/usr/bin/env python3
"""Small local state machine for witness-gated persistent tasks."""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


STATE = Path(".aiko/persistent-task.json")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load() -> dict:
    if not STATE.is_file():
        raise SystemExit("persistent task is not armed")
    return json.loads(STATE.read_text(encoding="utf-8"))


def save(data: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temporary.replace(STATE)


def arm(args: argparse.Namespace) -> None:
    if not args.manual and not args.check:
        raise SystemExit("arm requires --check or --manual")
    save({
        "version": 1,
        "goal": args.goal,
        "check": args.check,
        "manual": args.manual,
        "started_at": now(),
        "attempts": 0,
        "unchanged_failures": 0,
        "last_result": None,
        "notes": [],
    })
    print(f"persistent task armed: {args.goal}")


def check(_: argparse.Namespace) -> None:
    data = load()
    command = data.get("check")
    if not command:
        print("manual review required: " + data["goal"])
        raise SystemExit(2)
    result = subprocess.run(command, shell=True, text=True, capture_output=True)
    combined = (result.stdout + result.stderr).strip()
    signature = f"{result.returncode}:{combined}"
    data["attempts"] += 1
    if result.returncode == 0:
        data["unchanged_failures"] = 0
    elif signature == data.get("last_result"):
        data["unchanged_failures"] += 1
    else:
        data["unchanged_failures"] = 1
    data["last_result"] = signature
    data["checked_at"] = now()
    save(data)
    if combined:
        print(combined)
    if result.returncode != 0 and data["unchanged_failures"] >= 2:
        print("ADAPT: completion evidence is unchanged; use a different approach.")
    raise SystemExit(result.returncode)


def note(args: argparse.Namespace) -> None:
    data = load()
    data["notes"] = (data.get("notes", []) + [{"at": now(), "text": args.text}])[-20:]
    save(data)


def status(_: argparse.Namespace) -> None:
    print(json.dumps(load(), indent=2))


def finish(_: argparse.Namespace) -> None:
    if STATE.exists():
        STATE.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    arm_parser = commands.add_parser("arm")
    arm_parser.add_argument("--goal", required=True)
    arm_parser.add_argument("--check")
    arm_parser.add_argument("--manual", action="store_true")
    arm_parser.set_defaults(run=arm)
    commands.add_parser("check").set_defaults(run=check)
    note_parser = commands.add_parser("note")
    note_parser.add_argument("text")
    note_parser.set_defaults(run=note)
    commands.add_parser("status").set_defaults(run=status)
    commands.add_parser("complete").set_defaults(run=finish)
    commands.add_parser("cancel").set_defaults(run=finish)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
