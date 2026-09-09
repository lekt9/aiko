#!/usr/bin/env python3
"""Resume interrupted Codex/Pi workers through the current AgentGrid MCP server.

Run inside an AgentGrid Codex session. Defaults to a dry run across all workspaces:
  python3 scripts/resume-interrupted-sessions.py --execute
Use --cwd PATH to limit the scan. Never prints conversation text or credentials.
Master conversations use native terminals only with --resume-all, which explicitly
continues all targets from the previous report, including previously excluded ones.
A finished
turn is not evidence that its overall project finished, but is not interrupted.
"""
import argparse
import collections
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import select
import subprocess
import time
import tomllib

UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
PROMPT = ("go on\n\nContinue the interrupted task in this existing session, within "
          "its original scope and authorization. Recheck current files and any "
          "pending operations before continuing; preserve other sessions' edits. "
          "Do not start another bulk session-recovery run or duplicate existing "
          "workers. Always close each turn with a visible human-readable summary.")


def records(path):
    with path.open() as stream:
        for line in stream:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                # An interrupted final append may be truncated.
                continue


def classify(rows, harness):
    status = "empty"
    timestamp = None
    for row in rows:
        if harness == "codex":
            payload = row.get("payload", {})
            if row.get("type") == "event_msg" and payload.get("type") in (
                    "task_started", "task_complete", "turn_aborted"):
                status = payload["type"]
                timestamp = row.get("timestamp")
        elif row.get("type") == "message":
            message = row.get("message", {})
            status = message.get("stopReason") or message.get("role", "unknown")
            timestamp = row.get("timestamp")
    interrupted = status in {"task_started", "turn_aborted", "toolUse",
                             "toolResult", "user", "error", "aborted", "length"}
    return status, timestamp, interrupted


def live_ids():
    found = {os.environ.get("CODEX_THREAD_ID"), os.environ.get("CODEX_SESSION_ID")}
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            command = (proc / "comm").read_text().strip()
            if command not in {"codex", "pi", "node"}:
                continue
            found.update(UUID.findall((proc / "cmdline").read_bytes().decode(errors="replace")))
            for fd in (proc / "fd").iterdir():
                try:
                    target = os.readlink(fd)
                    if "/sessions/" in target and target.endswith(".jsonl"):
                        found.update(UUID.findall(target))
                except OSError:
                    pass
        except OSError:
            pass
    return found


def scan(hours, cwd):
    cutoff = time.time() - hours * 3600
    result = []
    for harness, root in [("codex", Path.home() / ".codex/sessions"),
                          ("pi-mono", Path.home() / ".pi/agent/sessions")]:
        for path in root.rglob("*.jsonl"):
            stat = path.stat()
            if stat.st_mtime < cutoff:
                continue
            rows = records(path)
            first = next(rows, {})
            meta = first.get("payload", {}) if harness == "codex" else first
            workdir = meta.get("cwd")
            if not workdir or (cwd and workdir != cwd):
                continue
            status, timestamp, interrupted = classify(rows, harness)
            # Use the semantic turn timestamp, not a later model/settings edit.
            try:
                recent = datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp() >= cutoff
            except (ValueError, AttributeError):
                recent = False
            result.append(dict(harness=harness, sessionId=meta.get("id"), cwd=workdir,
                               path=str(path), mtime=stat.st_mtime, status=status,
                               interrupted=interrupted and recent))
    return result


