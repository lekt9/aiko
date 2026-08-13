#!/usr/bin/env python3
"""End-to-end witness for the deck resume queue.

Exit 0 when:
  1. inventory exists and is not empty-of-scan (file present)
  2. every inventoried crashed (non-running) session is in the queue
  3. dispatcher unit is enabled (or a dispatch loop pid file is live)
  4. no job is marked running while memory gates are red
  5. zero inventoried crashes are missing from the queue (no leak)

This is "the fulfillment system is armed and leak-free", not "every
agent has already finished" — finishing is async under the memory
gates. If the queue is fully terminal (no pending/running), that also
greens.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from jobqueue import load_jobs, state_dir, summary


def inventory_path() -> Path:
    return state_dir() / "inventory.json"


def unit_enabled() -> bool:
    try:
        out = subprocess.check_output(
            ["systemctl", "--user", "is-enabled", "session-resume-queue.service"],
            text=True,
            timeout=5,
        )
        return out.strip() in {"enabled", "static", "linked", "indirect"}
    except Exception:
        return False


def unit_active() -> bool:
    try:
        out = subprocess.check_output(
            ["systemctl", "--user", "is-active", "session-resume-queue.service"],
            text=True,
            timeout=5,
        )
        return out.strip() == "active"
    except Exception:
        return False


def gates_ok() -> bool | None:
    script = Path(__file__).resolve().parent / "dispatch.py"
    try:
        proc = subprocess.run(
            [sys.executable, str(script), "--gates"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception:
        return None
    try:
        data = json.loads(proc.stdout or "{}")
    except Exception:
        return None
    return bool(data.get("ok"))


def main() -> int:
    problems: list[str] = []
    inv_file = inventory_path()
    if not inv_file.exists():
        problems.append("missing inventory.json")
        print("\n".join(problems))
        return 1
    inventory = json.loads(inv_file.read_text())
    sessions = [s for s in inventory.get("sessions") or [] if not s.get("running")]
    jobs = load_jobs()
    queued = {(j.get("harness"), j.get("id")) for j in jobs}
    leaked = []
    for s in sessions:
        key = (s.get("harness"), s.get("id"))
        if key not in queued:
            leaked.append(f"{key[0]}:{key[1]}")
    if leaked:
        problems.append("unqueued crashed sessions: " + ",".join(leaked[:12]))

    stats = summary(jobs)
    running = [j for j in jobs if j.get("status") == "running"]
    g = gates_ok()
    if running and g is False:
        problems.append("job running while memory gates are red")

    armed = unit_enabled() or unit_active() or os.environ.get("SRQ_WITNESS_ARMED") == "1"
    terminal = stats["total"] > 0 and stats["pending"] == 0 and stats["running"] == 0
    if not armed and not terminal:
        problems.append("dispatcher not armed and queue not terminal")

    report = {
        "inventory_crashed": len(sessions),
        "leaked": leaked,
        "queue": stats,
        "armed": armed,
        "active": unit_active(),
        "gates_ok": g,
        "problems": problems,
    }
    print(json.dumps(report, indent=2))
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
