#!/usr/bin/env python3
"""
contract-habit-detect.py — surface recurring contract patterns as candidates.
NEVER auto-declares. Surfaces evidence; agent judges.

Ranking is HYBRID. For each candidate we compute both:
  - bm25_norm  (lexical, Okapi BM25, normalized to the top hit)
  - embed_cos  (semantic, OpenAI text-embedding-3-small cosine, range 0..1)
and report the MAX of the two as the final score, plus a `score_source`
field naming which signal lifted it: "bm25" | "embed" | "hybrid".

Embeddings are cached per-contract at ~/.contracts/embeddings.jsonl keyed
by contract id + a content hash. A cache hit costs zero API calls; a
miss makes one call per new contract. The whole embedding path is
self-guarded: missing OPENAI_API_KEY, network failure, or any other
error degrades cleanly to BM25-only (substrate principle — evidence
only, never a hidden fault).
"""
import json, os, sys, re, math, hashlib, time, urllib.request, urllib.error
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

# --- embedding cache + API --------------------------------------------------

EMBED_CACHE = Path.home() / ".contracts" / "embeddings.jsonl"
EMBED_MODEL = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
EMBED_DIM = 1536  # text-embedding-3-small default
_EMBED_OK = True  # flips false on first failure; stays false for the run
# A bounded per-process budget — never balloon when the corpus grows.
EMBED_MISS_BUDGET = int(os.environ.get("CONTRACT_EMBED_MISS_BUDGET", "32"))


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _load_embed_cache():
    """Return {id: {"hash": str, "vec": list[float]}} from the JSONL cache."""
    cache = {}
    if not EMBED_CACHE.exists():
        return cache
    for line in EMBED_CACHE.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            cache[r["id"]] = {"hash": r["hash"], "vec": r["vec"]}
        except (json.JSONDecodeError, KeyError):
            continue
    return cache


def _append_embed_cache(rid: str, text_hash: str, vec):
    EMBED_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with EMBED_CACHE.open("a") as f:
        f.write(json.dumps({"id": rid, "hash": text_hash, "vec": vec}) + "\n")


def _embed_call(texts):
    """One OpenAI embeddings call for a batch of texts. Returns list[list[float]]
    on success, None on any failure (substrate principle: no silent fault — a
    real error is logged once to stderr, then degrade)."""
    global _EMBED_OK
    if not _EMBED_OK:
        return None
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None
    payload = json.dumps({"model": EMBED_MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "contract-habit-detect/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        return [d["embedding"] for d in data["data"]]
    except (urllib.error.URLError, urllib.error.HTTPError,
            json.JSONDecodeError, KeyError, OSError) as e:
        _EMBED_OK = False
        print(f"contract-habit-detect: embedding API call failed "
              f"(falling back to BM25 only): {e}", file=sys.stderr)
        return None


def _cosine(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x*y for x, y in zip(a, b))
    na = math.sqrt(sum(x*x for x in a))
    nb = math.sqrt(sum(y*y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _embed_scores(query, docs):
    """{id: cosine(query, doc)} for each doc. Honors the cache; bounded misses.
    Returns {} when embeddings are unavailable."""
    if not _EMBED_OK:
        return {}
    cache = _load_embed_cache()
    misses = []  # list of (id, text, hash)
    for did, text in docs:
        h = _content_hash(text)
        if did in cache and cache[did]["hash"] == h:
            continue
        misses.append((did, text, h))
        if len(misses) >= EMBED_MISS_BUDGET:
            break  # bound this run; the next call backfills more
    if misses:
        vecs = _embed_call([t for _, t, _ in misses])
        if vecs is None:
            return {}
        for (did, _t, h), v in zip(misses, vecs):
            cache[did] = {"hash": h, "vec": v}
            _append_embed_cache(did, h, v)
    # Embed the query (always — small cost, exact-text-cache-keyed)
    q_hash = _content_hash("__query__" + query)
    q_vec = None
    if q_hash in cache:
        q_vec = cache[q_hash]["vec"]
    else:
        vecs = _embed_call([query])
        if vecs:
            q_vec = vecs[0]
            cache[q_hash] = {"hash": q_hash, "vec": q_vec}
            _append_embed_cache(q_hash, q_hash, q_vec)
    if not q_vec:
        return {}
    return {
        did: max(0.0, _cosine(q_vec, cache[did]["vec"]))
        for did, _t in docs
        if did in cache
    }


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
    bm25 = {did: (rs / top) for did, rs in raw.items()}
    embed = _embed_scores(context, docs)  # {} when key absent / call fails

    results = []
    for did in bm25:
        bm = bm25.get(did, 0.0)
        em = embed.get(did, 0.0)
        score = max(bm, em)
        if score < threshold:
            continue
        # Attribute which signal lifted this candidate above threshold.
        if em >= threshold and bm >= threshold:
            src = "hybrid"
        elif em >= threshold and em > bm:
            src = "embed"
        else:
            src = "bm25"
        c, status = meta[did]
        results.append({
            "id": did,
            "plan": c["plan"],
            "action": c["action"],
            "learning": c.get("learning"),
            "status": status,
            "score": round(score, 2),
            "bm25": round(bm, 2),
            "embed": round(em, 2) if em else None,
            "score_source": src,
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

    print(f"RELATED CONTRACTS (threshold={args.threshold}):")
    print()
    for c in candidates:
        icon = "+" if c["status"] == "satisfied" else "~"
        src = c.get("score_source", "bm25")
        em = c.get("embed")
        bm = c.get("bm25", c["score"])
        sig = f"bm25={bm} embed={em}" if em is not None else f"bm25={bm}"
        print(f"  [{icon}] score={c['score']} via {src}  ({sig})  id={c['id']}  status={c['status']}")
        print(f"      plan:   {c['plan'][:80]}")
        if c.get("learning"):
            print(f"      why:    {c['learning'][:100]}")
        print(f"      action: {c['action'][:60]}")
        print(f"      -> contract iterate {c['id']}")
        print(f"      -> contract spawn {c['id']} \"<sub>\" --action \"<cmd>\"")
        print(f"      -> contract:{c['id']}    (link this contract as a gate)")
        print()
if __name__ == "__main__":
    main()
