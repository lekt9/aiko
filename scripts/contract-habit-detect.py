#!/usr/bin/env python3
"""
contract-habit-detect.py — surface recurring contract patterns as candidates.
NEVER auto-declares. Surfaces evidence; agent judges.
"""
import json, os, sys, re
from pathlib import Path
from collections import Counter


def _resolve_ledger() -> Path:
    """Same resolution as contract_core: env override > project > global."""
    if env := os.environ.get("CONTRACTS_STORE"):
        return Path(env)
    project_dir = Path.cwd() / ".claude"
    if project_dir.is_dir():
        return project_dir / "contracts.jsonl"
    return Path.home() / ".contracts" / "contracts.jsonl"


LEDGER = _resolve_ledger()
_WARNED_LINES: set = set()
DEFAULT_THRESHOLD = 0.55


def _tokenize(text: str) -> Counter:
    return Counter(re.findall(r"[a-z0-9]+", text.lower()))


def _overlap(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    shared = sum((a & b).values())
    denom = min(sum(a.values()), sum(b.values()))
    return shared / denom if denom else 0.0


def load_rows() -> list[dict]:
    if not LEDGER.exists():
        return []
    out = []
    for n, line in enumerate(LEDGER.read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as e:
            if n not in _WARNED_LINES:
                _WARNED_LINES.add(n)
                print(f"contract: WARNING {LEDGER} line {n} is corrupt "
                      f"and was skipped: {e}", file=sys.stderr)
    return out


def get_status(id: str, rows: list[dict]) -> str:
    for r in reversed(rows):
        if r.get("id") == id:
            if r.get("event") == "satisfied":
                return "satisfied"
            if r.get("event") == "status_update":
                return r.get("status", "?")
    iter_rows = [r for r in rows if r.get("id") == id and r.get("event") == "iterated"]
    return "active" if iter_rows else "pending"


def detect(context: str, threshold: float = DEFAULT_THRESHOLD) -> list[dict]:
    all_rows = load_rows()
    contracts = [r for r in all_rows if r.get("event") == "declared"]
    ctx_tokens = _tokenize(context)
    results = []
    for c in contracts:
        # BM25 tokens: plan + learning (why it was done that way)
        searchable = c["plan"] + (" " + c["learning"] if c.get("learning") else "")
        score = _overlap(ctx_tokens, _tokenize(searchable))
        if score >= threshold:
            results.append({
                "id": c["id"],
                "plan": c["plan"],
                "action": c["action"],
                "learning": c.get("learning"),
                "status": get_status(c["id"], all_rows),
                "score": round(score, 2),
            })
    return sorted(results, key=lambda x: -x["score"])
def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="Surface recurring contract candidates. Never auto-declares.")
    parser.add_argument("--context", default="", help="Text to match against")
    parser.add_argument("--scope", default="global", choices=["project", "global"])
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    ctx = args.context
    if not ctx and not sys.stdin.isatty():
        ctx = sys.stdin.read()
    if not ctx:
        ctx = "contract declare iterate spawn solve"

    candidates = detect(ctx, args.threshold)

    if args.json:
        print(json.dumps(candidates, indent=2))
        return

    total = len([r for r in load_rows() if r.get("event") == "declared"])
    if not candidates:
        print(f"  (no HABIT CANDIDATES above threshold={args.threshold}, {total} contracts in ledger)")
        return

    print(f"HABIT CANDIDATES (threshold={args.threshold}):")
    print()
    for c in candidates:
        icon = "+" if c["status"] == "satisfied" else "~"
        print(f"  [{icon}] score={c['score']}  id={c['id']}  status={c['status']}")
        print(f"      plan:   {c['plan'][:80]}")
        if c.get("learning"):
            print(f"      why:    {c['learning'][:100]}")
        print(f"      action: {c['action'][:60]}")
        print(f"      -> contract iterate {c['id']}")
        print(f"      -> contract spawn {c['id']} \"<sub>\" --action \"<cmd>\"")
        print()
if __name__ == "__main__":
    main()
