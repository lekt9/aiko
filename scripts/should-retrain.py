#!/usr/bin/env python3
"""
should-retrain.py — Λ2 cycle Stage 1 trigger predicate.

Reads ~/.contracts/contracts.jsonl, walks rows, and decides whether a
periodic distillate-retraining cycle should FIRE (exit 0) or SKIP (exit 1).

Thresholds (config-overridable):
  * min_rows_since_last_promote (default 5000) — row-count branch
  * cycle_interval_days        (default 7)    — wall-clock branch
  * min_judged_rows            (default 200)  — supervisable signal floor

Trigger rule:
  FIRE iff (rows_since >= row_threshold OR days_since >= day_threshold)
       AND judged_count >= judged_floor

If no prior `learned` row tagged `lambda2-promote` exists, days_since is
treated as +inf (so the wall-clock branch always satisfies) and rows_since
is the full ledger length.

Config precedence (highest wins):
  1. env vars LAMBDA2_MIN_ROWS_SINCE_LAST_PROMOTE,
     LAMBDA2_CYCLE_INTERVAL_DAYS, LAMBDA2_MIN_JUDGED_ROWS
  2. ~/.config/contract/lambda2.json
  3. built-in defaults
"""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

LEDGER = Path(os.environ.get("CONTRACT_LEDGER", str(Path.home() / ".contracts" / "contracts.jsonl")))
CONFIG = Path(os.environ.get("LAMBDA2_CONFIG", str(Path.home() / ".config" / "contract" / "lambda2.json")))

DEFAULTS = {
    "cycle_interval_days": 7,
    "min_rows_since_last_promote": 5000,
    "min_judged_rows": 200,
}

ENV_MAP = {
    "cycle_interval_days": "LAMBDA2_CYCLE_INTERVAL_DAYS",
    "min_rows_since_last_promote": "LAMBDA2_MIN_ROWS_SINCE_LAST_PROMOTE",
    "min_judged_rows": "LAMBDA2_MIN_JUDGED_ROWS",
}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG.exists():
        try:
            user = json.loads(CONFIG.read_text())
            for k in DEFAULTS:
                if k in user:
                    cfg[k] = user[k]
        except (json.JSONDecodeError, OSError) as e:
            print(f"should-retrain: warn: ignoring bad config at {CONFIG}: {e}", file=sys.stderr)
    for k, ev in ENV_MAP.items():
        v = os.environ.get(ev)
        if v is None or v == "":
            continue
        try:
            cfg[k] = float(v) if k == "cycle_interval_days" else int(v)
        except ValueError:
            print(f"should-retrain: warn: ignoring non-numeric env {ev}={v!r}", file=sys.stderr)
    cfg["cycle_interval_days"] = float(cfg["cycle_interval_days"])
    cfg["min_rows_since_last_promote"] = int(cfg["min_rows_since_last_promote"])
    cfg["min_judged_rows"] = int(cfg["min_judged_rows"])
    return cfg


def parse_ts(s: str) -> datetime | None:
    if not s:
        return None
    try:
        # ISO 8601; ledger uses ...Z suffix
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def has_tag(row: dict, tag: str) -> bool:
    tags = row.get("tags")
    if isinstance(tags, list):
        return tag in tags
    if isinstance(tags, str):
        return tag == tags
    return False


def walk_ledger() -> tuple[int, int, datetime | None]:
    """Return (rows_since_last_promote, judged_rows_since_last_promote, last_promote_ts)."""
    last_promote_idx = -1
    last_promote_ts: datetime | None = None
    rows: list[dict] = []
    if not LEDGER.exists():
        return 0, 0, None
    with LEDGER.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError as e:
                # Corrupt ledger line — skip + surface to stderr.
                # Silent skip forbidden (check-no-silent-fallback.py).
                print(f"should-retrain: skipping bad line in {LEDGER}: {e}",
                      file=sys.stderr)
                continue
            rows.append(r)
            if r.get("event") == "learned" and has_tag(r, "lambda2-promote"):
                last_promote_idx = len(rows) - 1
                ts = parse_ts(r.get("ts", ""))
                if ts is not None:
                    last_promote_ts = ts
    tail = rows[last_promote_idx + 1:] if last_promote_idx >= 0 else rows
    judged = sum(1 for r in tail if "agent_verdict" in r and r.get("agent_verdict") is not None)
    return len(tail), judged, last_promote_ts


def main() -> int:
    cfg = load_config()
    rows_since, judged, last_promote_ts = walk_ledger()
    now = datetime.now(timezone.utc)
    if last_promote_ts is None:
        days_since = math.inf
    else:
        days_since = (now - last_promote_ts).total_seconds() / 86400.0

    row_ok = rows_since >= cfg["min_rows_since_last_promote"]
    day_ok = days_since >= cfg["cycle_interval_days"]
    judged_ok = judged >= cfg["min_judged_rows"]
    fire = (row_ok or day_ok) and judged_ok

    days_display = "inf" if math.isinf(days_since) else f"{days_since:.1f}"
    verdict = "FIRE" if fire else "SKIP"
    reasons = []
    if not judged_ok:
        reasons.append(f"judged<{cfg['min_judged_rows']}")
    if not (row_ok or day_ok):
        reasons.append(
            f"rows<{cfg['min_rows_since_last_promote']} AND days<{cfg['cycle_interval_days']}"
        )
    suffix = f" [{'; '.join(reasons)}]" if reasons and not fire else ""
    print(
        f"should-retrain: {verdict} (rows_since={rows_since}, days_since={days_display}, "
        f"judged={judged}){suffix}",
        file=sys.stderr,
    )
    return 0 if fire else 1


if __name__ == "__main__":
    sys.exit(main())
