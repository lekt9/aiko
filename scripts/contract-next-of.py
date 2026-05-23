#!/usr/bin/env python3
"""contract-next-of.py — propose the next-layer contract for an unresolved <id>.

Lewis 2026-05-24: "/contract should also rely on a similar style but for
post /contract programmatic wiring hooks for /contract finishing the next
layer of /contract that makes most sense to fire if /contract cant resolve
yet."

Symmetric to contract-context-of.py (eb663e04) but post-iterate:

  context-of: fetch knowledge BEFORE running a contract
  next-of:    propose the next contract to fire AFTER a stalled one

Sources are non-binding. Any subset can be present; missing ones skip
silently. Default order: judge-says → child-gap → failure-pattern →
search-bm25 → stdin. With --auto-declare, the top-ranked proposal is
declared as a child contract programmatically (programmatic wiring per
Lewis's framing).

Output envelope:
    {
      "id":         "<the unresolved contract>",
      "status":     "<that contract's current status>",
      "tried":      ["judge-says","child-gap",...],
      "proposals":  [
        {
          "source":   "<which source>",
          "plan":     "<the suggested next contract's plan>",
          "action":   "<suggested --action>",
          "rationale":"<one-line why>",
          "parent":   "<the unresolved id — usually the right parent>",
          "score":    <int — higher = more confident>
        },
        ...
      ],
      "auto_declared": "<id of declared child, when --auto-declare>"
    }
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent
SOURCES_DIR = SKILL / "next-sources"
LIB = SKILL / "lib"
sys.path.insert(0, str(LIB))
DEFAULT_ORDER = ["judge-says", "child-gap", "failure-pattern", "search-bm25", "stdin"]


def get_contract(cid: str) -> dict | None:
    try:
        from contract_core import get  # type: ignore
        return get(cid)
    except Exception:
        return None


def try_source(name: str, cid: str, contract_data: dict, stdin_data: str | None) -> list[dict]:
    src = SOURCES_DIR / f"{name}.sh"
    if not src.exists() or not os.access(src, os.X_OK):
        return []
    env = dict(os.environ,
               CONTEXT_CONTRACT_ID=cid,
               CONTEXT_CONTRACT_DATA=json.dumps(contract_data))
    try:
        cp = subprocess.run(
            ["bash", str(src), cid],
            input=stdin_data if stdin_data is not None else "",
            text=True, capture_output=True, timeout=30, env=env,
        )
    except subprocess.TimeoutExpired:
        sys.stderr.write(f"  source {name}: timeout\n")
        return []
    if cp.returncode != 0:
        return []
    out = cp.stdout.strip()
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []
    proposals = data if isinstance(data, list) else data.get("proposals", [])
    for p in proposals:
        p.setdefault("source", name)
        p.setdefault("parent", cid)
        p.setdefault("score", 1)
    return proposals


def auto_declare_one(top: dict) -> str | None:
    plan = top.get("plan") or ""
    action = top.get("action") or ""
    parent = top.get("parent") or ""
    if not plan or not action:
        return None
    cli = str(SKILL / "contract")
    cmd = ["bash", cli, "declare", plan, "--action", action, "--no-drive"]
    if parent:
        cmd += ["--parent", parent]
    try:
        cp = subprocess.run(cmd, text=True, capture_output=True, timeout=15)
    except subprocess.TimeoutExpired:
        return None
    if cp.returncode != 0:
        sys.stderr.write(f"  auto-declare refused: {cp.stderr.strip()[:200]}\n")
        return None
    for line in cp.stdout.splitlines():
        if line.startswith("declared: "):
            return line.split(":", 1)[1].strip().split()[0]
    return None


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("id", help="contract id that hasn't resolved yet")
    p.add_argument("--source", default=None, help="force one source")
    p.add_argument("--order", default=None, help="comma-separated source order override")
    p.add_argument("--from-stdin", action="store_true", help="pipe candidate envelope to the stdin source")
    p.add_argument("--auto-declare", action="store_true",
                   help="declare the top-ranked proposal as a child contract")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    cid = args.id.strip()
    if not cid:
        sys.stderr.write("usage: contract next-of <id> [--source <name>] [--auto-declare]\n")
        return 2

    c = get_contract(cid)
    if not c:
        print(json.dumps({"error": "not-found", "id": cid}))
        return 2

    # Carve-out: if already satisfied/merged/rejected, no proposals
    status = c.get("status")
    if status in ("satisfied", "merged", "rejected"):
        print(json.dumps({
            "id": cid, "status": status, "tried": [],
            "proposals": [],
            "note": f"contract is {status} — no next-layer needed",
        }, indent=2))
        return 0

    # Source order
    if args.source:
        if not (SOURCES_DIR / f"{args.source}.sh").exists():
            sys.stderr.write(f"unknown --source {args.source!r}\n")
            return 2
        order = [args.source]
    elif args.order:
        order = [s.strip() for s in args.order.split(",") if s.strip()]
    else:
        order = list(DEFAULT_ORDER)

    stdin_data = None
    if args.from_stdin and not sys.stdin.isatty():
        stdin_data = sys.stdin.read()
    if args.from_stdin and stdin_data:
        order = ["stdin"] + [s for s in order if s != "stdin"]

    tried: list[str] = []
    proposals: list[dict] = []
    for name in order:
        if name == "stdin" and not stdin_data:
            continue
        tried.append(name)
        got = try_source(name, cid, c, stdin_data)
        proposals.extend(got)

    # Rank: higher score first, then by source order
    src_priority = {n: i for i, n in enumerate(DEFAULT_ORDER)}
    proposals.sort(key=lambda p: (-int(p.get("score", 1)),
                                  src_priority.get(p.get("source", ""), 99)))

    envelope = {
        "id": cid,
        "status": status,
        "tried": tried,
        "proposals": proposals,
    }

    if args.auto_declare and proposals:
        new_id = auto_declare_one(proposals[0])
        if new_id:
            envelope["auto_declared"] = new_id

    print(json.dumps(envelope, indent=2))
    return 0 if proposals or args.auto_declare else 1


if __name__ == "__main__":
    sys.exit(main())
