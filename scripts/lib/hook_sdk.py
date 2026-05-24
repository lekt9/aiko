"""hook_sdk — pre-gate + post-record SDK for ~/.contracts/hooks/*.

Two functions, one doctrine: every hook is /contract-bound on both
edges of its firing. The PRE edge is `should_fire(name)` — substrate-
as-config via `contract feature-status <name>`. The POST edge is
`record(name, event, exit_code, **meta)` — appends a `hook_fired`
ledger row so every hook firing is observable in contracts.jsonl.

Use:
    from hook_sdk import should_fire, record

    def main():
        if not should_fire("my-hook"):
            return 0
        # ... do the work ...
        record("my-hook", event=sys.argv[1], exit_code=0, advanced=42)
        return 0

The SDK shell-outs to `contract feature-status` (which itself reads
the toggle file → contract row → status). Defaults to safe-OFF when
the verb is missing or the toggle is absent — same shape Lewis's
unbrowse-mirror.py patch established as the canonical pre-gate.

For tests that bypass HOME sandboxing, set CONTRACT_HOOK_SDK_FORCE_ON=1
to force should_fire→True without needing a real toggle file.
"""
from __future__ import annotations
import datetime
import os
import subprocess
import sys
from pathlib import Path


def _contract_bin() -> str:
    """Self-locate the /contract CLI. Falls back to ~ expansion."""
    # When running from a hook, HOME may be sandboxed by tests. The CLI is
    # always at <real-home>/.claude/skills/contract/scripts/contract — but
    # we don't know the real home in tests. Honor explicit override first.
    if env := os.environ.get("CONTRACT_CLI"):
        if os.path.isfile(env):
            return env
    candidates = [
        os.path.expanduser("~/.claude/skills/contract/scripts/contract"),
        "/Users/lekt9/.claude/skills/contract/scripts/contract",  # mac fallback
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return candidates[0]  # let subprocess fail with a clear error


def should_fire(name: str) -> bool:
    """PRE-gate: is this hook enabled per the toggle/feature-status contract?

    Returns True iff `contract feature-status <name>` exits 0.
    Safe-OFF on subprocess failure / verb missing / unknown name —
    matching Lewis's _toggle_on() pattern from unbrowse-mirror.py.

    Test bypass: CONTRACT_HOOK_SDK_FORCE_ON=1 forces True.
    """
    if os.environ.get("CONTRACT_HOOK_SDK_FORCE_ON") == "1":
        return True
    if not name or "/" in name or "\\" in name:
        return False  # defensive — name is used in subprocess
    try:
        r = subprocess.run(
            ["bash", _contract_bin(), "feature-status", name],
            capture_output=True,
            timeout=5,
        )
        return r.returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def record(
    name: str,
    *,
    event: str = "fired",
    exit_code: int = 0,
    **meta,
) -> None:
    """POST-record: append a `hook_fired` row to the ledger.

    Every hook firing becomes a queryable ledger row — observable via
    `contract list` filtered on event=hook_fired, or
    `grep '"event":"hook_fired"' ~/.contracts/contracts.jsonl`.

    Never raises — hook discipline says don't escalate substrate failures.
    Writes are best-effort; if contract_core fails to import (sandboxed
    HOME without the lib on path), silently no-op.
    """
    try:
        # Self-locate the lib via the CLI's directory
        cli = _contract_bin()
        lib_dir = os.path.join(os.path.dirname(cli), "lib")
        if lib_dir not in sys.path:
            sys.path.insert(0, lib_dir)
        from contract_core import _append  # type: ignore
        row = {
            "event": "hook_fired",
            "hook": name,
            "hook_event": event,
            "exit_code": int(exit_code) if exit_code is not None else 0,
            "ts": datetime.datetime.now(datetime.timezone.utc)
                  .isoformat().replace("+00:00", "Z"),
        }
        # Promote meta fields onto the row (capped — substrate doesn't want
        # huge payloads, just enough to make a hook firing inspectable).
        for k, v in (meta or {}).items():
            if k in row:
                continue
            if isinstance(v, (str, int, float, bool, type(None))):
                row[k] = v
            elif isinstance(v, (list, dict)):
                row[k] = v
            else:
                row[k] = str(v)[:200]
        _append(row)
    except Exception:  # noqa: BLE001 — never escalate from a hook
        pass


__all__ = ["should_fire", "record"]
