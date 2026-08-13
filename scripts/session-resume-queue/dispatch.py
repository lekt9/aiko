#!/usr/bin/env python3
"""Memory-budgeted parallel resume dispatcher.

Fills up to TARGET_RAM_RATIO (default 80%) of host RAM with concurrent
resume scopes. Each child is still cgroup-capped (MemoryMax / MemorySwapMax)
so one bad session cannot take the whole budget.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from jobqueue import load_jobs, next_pending, state_dir, summary, update

UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.I,
)

# Host may be driven up to this fraction of MemTotal by concurrent resumes.
TARGET_RAM_RATIO = float(os.environ.get("SRQ_RAM_RATIO", "0.80"))
# Per-session cgroup ceiling (bytes). Parallel slots = floor(0.80 * total / this).
SESSION_BYTES = int(os.environ.get("SRQ_SESSION_BYTES", str(3 * 1024**3)))
SESSION_SWAP_BYTES = int(os.environ.get("SRQ_SESSION_SWAP_BYTES", str(512 * 1024**2)))
# Hard stop — do not open a new slot if swap is this full.
MAX_SWAP_RATIO = float(os.environ.get("SRQ_MAX_SWAP_RATIO", "0.90"))
# Soft load brake: prefer not to open slots above this, but keep existing work.
MAX_LOAD_FACTOR = float(os.environ.get("SRQ_MAX_LOAD_FACTOR", "2.0"))
MAX_ATTEMPTS = 2
JOB_TIMEOUT_SEC = 45 * 60
POLL_SEC = 10
MIN_AVAILABLE = 2 * 1024 * 1024 * 1024  # always leave ~2 GiB free

# In-process handle for async launches: unit -> {proc, job, started}
_ACTIVE: dict[str, dict] = {}


def read_meminfo() -> dict[str, int]:
    fields: dict[str, int] = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        parts = rest.split()
        if not parts:
            continue
        try:
            fields[key] = int(parts[0]) * 1024
        except ValueError:
            continue
    return fields


def loadavg() -> float:
    return float(Path("/proc/loadavg").read_text().split()[0])


def nproc() -> int:
    return os.cpu_count() or 1


def frozen_sandboxes() -> list[str]:
    try:
        out = subprocess.check_output(
            ["python3", "-m", "prime_ram_sandbox", "status"],
            cwd="/home/deck/work/agent/prime-ram-sandbox",
            env={**os.environ, "PYTHONPATH": "/home/deck/work/agent/prime-ram-sandbox"},
            text=True,
            timeout=8,
        )
        data = json.loads(out)
    except Exception:
        return []
    return [row.get("unit") or "unknown" for row in (data.get("live") or []) if row.get("frozen")]


def live_srq_scopes() -> list[str]:
    """Return active srq-*.scope unit names.

    systemctl --plain columns: UNIT LOAD ACTIVE SUB DESCRIPTION
    so the running/activating flag is SUB (index 3), not ACTIVE (index 2).
    """
    try:
        out = subprocess.check_output(
            ["systemctl", "--user", "list-units", "srq-*.scope", "--no-legend", "--plain"],
            text=True,
            timeout=5,
        )
    except Exception:
        return []
    live = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        # parts[2]=ACTIVE (active/inactive), parts[3]=SUB (running/dead/...)
        if parts[2] == "active" and parts[3] in {"running", "activating"}:
            live.append(parts[0])
    return live


def budget() -> dict:
    mem = read_meminfo()
    total = mem.get("MemTotal") or 1
    available = mem.get("MemAvailable") or 0
    used = max(0, total - available)
    used_ratio = used / total
    swap_total = mem.get("SwapTotal") or 0
    swap_free = mem.get("SwapFree") or 0
    swap_ratio = ((swap_total - swap_free) / swap_total) if swap_total else 0.0
    load1 = loadavg()
    load_cap = nproc() * MAX_LOAD_FACTOR
    scopes = live_srq_scopes()
    frozen = frozen_sandboxes()

    target_used = int(total * TARGET_RAM_RATIO)
    # How many more SESSION_BYTES we can open without exceeding 80% host use
    # and without dropping Available below MIN_AVAILABLE.
    headroom_to_target = max(0, target_used - used)
    headroom_to_min_free = max(0, available - MIN_AVAILABLE)
    headroom = min(headroom_to_target, headroom_to_min_free)

    max_parallel = max(1, int(total * TARGET_RAM_RATIO) // SESSION_BYTES)
    live_n = len(scopes)
    slots_by_budget = headroom // SESSION_BYTES if SESSION_BYTES else 0
    slots_by_cap = max(0, max_parallel - live_n)

    hard_block = (
        swap_ratio > MAX_SWAP_RATIO
        or available < MIN_AVAILABLE
        or bool(frozen)
    )
    soft_block = load1 > load_cap
    free_slots = 0 if hard_block or soft_block else min(slots_by_budget, slots_by_cap)

    return {
        "total_gi": round(total / (1024**3), 2),
        "available_gi": round(available / (1024**3), 2),
        "used_ratio": round(used_ratio, 3),
        "target_ratio": TARGET_RAM_RATIO,
        "swap_ratio": round(swap_ratio, 3),
        "load1": load1,
        "load_cap": round(load_cap, 2),
        "session_gi": round(SESSION_BYTES / (1024**3), 2),
        "max_parallel": max_parallel,
        "live_scopes": scopes,
        "live_n": live_n,
        "free_slots": int(free_slots),
        "hard_block": hard_block,
        "soft_block": soft_block,
        "frozen": frozen,
        "ok": free_slots > 0 or live_n > 0,
    }


def gates() -> tuple[bool, dict]:
    """Compat for --gates / witness: ok if we can run or are already running."""
    b = budget()
    return bool(b["free_slots"] > 0 or b["live_n"] > 0) and not b["hard_block"], b


def which_or(name: str, fallbacks: list[str]) -> str:
    found = shutil.which(name)
    if found:
        return found
    for path in fallbacks:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return name


def resume_argv(job: dict) -> list[str]:
    sid = job["id"]
    cwd = job.get("cwd") or str(Path.home())
    prompt = job.get("prompt") or "Resume and finish the original task."
    harness = job["harness"]
    home = str(Path.home())
    claude = which_or("claude", [f"{home}/.local/bin/claude"])
    codex = which_or("codex", [f"{home}/.local/bin/codex"])
    prime = which_or("prime-agent", [f"{home}/.local/bin/prime-agent"])
    if harness == "claude":
        return [claude, "--resume", sid, "--dangerously-skip-permissions", "-p", prompt]
    if harness == "codex":
        return [codex, "--yolo", "-C", cwd, "exec", "resume", sid, prompt]
    if harness == "prime":
        return [
            prime,
            "--resume",
            sid,
            "--cwd",
            cwd,
            "-p",
            prompt,
            "--autonomous",
            "--autonomous-max-turns",
            "16",
            "--autonomous-timeout-ms",
            str(JOB_TIMEOUT_SEC * 1000),
        ]
    raise ValueError(f"unknown harness {harness}")


def scope_unit(job: dict) -> str:
    short = job["id"].replace("-", "")[:12]
    n = int(job.get("attempts") or 1)
    return f"srq-{job['harness']}-{short}-{n}.scope"


def mem_prop(bytes_: int) -> str:
    return f"{max(1, bytes_ // (1024**2))}M"


def start_job(job: dict) -> dict:
    """Launch one resume asynchronously inside a cgroup scope."""
    attempts = int(job.get("attempts") or 0) + 1
    update(
        job["harness"],
        job["id"],
        status="running",
        started_at=int(time.time()),
        attempts=attempts,
    )
    job = {**job, "attempts": attempts}
    unit = scope_unit(job)
    argv = resume_argv(job)
    cwd = job.get("cwd") or str(Path.home())
    if not os.path.isdir(cwd):
        cwd = str(Path.home())
    log = state_dir() / "logs"
    log.mkdir(exist_ok=True)
    log_path = log / f"{job['harness']}-{job['id']}.log"
    env = os.environ.copy()
    local_bin = str(Path.home() / ".local/bin")
    fnm = str(Path.home() / ".local/share/fnm/node-versions/v24.18.1/installation/bin")
    env["PATH"] = f"{local_bin}:{fnm}:" + env.get("PATH", "")
    cmd = [
        "systemd-run",
        "--user",
        "--scope",
        f"--unit={unit}",
        "-p",
        f"MemoryMax={mem_prop(SESSION_BYTES)}",
        "-p",
        f"MemorySwapMax={mem_prop(SESSION_SWAP_BYTES)}",
        "-p",
        "OOMPolicy=stop",
        "--collect",
        "--same-dir",
        "--",
        *argv,
    ]
    fh = log_path.open("ab")
    fh.write(f"\n--- {time.strftime('%Y-%m-%dT%H:%M:%S')} {' '.join(cmd)}\n".encode())
    fh.flush()
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=fh,
        stderr=subprocess.STDOUT,
    )
    handle = {
        "proc": proc,
        "job": job,
        "unit": unit,
        "started": time.time(),
        "log": fh,
    }
    _ACTIVE[unit] = handle
    return {"action": "started", "id": job["id"], "harness": job["harness"], "unit": unit}


def finish_handle(unit: str, handle: dict, rc: int) -> dict:
    job = handle["job"]
    try:
        handle["log"].close()
    except Exception:
        pass
    subprocess.run(
        ["systemctl", "--user", "stop", unit],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _ACTIVE.pop(unit, None)
    attempts = int(job.get("attempts") or 1)
    if rc == 0:
        update(job["harness"], job["id"], status="done", finished_at=int(time.time()), last_exit=rc)
        action = "done"
    elif attempts >= MAX_ATTEMPTS:
        update(job["harness"], job["id"], status="failed", finished_at=int(time.time()), last_exit=rc)
        action = "failed"
    else:
        update(
            job["harness"],
            job["id"],
            status="pending",
            last_exit=rc,
            last_error=f"retry after {rc}",
        )
        action = "retry"
    return {
        "action": action,
        "id": job["id"],
        "harness": job["harness"],
        "exit": rc,
        "unit": unit,
    }


def reap() -> list[dict]:
    """Collect finished async launches + timed-out scopes."""
    results = []
    now = time.time()
    for unit, handle in list(_ACTIVE.items()):
        proc = handle["proc"]
        code = proc.poll()
        if code is None:
            if now - handle["started"] > JOB_TIMEOUT_SEC:
                proc.kill()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass
                results.append(finish_handle(unit, handle, 124))
            continue
        results.append(finish_handle(unit, handle, int(code)))
    return results


def process_session_ids() -> set[str]:
    try:
        out = subprocess.check_output(["ps", "-eo", "args"], text=True, errors="replace")
    except Exception:
        return set()
    return {m.group(0).lower() for m in UUID_RE.finditer(out)}


def skip_externally_running() -> list[str]:
    live = process_session_ids()
    # Do not skip ids we ourselves launched this process.
    ours = {str(h["job"].get("id") or "").lower() for h in _ACTIVE.values()}
    skipped: list[str] = []
    for job in load_jobs():
        if job.get("status") != "pending":
            continue
        sid = str(job.get("id") or "").lower()
        if sid and sid in live and sid not in ours:
            update(
                job["harness"],
                job["id"],
                status="skipped",
                finished_at=int(time.time()),
                last_error="already running outside the queue",
            )
            skipped.append(job["id"])
    return skipped


def reconcile_orphans() -> list[str]:
    live = set(live_srq_scopes()) | set(_ACTIVE.keys())
    reset: list[str] = []
    now = int(time.time())
    for job in load_jobs():
        if job.get("status") != "running":
            continue
        unit = scope_unit(job)
        if unit in live:
            continue
        # also match any attempt suffix for this id still live
        short = job["id"].replace("-", "")[:12]
        if any(short in u for u in live):
            continue
        started = int(job.get("started_at") or 0)
        if started and now - started < 90:
            continue
        update(
            job["harness"],
            job["id"],
            status="pending",
            last_error="orphan running row after dispatcher restart",
        )
        reset.append(job["id"])
    return reset


def fill_slots() -> list[dict]:
    """Open as many free slots as the 80% RAM budget allows."""
    events: list[dict] = []
    b = budget()
    slots = int(b["free_slots"])
    for _ in range(slots):
        job = next_pending()
        if job is None:
            break
        # Recompute budget each launch so we do not overshoot mid-fill.
        b = budget()
        if b["free_slots"] <= 0:
            break
        events.append(start_job(job))
    return events


def dispatch_once() -> dict:
    orphans = reconcile_orphans()
    skipped = skip_externally_running()
    finished = reap()
    started = fill_slots()
    b = budget()
    report = {
        **b,
        "requeued_orphans": orphans,
        "skipped_live": skipped,
        "finished": finished,
        "started": started,
        "queue": summary(),
        "active_local": list(_ACTIVE.keys()),
    }
    if started:
        report["action"] = "fill"
    elif finished:
        report["action"] = "reap"
    elif b["live_n"] > 0 or _ACTIVE:
        report["action"] = "busy"
    elif next_pending() is None:
        report["action"] = "idle"
    else:
        report["action"] = "wait"
    return report


def loop(once: bool) -> int:
    while True:
        result = dispatch_once()
        print(json.dumps(result), flush=True)
        if once:
            return 0
        jobs = load_jobs()
        if (
            jobs
            and all(j.get("status") in {"done", "failed", "skipped"} for j in jobs)
            and not _ACTIVE
        ):
            return 0
        time.sleep(POLL_SEC)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--gates", action="store_true")
    args = ap.parse_args()
    if args.gates:
        ok, report = gates()
        print(json.dumps({"ok": ok, **report}))
        return 0 if ok else 1
    return loop(once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())