class MCP:
    """Reuse current pane's configured stdio server, keeping its token private."""
    def __init__(self):
        config = None
        current_thread = os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SESSION_ID")
        if not current_thread:
            raise RuntimeError("Current Codex session identity is required")
        for proc in Path("/proc").glob("[0-9]*"):
            try:
                if (proc / "comm").read_text().strip() != "codex":
                    continue
                owns_thread = False
                for fd in (proc / "fd").iterdir():
                    try:
                        target = os.readlink(fd)
                        owns_thread |= "/sessions/" in target and current_thread in target
                    except OSError:
                        pass
                if not owns_thread:
                    continue
                args = (proc / "cmdline").read_bytes().decode().split("\0")
                lines = [arg for arg in args if arg.startswith("mcp_servers.agent_grid_workers.")]
                if lines and os.readlink(proc / "cwd") == os.getcwd():
                    config = tomllib.loads("\n".join(lines))["mcp_servers"]["agent_grid_workers"]
                    break
            except (OSError, ValueError):
                continue
        if not config:
            raise RuntimeError("Run this script from its active AgentGrid Codex workspace")
        self.process = subprocess.Popen([config["command"], *config.get("args", [])],
            env={**os.environ, **config.get("env", {})}, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.counter = 0
        self.buffer = b""
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "session-recovery", "version": "1"}})
        self.write({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def write(self, value):
        self.process.stdin.write((json.dumps(value) + "\n").encode())

    def rpc(self, method, params, timeout=60):
        self.counter += 1
        request_id = self.counter
        self.write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b"\n" not in self.buffer:
                ready, _, _ = select.select([self.process.stdout], [], [], min(1, max(0, deadline-time.monotonic())))
                if not ready:
                    continue
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError("AgentGrid MCP server exited")
                self.buffer += chunk
                continue
            line, self.buffer = self.buffer.split(b"\n", 1)
            response = json.loads(line)
            if response.get("id") != request_id:
                continue
            if "error" in response:
                raise RuntimeError("AgentGrid RPC rejected " + method)
            return response["result"]
        raise TimeoutError("AgentGrid response uncertain; do not automatically resend")

    def call(self, name, arguments, timeout=60):
        response = self.rpc("tools/call", {"name": name, "arguments": arguments}, timeout)
        if response.get("isError"):
            raise RuntimeError("AgentGrid tool rejected " + name)
        return json.loads(next(c["text"] for c in response["content"] if c["type"] == "text"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--resume-all", action="store_true",
                        help="Explicitly continue every original report target, including masters, in native terminals")
    parser.add_argument("--hours", type=float, default=24)
    parser.add_argument("--cwd")
    parser.add_argument("--report", default=".agent-grid/session-recovery.json")
    args = parser.parse_args()
    report_path = Path(args.report).resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.with_suffix(".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        prior = json.loads(report_path.read_text()) if report_path.exists() else {"attempts": {}}
        attempts = prior["attempts"]
        report = {"createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "hours": args.hours, "cwd": args.cwd, "execute": args.execute,
                  "attempts": attempts, "sessions": [], "history": prior.get("history", [])}
        if args.resume_all:
            if not prior.get("sessions"):
                raise RuntimeError("--resume-all requires a previous recovery report")
            report["history"].append({k: prior.get(k) for k in ["createdAt", "counts", "attempts"]})
            # Keep the historical attempt map independent of mutations below.
            report["history"] = json.loads(json.dumps(report["history"]))

        def save():
            temp = report_path.with_suffix(".tmp")
            temp.write_text(json.dumps(report, indent=2) + "\n")
            os.chmod(temp, 0o600)
            temp.replace(report_path)

        sessions = ([s for s in prior["sessions"] if s.get("interrupted")]
                    if args.resume_all else scan(args.hours, args.cwd))
        children = collections.defaultdict(list)
        parent_for = {}
        if args.resume_all:
            for session in sessions:
                if session["harness"] != "codex":
                    continue
                meta = next(records(Path(session["path"])), {}).get("payload", {})
                source = meta.get("source", {})
                spawn = source.get("subagent", {}).get("thread_spawn", {}) if isinstance(source, dict) else {}
                if spawn.get("parent_thread_id"):
                    parent_for[session["sessionId"]] = spawn["parent_thread_id"]
                    children[spawn["parent_thread_id"]].append(
                        {"sessionId": session["sessionId"], "path": spawn.get("agent_path")})
        mcp = MCP()
        try:
            workers = mcp.call("list_workers", {}).get("workers", [])
            existing = {w.get("sessionId"): w for w in workers}
            live = live_ids()
            recoverable = {}
            for cwd, harness in sorted({(s["cwd"], s["harness"]) for s in sessions}):
                found = mcp.call("list_recoverable_sessions", {"cwd": cwd, "harness": harness})
                if found.get("errors"):
                    raise RuntimeError("Incomplete recovery scan for " + harness + " at " + cwd)
                recoverable.update({(harness, s["sessionId"]): s for s in found["sessions"]})
            panes = []
            terminals = []
            for session in sessions:
                sid, harness = session["sessionId"], session["harness"]
                key = harness + ":" + str(sid)
                candidate = recoverable.get((harness, sid))
                reason = None
                if not session["interrupted"]: reason = "completed-or-outside-window"
                elif sid in live or time.time() - session["mtime"] < 90: reason = "live-or-recently-active"
                elif not candidate and not args.resume_all: reason = "not-recoverable"
                elif candidate and candidate.get("isMaster") and not args.resume_all: reason = "master-conversation"
                elif key in attempts and not args.resume_all: reason = "already-attempted"
                elif attempts.get(key, {}).get("state") in {"dispatching", "failed-or-uncertain"}: reason = "uncertain-prior-dispatch"
                elif not Path(session["cwd"]).is_dir(): reason = "missing-workspace"
                worker = existing.get(sid)
                if worker and worker.get("status") == "running": reason = "already-running"
                if sid in parent_for:
                    reason = "internal-child-requires-parent"
                    session["parentSessionId"] = parent_for[sid]
                session["decision"] = reason or ("resume" if args.execute else "would-resume")
                report["sessions"].append(session)
                if reason or not args.execute:
                    continue
                # Fence before dispatch: a lost reply must not cause a duplicate turn.
                attempts[key] = {"state": "dispatching", "at": report["createdAt"]}
                save()
                try:
                    prompt = PROMPT
                    if sid in children:
                        prompt += ("\nFIRST use native collaboration tools to restore and follow up these "
                                   "existing internal child sessions with go on; do not spawn replacements: "
                                   + json.dumps(children[sid]) + ". Report whether each continuation started.")
                    native = args.resume_all and (not candidate or candidate.get("isMaster"))
                    if worker:
                        pane = worker["paneId"]
                        mcp.call("send_to_worker", {"paneId": pane, "prompt": prompt})
                        native = False
                    elif native:
                        if harness != "codex":
                            raise RuntimeError("Native terminal recovery is implemented for Codex only")
                        value = mcp.call("spawn_terminal", {"cwd": session["cwd"],
                            "customTitle": "Resume Codex " + sid[-8:], "command": "codex",
                            "args": ["--ask-for-approval", "never", "--sandbox", "danger-full-access",
                                     "exec", "resume", "--json", sid, prompt]})
                        pane = value["paneId"]
                    else:
                        value = mcp.call("resume_worker", {"sessionId": sid, "cwd": session["cwd"],
                            "harness": harness, "prompt": prompt, "name": "Recovered " + harness + " " + sid[-8:]})
                        pane = value["paneId"]
                    attempts[key].update(state="resumed", paneId=pane, nativeTerminal=native)
                    (terminals if native else panes).append(pane)
                    print(json.dumps({"resumed": sid, "harness": harness, "paneId": pane}), flush=True)
                except Exception as error:
                    attempts[key].update(state="failed-or-uncertain", error=type(error).__name__)
                    print(json.dumps({"sessionId": sid, "state": "failed-or-uncertain"}), flush=True)
                save()
            report["terminals"] = terminals
            if panes:
                results = mcp.call("wait_for_all", {"paneIds": panes, "timeoutMs": 1000})
                report["observation"] = [{k: v for k, v in row.items() if k in
                    {"paneId", "timedOut", "exitCode"}} for row in results.get("results", [])]
                for row in results.get("results", []):
                    if row.get("error"):
                        for attempt in attempts.values():
                            if attempt.get("paneId") == row["paneId"]:
                                attempt.update(state="worker-failed", errorKind=row["error"].get("kind", "unknown"))
            report["counts"] = dict(collections.Counter(s["decision"] for s in report["sessions"]))
            save()
            print(json.dumps({"counts": report["counts"], "report": str(report_path)}), flush=True)
        finally:
            mcp.process.terminate()


if __name__ == "__main__":
    main()
