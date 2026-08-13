#!/usr/bin/env python3
"""Durable JSONL queue for crashed-session resumes."""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

CONTINUE_PROMPT = (
    "You were interrupted (host OOM, freeze, or a stalled in-session queue). "
    "Resume the original task from the transcript and finish it. "
    "Do not start unrelated work. If the original goal is already done, "
    "say so in one line and stop."
)


def state_dir() -> Path:
    p = Path(os.path.expanduser("~/.local/state/session-resume-queue"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def queue_path() -> Path:
    return state_dir() / "queue.jsonl"


def load_jobs() -> list[dict]:
    path = queue_path()
    if not path.exists():
        return []
    jobs: list[dict] = []
    with path.open(errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                jobs.append(json.loads(line))
            except Exception:
                continue
    return jobs


def rewrite(jobs: list[dict]) -> None:
    tmp = queue_path().with_suffix(".jsonl.tmp")
    with tmp.open("w") as fh:
        for job in jobs:
            fh.write(json.dumps(job, sort_keys=True) + "\n")
    tmp.replace(queue_path())


def job_key(job: dict) -> tuple[str, str]:
    return (job.get("harness", ""), job.get("id", ""))


def enqueue_from_inventory(inventory: dict, now: int | None = None) -> dict:
    now = now or int(time.time())
    jobs = load_jobs()
    seen = {job_key(j) for j in jobs}
    added = 0
    for sess in inventory.get("sessions") or []:
        key = (sess.get("harness"), sess.get("id"))
        if not key[0] or not key[1] or key in seen:
            continue
        if sess.get("running"):
            continue
        jobs.append(
            {
                "harness": sess["harness"],
                "id": sess["id"],
                "cwd": sess.get("cwd") or str(Path.home()),
                "path": sess.get("path"),
                "reasons": sess.get("reasons") or [],
                "status": "pending",
                "attempts": 0,
                "enqueued_at": now,
                "started_at": None,
                "finished_at": None,
                "last_exit": None,
                "last_error": None,
                "prompt": CONTINUE_PROMPT,
            }
        )
        seen.add(key)
        added += 1
    rewrite(jobs)
    return {"added": added, "total": len(jobs), "pending": sum(1 for j in jobs if j["status"] == "pending")}


def summary(jobs: list[dict] | None = None) -> dict:
    jobs = jobs if jobs is not None else load_jobs()
    out = {"total": len(jobs), "pending": 0, "running": 0, "done": 0, "failed": 0, "skipped": 0}
    for j in jobs:
        st = j.get("status", "pending")
        out[st] = out.get(st, 0) + 1
    return out


def update(harness: str, sid: str, **fields) -> dict | None:
    jobs = load_jobs()
    found = None
    for j in jobs:
        if j.get("harness") == harness and j.get("id") == sid:
            j.update(fields)
            found = j
            break
    if found is None:
        return None
    rewrite(jobs)
    return found


def next_pending() -> dict | None:
    for j in load_jobs():
        if j.get("status") == "pending":
            return j
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    enq = sub.add_parser("enqueue")
    enq.add_argument("--inventory", default="")
    sub.add_parser("status")
    sub.add_parser("list")
    args = ap.parse_args()
    if args.cmd == "enqueue":
        inv_path = Path(args.inventory) if args.inventory else state_dir() / "inventory.json"
        inventory = json.loads(inv_path.read_text())
        print(json.dumps(enqueue_from_inventory(inventory)))
        return 0
    if args.cmd == "status":
        print(json.dumps(summary()))
        return 0
    if args.cmd == "list":
        for j in load_jobs():
            print(f"{j.get('status'):8} {j.get('harness'):6} {j.get('id')}  {','.join(j.get('reasons') or [])}")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
