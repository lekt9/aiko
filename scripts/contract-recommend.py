#!/usr/bin/env python3
"""Λ7 reference implementation: recommend-by-binding.

Given a recommendation context, surfaces the top-N existing /contract
rows that already encode the requested truth claim, each annotated with:

  - lineage_owned: bool      # is the contract's agent within the requester's Σ3 lineage?
  - bind_action:   str        # contract:<id>       if free (lineage-owned)
                              # x402:contract:<id>  if pay-to-owner (foreign)
  - owner:         str        # the agent attribution from the row

The agent reading this output picks the highest-scoring match and binds
it via the suggested action — never recreates a row that already
encodes the same truth.

Composition:
  · Σ1 (agent attribution on every row)
  · Σ3 (identity aliases, union-find via `contract alias`)
  · BM25 search (contract-habit-detect)
  · contract-ref pointer (free intra-lineage binding)
  · x402 pointer (pay-to-owner cross-lineage binding)

Usage:
  contract-recommend.py --context "<plan text>" \
                        [--canonical <my-id>] \
                        [--top 5] [--threshold 0.55] \
                        [--default-cost 10] [--json]

Substrate enables; agent judges KEY 2. This script never declares.
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys, re
from pathlib import Path

CONTRACT_CLI = Path(os.path.expanduser("~/.claude/skills/contract/scripts/contract"))


def _canonical_self() -> str:
    if v := os.environ.get("CONTRACT_AGENT"):
        return v
    try:
        out = subprocess.check_output(["git", "config", "user.email"], text=True).strip()
        if out:
            return out
    except Exception:
        pass
    return "anonymous"


def _resolve_aliases(canonical: str) -> set[str]:
    """Σ3 walk: return every identity unified with `canonical` via the
    alias-row equivalence class. Falls back to {canonical} if alias
    machinery is absent."""
    aliases = {canonical}
    ledger = Path(os.path.expanduser("~/.contracts/contracts.jsonl"))
    if not ledger.exists():
        return aliases
    # Two-pass union-find: collect (canonical, alias) edges, then walk
    edges: list[tuple[str, str]] = []
    try:
        with ledger.open() as f:
            for line in f:
                line = line.strip()
                if not line or '"event"' not in line: continue
                if '"alias"' not in line and '"alias_for"' not in line: continue
                try: row = json.loads(line)
                except Exception: continue
                ev = row.get("event")
                if ev in ("alias_declared", "aliased"):
                    c = row.get("canonical"); a = row.get("alias") or row.get("aliases")
                    if c and a:
                        if isinstance(a, str): edges.append((c, a))
                        elif isinstance(a, list):
                            for x in a: edges.append((c, x))
    except Exception:
        return aliases
    # Iterate to fixed point
    changed = True
    while changed:
        changed = False
        for c, a in edges:
            if c in aliases and a not in aliases:
                aliases.add(a); changed = True
            elif a in aliases and c not in aliases:
                aliases.add(c); changed = True
    return aliases


def _search(context: str, threshold: float) -> list[dict]:
    """Call the existing search verb and parse the candidates."""
    if not CONTRACT_CLI.exists():
        return []
    try:
        proc = subprocess.run(
            [str(CONTRACT_CLI), "search", "--context", context, "--scope", "global"],
            capture_output=True, text=True, timeout=15,
        )
    except Exception as e:
        return [{"_error": str(e)}]
    out = proc.stdout
    matches: list[dict] = []
    current: dict | None = None
    for raw in out.splitlines():
        line = raw.rstrip()
        m = re.match(r"\s*\[\+\]\s+score=([\d.]+)(?:.*?via\s+\S+)?(?:.*?bm25=[\d.]+\s+embed=[\d.]+)?\s+id=([a-f0-9]+)\s+status=(\S+)", line)
        if m:
            if current: matches.append(current)
            current = {"score": float(m.group(1)), "id": m.group(2), "status": m.group(3),
                       "plan": "", "action": "", "owner": ""}
            continue
        if current is None: continue
        if (sm := re.match(r"\s*plan:\s+(.*)", line)):
            current["plan"] = sm.group(1)
        elif (sm := re.match(r"\s*action:\s+(.*)", line)):
            current["action"] = sm.group(1)
    if current: matches.append(current)
    return [m for m in matches if m.get("score", 0) >= threshold]


def _row_owner(row_id: str) -> str:
    """Best-effort fetch of the declared row's `agent` attribution."""
    ledger = Path(os.path.expanduser("~/.contracts/contracts.jsonl"))
    if not ledger.exists(): return ""
    try:
        with ledger.open() as f:
            for line in f:
                if f'"{row_id}"' not in line: continue
                try: row = json.loads(line)
                except Exception: continue
                if row.get("event") == "declared" and row.get("id") == row_id:
                    return row.get("agent", "") or ""
    except Exception:
        return ""
    return ""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--context", required=True, help="Truth-claim text to recommend against")
    ap.add_argument("--canonical", default=None, help="Requester identity (defaults to CONTRACT_AGENT/git email)")
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--threshold", type=float, default=0.55)
    ap.add_argument("--default-cost", type=int, default=10)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    canonical = args.canonical or _canonical_self()
    lineage = _resolve_aliases(canonical)
    matches = _search(args.context, args.threshold)[: args.top]
    for m in matches:
        owner = _row_owner(m["id"])
        m["owner"] = owner or "<unknown>"
        is_lineage = (owner and owner in lineage) or (not owner)
        m["lineage_owned"] = bool(is_lineage)
        if is_lineage:
            m["bind_action"] = f"contract:{m['id']}"
            m["cost"] = 0
        else:
            m["bind_action"] = f"x402:contract:{m['id']}?owner={owner}&cost={args.default_cost}"
            m["cost"] = args.default_cost

    if args.json:
        print(json.dumps({
            "canonical": canonical,
            "lineage_size": len(lineage),
            "matches": matches,
        }, indent=2))
        return 0

    if not matches:
        print(f"no rows scored ≥ {args.threshold} for context: {args.context!r}")
        print("→ recommendation: declare a fresh row (no existing binding to reuse)")
        return 0

    print(f"=== Λ7 RECOMMEND-BY-BINDING (canonical={canonical}, lineage={len(lineage)}) ===\n")
    for m in matches:
        tag = "[FREE within lineage]" if m["lineage_owned"] else f"[PAY {m['cost']} to {m['owner']}]"
        print(f"  {tag}  score={m['score']:.2f}  {m['id']}  status={m['status']}")
        print(f"     plan: {m['plan'][:90]}")
        print(f"     bind: {m['bind_action']}\n")
    print("→ KEY 2: pick the highest-confidence binding; declare with --action <bind_action>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
