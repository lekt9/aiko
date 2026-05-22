#!/usr/bin/env python3
"""
contract-habit-detect.py — surface recurring contract patterns as candidates.
NEVER auto-declares. Surfaces evidence; agent judges.
"""
import json, os, sys, re, math
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


def _idf(df: int, n_docs: int) -> float:
    """BM25 inverse document frequency. The +1 inside the log keeps it
    non-negative even for a term that appears in every document."""
    return math.log(1 + (n_docs - df + 0.5) / (df + 0.5))


def _bm25_scores(query: str, docs: list) -> dict:
    """Okapi BM25 score of `query` against each document.

    docs: list of (id, text). Returns {id: raw_score}. A rare query term
    (high idf) lifts a document far more than a common one; term frequency
    saturates (k1); long documents are length-normalized (b). This is what
    'discover and reuse by BM25' means at the plan stage — not bare overlap.
    """
    K1, B = 1.5, 0.75
    tokenized = {did: _tokenize(text) for did, text in docs}
    n = len(tokenized) or 1
    lengths = {did: sum(t.values()) for did, t in tokenized.items()}
    avgdl = (sum(lengths.values()) / n) if n else 1.0
    df = Counter()
    for toks in tokenized.values():
        for term in toks:
            df[term] += 1
    q_terms = list(_tokenize(query))
    scores = {}
    for did, doc_tf in tokenized.items():
        dl = lengths[did] or 1
        s = 0.0
        for term in q_terms:
            tf = doc_tf.get(term, 0)
            if not tf:
                continue
            idf = _idf(df.get(term, 0), n)
            denom = tf + K1 * (1 - B + B * dl / (avgdl or 1))
            s += idf * (tf * (K1 + 1)) / denom
        scores[did] = s
    return scores
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
    # A merged contract is superseded — terminal status, overrides all else.
    if any(r.get("id") == id and r.get("event") == "merged" for r in rows):
        return "merged"
    for r in reversed(rows):
        if r.get("id") == id:
            if r.get("event") == "satisfied":
                return "satisfied"
            if r.get("event") == "status_update":
                return r.get("status", "?")
    iter_rows = [r for r in rows if r.get("id") == id and r.get("event") == "iterated"]
    return "active" if iter_rows else "pending"
def detect(context: str, threshold: float = DEFAULT_THRESHOLD,
           exclude: "set | None" = None) -> list[dict]:
    """Rank past contracts against `context` by BM25 and surface the
    relevant ones. Score is BM25 normalized to 0..1 against the best match,
    so `threshold` reads as 'at least this fraction as relevant as the top
    hit'. Merged fossils and excluded ids never enter the corpus."""
    exclude = exclude or set()
    all_rows = load_rows()
    contracts = [r for r in all_rows if r.get("event") == "declared"]
    docs, meta = [], {}
    for c in contracts:
        if c["id"] in exclude:
            continue
        status = get_status(c["id"], all_rows)
        if status == "merged":
            continue  # superseded fossil — natural selection: never resurface
        searchable = c["plan"] + (" " + c["learning"] if c.get("learning") else "")
        docs.append((c["id"], searchable))
        meta[c["id"]] = (c, status)
    if not docs:
        return []
    raw = _bm25_scores(context, docs)
    top = max(raw.values(), default=0.0) or 1.0
    results = []
    for did, rs in raw.items():
        norm = rs / top
        if norm >= threshold:
            c, status = meta[did]
            results.append({
                "id": did,
                "plan": c["plan"],
                "action": c["action"],
                "learning": c.get("learning"),
                "status": status,
                "score": round(norm, 2),
            })
    return sorted(results, key=lambda x: -x["score"])
def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="Surface recurring contract candidates. Never auto-declares.")
    parser.add_argument("--context", default="", help="Text to match against")
    parser.add_argument("--scope", default="global", choices=["project", "global"])
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--exclude", default="",
                        help="Comma-separated contract ids to omit (e.g. the just-declared one)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    ctx = args.context
    if not ctx and not sys.stdin.isatty():
        ctx = sys.stdin.read()
    if not ctx:
        ctx = "contract declare iterate spawn solve"

    exclude = {x.strip() for x in args.exclude.split(",") if x.strip()}
    candidates = detect(ctx, args.threshold, exclude)

    if args.json:
        print(json.dumps(candidates, indent=2))
        return

    total = len([r for r in load_rows() if r.get("event") == "declared"])
    if not candidates:
        print(f"  (no RELATED CONTRACTS above threshold={args.threshold}, {total} contracts in ledger)")
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
