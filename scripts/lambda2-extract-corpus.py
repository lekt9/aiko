#!/usr/bin/env python3
"""
lambda2-extract-corpus.py — Λ2 Stage 2: extract KEY-2 distillate training corpus.

Walks ~/.contracts/contracts.jsonl (override via CONTRACTS_STORE) and emits
JSONL instruction-following rows for fine-tuning the KEY-2 judge LLM.

Row shape:
  {
    "instruction": "You are judging KEY 2 for /contract. ...",
    "input":       "PLAN: ...\\n\\nACTION RESULT: ...\\n\\nEXIT: ...\\n\\nPROOF (if marked): ...",
    "output":      "<PROMOTE | HOLD | REJECT>\\n\\nREASON: <verdict text>",
    "class":       "positive | negative | rejected"
  }

Classes (Λ2 plan):
  positive  — iterated→satisfied chain with no later 'merged' supersession (agent JUDGED genuine)
  negative  — iterated with verdict HOLD/REJECT (agent correctly didn't mark)
  rejected  — satisfied then later 'merged' with a regression-flavored reason (fake-green slipped through)

Filter:
  Σ2-audience: skip rows tagged audience=public (Aiko-voice, wrong shape for KEY-2).
  Default include when audience missing/null (legacy team-tier).

Held-out split:
  deterministic via hash(declared_id) % 10 == 0 → held-out, else → train.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

INSTRUCTION = (
    "You are judging KEY 2 for /contract. Read the iterate output and the plan. "
    "Decide PROMOTE | HOLD | REJECT."
)

DEFAULT_STORE = Path(os.path.expanduser("~/.contracts/contracts.jsonl"))


def _load_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def _audience_ok(row: dict[str, Any]) -> bool:
    """Σ2 filter: exclude public-audience rows; include when missing/null."""
    a = row.get("audience")
    if a is None:
        return True
    if isinstance(a, str):
        return a != "public"
    if isinstance(a, (list, tuple, set)):
        return "public" not in a
    return True


def _verdict_to_label(v: Any) -> str | None:
    if not v:
        return None
    s = str(v).strip().upper()
    # iterated.agent_verdict typically: genuine | hold | reject | continue | break
    if s in {"GENUINE", "PASS", "PROMOTE", "BREAK"}:
        return "PROMOTE"
    if s in {"HOLD", "CONTINUE", "PENDING"}:
        return "HOLD"
    if s in {"REJECT", "FAIL", "REGRESS", "REGRESSED"}:
        return "REJECT"
    return None


def _is_regression_reason(reason: str | None) -> bool:
    if not reason:
        return False
    r = reason.lower()
    return any(k in r for k in ("regress", "fake", "duplicate", "supersed", "wins", "false"))


def _truncate(s: Any, n: int = 4000) -> str:
    if s is None:
        return ""
    s = str(s)
    return s if len(s) <= n else s[:n] + "...[truncated]"


def _make_input(plan: str, action_result: Any, action_exit: Any, proof: str | None) -> str:
    return (
        f"PLAN: {_truncate(plan)}\n\n"
        f"ACTION RESULT: {_truncate(action_result)}\n\n"
        f"EXIT: {action_exit if action_exit is not None else ''}\n\n"
        f"PROOF (if marked): {_truncate(proof or '')}"
    )


def _make_output(label: str, reason: str | None) -> str:
    return f"{label}\n\nREASON: {_truncate(reason or '')}"


def _held_out(declared_id: str) -> bool:
    h = int(hashlib.sha1(declared_id.encode("utf-8")).hexdigest(), 16)
    return (h % 10) == 0


def extract(rows: list[dict[str, Any]]) -> Iterable[tuple[dict[str, Any], str]]:
    """Yield (training_row, declared_id) tuples."""

    # Index by id
    declared: dict[str, dict[str, Any]] = {}
    iterations: dict[str, list[dict[str, Any]]] = defaultdict(list)
    satisfactions: dict[str, list[dict[str, Any]]] = defaultdict(list)
    merges: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for r in rows:
        ev = r.get("event")
        cid = r.get("id")
        if not cid:
            continue
        if ev == "declared":
            declared[cid] = r
        elif ev == "iterated":
            iterations[cid].append(r)
        elif ev == "satisfied":
            satisfactions[cid].append(r)
        elif ev == "merged":
            merges[cid].append(r)

    for cid, d in declared.items():
        if not _audience_ok(d):
            continue
        plan = d.get("plan", "")
        iters = iterations.get(cid, [])
        sats = satisfactions.get(cid, [])
        mrgs = merges.get(cid, [])

        # rejected: satisfied then later merged with regression reason
        if sats and mrgs:
            # any merge timestamp after a satisfied timestamp?
            sat_max = max((s.get("ts", "") for s in sats), default="")
            regress_merges = [
                m for m in mrgs if m.get("ts", "") > sat_max and _is_regression_reason(m.get("reason"))
            ]
            if regress_merges:
                # Build a rejected row from the last iterate (best-effort)
                it = iters[-1] if iters else {}
                last_sat = sats[-1]
                m = regress_merges[-1]
                row = {
                    "instruction": INSTRUCTION,
                    "input": _make_input(
                        plan, it.get("action_result"), it.get("action_exit"), last_sat.get("proof")
                    ),
                    "output": _make_output(
                        "REJECT",
                        f"superseded: {m.get('reason', '')} (merged_into={m.get('merged_into', '')})",
                    ),
                    "class": "rejected",
                }
                yield row, cid
                continue  # don't also emit as positive

        # positive: satisfied chain (no regression-merge after sat)
        if sats:
            last_sat = sats[-1]
            # filter: must have real proof (skip proof-skip / bare)
            proof = last_sat.get("proof")
            if proof:
                # pick the iterate row closest before satisfied
                ts_sat = last_sat.get("ts", "")
                prior_iters = [it for it in iters if it.get("ts", "") <= ts_sat]
                it = prior_iters[-1] if prior_iters else (iters[-1] if iters else {})
                row = {
                    "instruction": INSTRUCTION,
                    "input": _make_input(
                        plan, it.get("action_result"), it.get("action_exit"), proof
                    ),
                    "output": _make_output(
                        "PROMOTE", it.get("agent_verdict") or "satisfied with proof"
                    ),
                    "class": "positive",
                }
                yield row, cid
                continue

        # negative: iterated with HOLD/REJECT verdict, never satisfied
        if iters and not sats:
            for it in iters:
                label = _verdict_to_label(it.get("agent_verdict"))
                if label in {"HOLD", "REJECT"}:
                    row = {
                        "instruction": INSTRUCTION,
                        "input": _make_input(
                            plan, it.get("action_result"), it.get("action_exit"), None
                        ),
                        "output": _make_output(label, it.get("agent_verdict")),
                        "class": "negative",
                    }
                    yield row, cid
                    break


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Λ2 Stage 2: extract KEY-2 training corpus")
    p.add_argument("--out", type=str, default=None, help="train output JSONL (default stdout)")
    p.add_argument("--held-out", type=str, default=None, help="held-out split JSONL path")
    p.add_argument("--limit", type=int, default=0, help="cap total emitted rows (0=no cap)")
    p.add_argument("--summary", action="store_true", help="print class counts to stderr")
    args = p.parse_args(argv)

    store = Path(os.environ.get("CONTRACTS_STORE", str(DEFAULT_STORE)))
    if not store.exists():
        print(f"contracts store not found: {store}", file=sys.stderr)
        return 2

    rows = _load_rows(store)

    train_fh = open(args.out, "w", encoding="utf-8") if args.out else sys.stdout
    held_fh = open(args.held_out, "w", encoding="utf-8") if args.held_out else None

    counts = {"positive": 0, "negative": 0, "rejected": 0, "total": 0, "held_out": 0}

    try:
        for training_row, declared_id in extract(rows):
            if args.limit and counts["total"] >= args.limit:
                break
            line = json.dumps(training_row, ensure_ascii=False)
            if held_fh is not None and _held_out(declared_id):
                held_fh.write(line + "\n")
                counts["held_out"] += 1
            else:
                train_fh.write(line + "\n")
            counts[training_row["class"]] += 1
            counts["total"] += 1
    finally:
        if args.out:
            train_fh.close()
        if held_fh is not None:
            held_fh.close()

    if args.summary:
        print(
            f"positive={counts['positive']} "
            f"negative={counts['negative']} "
            f"rejected={counts['rejected']} "
            f"total={counts['total']} "
            f"held_out={counts['held_out']}",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
