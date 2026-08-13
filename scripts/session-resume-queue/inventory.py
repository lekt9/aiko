#!/usr/bin/env python3
"""Tail-only inventory of crashed Claude / Codex / Prime sessions.

Reads the last TAIL_BYTES of each jsonl (plus a cheap queue-operation
scan for Claude). Never launches an agent. Safe to run on a loaded host.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from pathlib import Path

TAIL_BYTES = 128 * 1024
WEEK = 7 * 86400
UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.I,
)


def home() -> Path:
    return Path(os.path.expanduser("~"))


def state_dir() -> Path:
    p = home() / ".local/state/session-resume-queue"
    p.mkdir(parents=True, exist_ok=True)
    return p


def running_ids() -> set[str]:
    try:
        out = subprocess.check_output(["ps", "-eo", "args"], text=True, errors="replace")
    except Exception:
        return set()
    return {m.group(0).lower() for m in UUID_RE.finditer(out)}


def decode_claude_project(name: str) -> str:
    if name.startswith("-"):
        return "/" + name[1:].replace("-", "/")
    return name


def tail_records(path: Path) -> tuple[list[dict], bool]:
    """Return (records_from_tail, truncated_flag)."""
    try:
        size = path.stat().st_size
        data = path.read_bytes()
    except OSError:
        return [], False
    if size > TAIL_BYTES:
        data = data[-TAIL_BYTES:]
        nl = data.find(b"\n")
        if nl >= 0:
            data = data[nl + 1 :]
    truncated = False
    recs: list[dict] = []
    for line in data.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            recs.append(json.loads(line))
        except Exception:
            truncated = True
    return recs, truncated


def claude_queue_unfinished(path: Path) -> tuple[int, int]:
    enq = deq = 0
    try:
        with path.open("rb") as fh:
            for raw in fh:
                if b"queue-operation" not in raw:
                    continue
                try:
                    o = json.loads(raw)
                except Exception:
                    continue
                if o.get("type") != "queue-operation":
                    continue
                op = o.get("operation")
                if op == "enqueue":
                    enq += 1
                elif op == "dequeue":
                    deq += 1
    except OSError:
        return 0, 0
    return enq, deq


def extract_cwd(rec: dict | None, fallback: str) -> str:
    if not isinstance(rec, dict):
        return fallback
    for key in ("cwd", "CWD", "workingDirectory"):
        v = rec.get(key)
        if isinstance(v, str) and v.startswith("/"):
            return v
    git = rec.get("git")
    if isinstance(git, dict) and isinstance(git.get("cwd"), str):
        return git["cwd"]
    return fallback


def classify_claude(path: Path, running: set[str]) -> dict | None:
    sid = path.stem
    recs, trunc = tail_records(path)
    last = recs[-1] if recs else None
    last_type = last.get("type") if isinstance(last, dict) else None
    enq, deq = claude_queue_unfinished(path)
    leftover = max(0, enq - deq)
    is_running = sid.lower() in running
    reasons = []
    if trunc:
        reasons.append("truncated_jsonl")
    if leftover:
        reasons.append(f"unfinished_queue:{leftover}")
    if last_type in {"last-prompt", "queue-operation"} and not is_running:
        reasons.append(f"stalled:{last_type}")
    if not reasons:
        return None
    project = path.parent.name
    cwd = decode_claude_project(project)
    return {
        "harness": "claude",
        "id": sid,
        "path": str(path),
        "cwd": cwd,
        "mtime": int(path.stat().st_mtime),
        "size": path.stat().st_size,
        "running": is_running,
        "reasons": reasons,
        "last_type": last_type,
        "enqueue": enq,
        "dequeue": deq,
    }


def classify_codex(path: Path, running: set[str]) -> dict | None:
    recs, trunc = tail_records(path)
    last = recs[-1] if recs else None
    first = recs[0] if recs else None
    sid = None
    cwd = str(Path.home())
    for rec in recs[:8] + recs[-8:]:
        if not isinstance(rec, dict):
            continue
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else rec
        for key in ("id", "session_id", "sessionId"):
            v = payload.get(key) if isinstance(payload, dict) else None
            if isinstance(v, str) and UUID_RE.fullmatch(v):
                sid = v
        cwd = extract_cwd(payload if isinstance(payload, dict) else None, cwd)
        cwd = extract_cwd(rec, cwd)
    if sid is None:
        m = UUID_RE.search(path.name)
        sid = m.group(0) if m else path.stem
    is_running = sid.lower() in running
    last_type = None
    if isinstance(last, dict):
        last_type = last.get("type") or last.get("kind")
        payload = last.get("payload")
        if isinstance(payload, dict):
            last_type = payload.get("type") or last_type
    reasons = []
    if trunc:
        reasons.append("truncated_jsonl")
    # Codex completed rollouts usually end with a turn.completed / token_count
    # plus shutdown. A tail that stops on a streaming/error event is a crash.
    if last_type in {None, "error", "error_event", "agent_message_delta", "exec_command_begin"}:
        reasons.append(f"stalled:{last_type}")
    if not reasons:
        return None
    if is_running and "truncated_jsonl" not in reasons:
        return None
    return {
        "harness": "codex",
        "id": sid,
        "path": str(path),
        "cwd": cwd,
        "mtime": int(path.stat().st_mtime),
        "size": path.stat().st_size,
        "running": is_running,
        "reasons": reasons,
        "last_type": last_type,
    }


def classify_prime(path: Path, running: set[str], recovery_ops: dict[str, str]) -> dict | None:
    sid = path.stem
    recs, trunc = tail_records(path)
    last = recs[-1] if recs else None
    first = recs[0] if recs else None
    cwd = extract_cwd(first, str(Path.home()))
    is_running = sid.lower() in running
    status = None
    if isinstance(last, dict) and last.get("type") == "agent_status":
        status = last.get("status")
        if isinstance(status, dict):
            status = status.get("state") or status.get("status")
    reasons = []
    if trunc:
        reasons.append("truncated_jsonl")
    op = recovery_ops.get(sid.lower())
    if op and not str(op).startswith("closed") and op != "ready":
        reasons.append(f"recovery:{op}")
    if status in {"error", "failed", "crashed", "killed"}:
        reasons.append(f"status:{status}")
    if not reasons:
        return None
    if is_running and "truncated_jsonl" not in reasons:
        return None
    return {
        "harness": "prime",
        "id": sid,
        "path": str(path),
        "cwd": cwd,
        "mtime": int(path.stat().st_mtime),
        "size": path.stat().st_size,
        "running": is_running,
        "reasons": reasons,
        "last_type": last.get("type") if isinstance(last, dict) else None,
        "recovery_op": op,
    }


def load_recovery_ops() -> dict[str, str]:
    out: dict[str, str] = {}
    root = home() / ".prime/agent/daemon-workers"
    if not root.exists():
        return out
    for f in root.rglob("*.recovery.jsonl"):
        last = None
        try:
            with f.open(errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        last = json.loads(line)
                    except Exception:
                        continue
        except OSError:
            continue
        if not isinstance(last, dict):
            continue
        sid = last.get("sessionId")
        if isinstance(sid, str):
            out[sid.lower()] = str(last.get("operation") or "unknown")
    return out


def scan(cutoff: float) -> dict:
    running = running_ids()
    recovery = load_recovery_ops()
    crashed: list[dict] = []

    claude_root = home() / ".claude/projects"
    if claude_root.exists():
        for path in claude_root.rglob("*.jsonl"):
            try:
                if path.stat().st_mtime < cutoff:
                    continue
            except OSError:
                continue
            row = classify_claude(path, running)
            if row:
                crashed.append(row)

    codex_root = home() / ".codex/sessions"
    if codex_root.exists():
        for path in codex_root.rglob("*.jsonl"):
            try:
                if path.stat().st_mtime < cutoff:
                    continue
            except OSError:
                continue
            row = classify_codex(path, running)
            if row:
                crashed.append(row)

    prime_root = home() / ".prime/agent/sessions"
    if prime_root.exists():
        for path in prime_root.glob("*.jsonl"):
            try:
                if path.stat().st_mtime < cutoff:
                    continue
            except OSError:
                continue
            row = classify_prime(path, running, recovery)
            if row:
                crashed.append(row)

    crashed.sort(key=lambda r: r["mtime"])
    by = {"claude": 0, "codex": 0, "prime": 0}
    for row in crashed:
        by[row["harness"]] = by.get(row["harness"], 0) + 1
    return {
        "generated_at": int(time.time()),
        "cutoff": int(cutoff),
        "running_ids": sorted(running),
        "counts": {"crashed": len(crashed), **by},
        "sessions": crashed,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    cutoff = time.time() - args.days * 86400
    report = scan(cutoff)
    out = Path(args.out) if args.out else state_dir() / "inventory.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["counts"]))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
