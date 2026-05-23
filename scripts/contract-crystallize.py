#!/usr/bin/env python3
"""
contract-crystallize.py - turn a learning into durable knowledge.

A satisfied contract that carries a `learning`, or an explicit
`contract learn` call, is crystallized onto TWO durable surfaces:

  1. a memory file in the Claude Code auto-memory folder (session recall)
  2. an Outline document at docs.getfoundry.app (the team knowledge base)

This is the operational form of the CONTRACTING_IS_LEARNING doctrine: the
ledger records the learning EVENT; this module turns it into a memory and
a doc so the knowledge is reachable outside the ledger too.

Both surfaces are best-effort and independent - a memory write never
depends on Outline being reachable, and vice versa. Every crystallization
appends a `crystallized` ledger row, which makes the operation idempotent:
a contract is crystallized at most once.

Subcommands:
  contract-crystallize.py from-contract <id>
      Hook path. No-op unless <id> is satisfied, carries a `learning`, and
      has not been crystallized before.
  contract-crystallize.py learn "<text>" [--source <ref>]
      Verb path. Records a `learned` event, then crystallizes it.
  contract-crystallize.py --self-check
      Wiring self-test. Exits 0 when the module's own surfaces resolve.

Env:
  CONTRACT_CRYSTALLIZE_NO_OUTLINE=1     skip the Outline push (tests use this)
  CONTRACT_CRYSTALLIZE_MEMORY_DIR=<d>   force the memory dir (tests use this)
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

_LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")
sys.path.insert(0, _LIB)
import contract_core  # noqa: E402

OUTLINE_DIR = Path.home() / ".config" / "outline"
COLLECTION_CACHE = Path.home() / ".contracts" / "outline-collection.txt"
COLLECTION_NAME = "Contracts"
# Global last-resort memory dir. NOT inside ~/.contracts/ — that path is
# reserved for the literal contract ledger; memory lives under ~/.claude/.
GLOBAL_MEMORY_FALLBACK = Path.home() / ".claude" / "memory"
VALID_MEMORY_TYPES = {"feedback", "project", "reference", "user"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _oneline(s: str) -> str:
    return " ".join((s or "").split())


def _slug(text: str, maxlen: int = 60) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s[:maxlen].rstrip("-") or "learning"


# -- memory surface -----------------------------------------------------------

def resolve_memory_dir(scope_cwd):
    """Resolve the Claude Code project memory dir for a working dir.

    Walks UP from scope_cwd through each ancestor, slugifying it (slashes ->
    dashes, the Claude Code convention), and returns the FIRST existing
    `~/.claude/projects/<slug>/memory/` it finds. Longest prefix wins.

    Example: scope_cwd `/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/frontend`
    tries the slugs for `.../frontend`, `.../unbrowse`, `.../unbrowse-ecosystem`,
    `.../Projects`, `/Users/lekt9`, `/Users`, `/` — and stops at the first
    one whose memory/ exists (the unbrowse project memory in practice).

    If no project memory matches, falls back to `~/.claude/memory/` — the
    GLOBAL memory dir, NEVER `~/.contracts/learnings/` (the ledger lives
    there; memory lives under `~/.claude/`).

    CONTRACT_CRYSTALLIZE_MEMORY_DIR overrides everything (tests).
    """
    override = os.environ.get("CONTRACT_CRYSTALLIZE_MEMORY_DIR")
    if override:
        d = Path(override)
        d.mkdir(parents=True, exist_ok=True)
        return d
    if scope_cwd:
        cur = Path(scope_cwd).resolve()
        # Generate ancestors longest-first (current dir, parent, grandparent...)
        candidates = [cur, *cur.parents]
        for ancestor in candidates:
            slug = str(ancestor).replace("/", "-")
            proj = Path.home() / ".claude" / "projects" / slug / "memory"
            if proj.is_dir():
                return proj
    GLOBAL_MEMORY_FALLBACK.mkdir(parents=True, exist_ok=True)
    return GLOBAL_MEMORY_FALLBACK


# --- three-layer doc-org rule (contract 767fd41d) ---------------------------
TITLE_MAX_WORDS = 8
DESCRIPTION_MAX_CHARS = 200
HOOK_MAX_CHARS = 150


def _enforce_layering(title, description, body, hook):
    """Refuse to write a memory file that violates the layering rule:
      - title is ≤ TITLE_MAX_WORDS words and not a prefix of description
      - description is ≤ DESCRIPTION_MAX_CHARS and not equal to (a prefix of) body
      - hook is ≤ HOOK_MAX_CHARS and not equal to description
    Raises ValueError with a precise message so the caller can fix the source,
    not a silent slop write. The substrate emits evidence (the violation) — the
    agent fixes the cause."""
    t = _oneline(title or "")
    d = _oneline(description or "")
    b_oneline = _oneline(body or "")
    h = _oneline(hook or "")
    word_count = len(t.split())
    if word_count == 0:
        raise ValueError("memory layering: title is empty")
    if word_count > TITLE_MAX_WORDS:
        raise ValueError(
            f"memory layering: title has {word_count} words "
            f"(max {TITLE_MAX_WORDS}): {t!r}")
    if d and (t == d[:len(t)] or t == d):
        raise ValueError(
            f"memory layering: title is a prefix of description — pick a "
            f"distinct human-readable title. title={t!r} desc={d[:80]!r}")
    if len(d) > DESCRIPTION_MAX_CHARS:
        raise ValueError(
            f"memory layering: description {len(d)} chars > "
            f"{DESCRIPTION_MAX_CHARS} cap: {d[:60]!r}…")
    if d and b_oneline:
        # description must not be equal to body or be a prefix of body
        if d == b_oneline[:len(d)] or d == b_oneline:
            raise ValueError(
                "memory layering: description duplicates body verbatim — "
                "description is a one-sentence GIST, not the body itself")
    if len(h) > HOOK_MAX_CHARS:
        raise ValueError(
            f"memory layering: hook {len(h)} chars > {HOOK_MAX_CHARS} cap")
    if d and h and h == d:
        raise ValueError(
            "memory layering: hook equals description — pick a tighter one-liner")


def write_memory(memory_dir, base_name, description, body,
                 memory_type="reference", title=None, hook=None):
    """Write one memory file + a pointer line into that dir's MEMORY.md
    matching the house style (see CLAUDE.md auto-memory spec). Enforces the
    three-layer doc-org rule (contract 767fd41d):

      L1 title (≤ 8 words, human-readable)        — the recall key
      L2 description (≤ 200 chars, one sentence)  — the search gist
      L3 body (full Markdown, **Why:** + **How to apply:** for feedback)

    Each layer is distinct: title is never a prefix of description, description
    is never a verbatim prefix of body, hook (the MEMORY.md teaser) is never
    equal to description and is ≤ 150 chars.

    Provenance (contract id, source) goes in the body's foot, not the head.
    MEMORY.md line: `- [<Title>](<file.md>) — <hook>` (em-dash).

    Never clobbers: collisions get a numeric suffix.
    Raises ValueError when layering is violated — callers must derive distinct
    title/description/hook fields (use _derive_layers as a starting point).
    """
    if memory_type not in VALID_MEMORY_TYPES:
        memory_type = "reference"
    # Fill in defaults from base_name BEFORE enforcement so callers can
    # depend on _derive_layers's defaults being layering-valid.
    if not title:
        # Capitalize-first-word title from the slug — typically already a
        # short human-readable phrase. Slug is already ≤ 60 chars; truncate
        # to the first 8 words to satisfy the layer cap.
        words = base_name.replace("-", " ").split()[:TITLE_MAX_WORDS]
        title = " ".join(words).strip().capitalize()
    desc = _oneline(description)
    if not hook:
        # First sentence of description (≤ HOOK_MAX_CHARS), falling back to a
        # truncated description with ellipsis.
        first = re.split(r"(?<=[.!?])\s+", desc.strip(), maxsplit=1)[0]
        hook = first if len(first) <= HOOK_MAX_CHARS else \
               desc[:HOOK_MAX_CHARS - 1].rstrip() + "…"
    _enforce_layering(title, desc, body, hook)

    memory_dir.mkdir(parents=True, exist_ok=True)
    path = memory_dir / f"{base_name}.md"
    n = 2
    while path.exists():
        path = memory_dir / f"{base_name}-{n}.md"
        n += 1
    name = path.stem
    front = (
        "---\n"
        f"name: {name}\n"
        f"description: {desc}\n"
        "metadata:\n"
        f"  type: {memory_type}\n"
        "---\n\n"
    )
    path.write_text(front + body.rstrip() + "\n")

    index = memory_dir / "MEMORY.md"
    with index.open("a") as f:
        f.write(f"- [{title}]({path.name}) — {_oneline(hook)}\n")
    return path


def _derive_layers(learning):
    """Given the raw learning text, derive (title, description, hook) tuples
    that satisfy the three-layer rule.

      title       — first ≤ 8 words of the lead sentence, capitalized
      description — first sentence (≤ 200 chars), distinct from body
      hook        — first sentence (≤ 150 chars), distinct from description
                    when possible (truncates more aggressively)
    The body itself stays full text — the caller composes it via _compose_body.
    """
    raw = _oneline(learning)
    first = re.split(r"(?<=[.!?])\s+", raw, maxsplit=1)[0]
    words = first.split()
    title = " ".join(words[:TITLE_MAX_WORDS]).rstrip(".,:;")
    # Description: one sentence, ≤ 200 chars
    description = first if len(first) <= DESCRIPTION_MAX_CHARS \
                  else first[:DESCRIPTION_MAX_CHARS - 1].rstrip() + "…"
    # Hook: tighter — ≤ 150 chars, drop the trailing period if it fits cleanly
    hook = first if len(first) <= HOOK_MAX_CHARS \
           else first[:HOOK_MAX_CHARS - 1].rstrip() + "…"
    return title, description, hook


# -- Outline surface ----------------------------------------------------------

def _outline_config():
    """Return (token, base) for the Outline API, or (None, None) when Outline
    is not configured. A missing config is the normal not-set-up case (no
    exception); a config that exists but cannot be read is a real fault and
    is reported on stderr - never swallowed."""
    tok_f = OUTLINE_DIR / "token"
    base_f = OUTLINE_DIR / "baseurl"
    if not (tok_f.exists() and base_f.exists()):
        return None, None
    try:
        token = tok_f.read_text().strip()
        base = base_f.read_text().strip()
    except OSError as e:
        print(f"contract-crystallize: Outline config present but unreadable: {e}",
              file=sys.stderr)
        return None, None
    if token and base:
        return token, base
    return None, None
def _outline_call(base, token, action, payload):
    # A custom User-Agent is load-bearing: the Cloudflare edge in front of
    # the self-hosted Outline 403s the default `Python-urllib` UA as a bot.
    req = urllib.request.Request(
        f"{base}/api/{action}",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "contract-crystallize/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())
def _collection_id(base, token):
    """Resolve the destination collection id, find-or-create, cached.
    Prefers an existing collection named COLLECTION_NAME - the create path is
    a fallback (the personal token may lack collections.create permission)."""
    if COLLECTION_CACHE.exists():
        cid = COLLECTION_CACHE.read_text().strip()
        if cid:
            return cid
    res = _outline_call(base, token, "collections.list", {"limit": 100})
    for c in res.get("data", []):
        if c.get("name") == COLLECTION_NAME:
            COLLECTION_CACHE.parent.mkdir(parents=True, exist_ok=True)
            COLLECTION_CACHE.write_text(c["id"])
            return c["id"]
    res = _outline_call(base, token, "collections.create", {
        "name": COLLECTION_NAME,
        "description": "Learnings crystallized from the contract ledger.",
        "sharing": False,
    })
    cid = res["data"]["id"]
    COLLECTION_CACHE.parent.mkdir(parents=True, exist_ok=True)
    COLLECTION_CACHE.write_text(cid)
    return cid


def push_outline(title, body):
    """Best-effort: create an Outline doc. Returns the doc URL, or None when
    skipped (no config / disabled). A failure is reported on stderr - which
    the hook runner captures to errors.log - never silently swallowed."""
    if os.environ.get("CONTRACT_CRYSTALLIZE_NO_OUTLINE"):
        return None
    token, base = _outline_config()
    if not token:
        print("contract-crystallize: no Outline config at ~/.config/outline/ "
              "- memory written, Outline doc skipped", file=sys.stderr)
        return None
    try:
        cid = _collection_id(base, token)
        res = _outline_call(base, token, "documents.create", {
            "collectionId": cid,
            "title": _oneline(title)[:100],
            "text": body,
            "publish": True,
        })
        url = res.get("data", {}).get("url")
        if url and url.startswith("/"):
            return f"{base}{url}"
        return url
    except (urllib.error.URLError, OSError, KeyError,
            json.JSONDecodeError, ValueError) as e:
        print(f"contract-crystallize: Outline push failed (non-fatal, "
              f"memory file still written): {e}", file=sys.stderr)
        return None


# -- crystallize --------------------------------------------------------------

def _compose_body(learning, cid=None, lid=None, plan=None, source=None):
    """Build the memory body. If the learning text contains `Why:` /
    `How to apply:` (case-insensitive) sections, render them as **Why:** /
    **How to apply:** headings — the house style for feedback/project
    memories. Otherwise emit a single narrative paragraph. Provenance
    (contract id, ledger event id, source) goes at the foot, not the head."""
    text = learning.strip()
    # Split on Why:/How to apply: markers if present.
    why_match = re.search(r"(?im)^\s*why\s*:\s*", text)
    how_match = re.search(r"(?im)^\s*how(?:\s+to\s+apply)?\s*:\s*", text)
    parts = []
    if why_match or how_match:
        # Narrative is everything before the first marker.
        first = min(m.start() for m in (why_match, how_match) if m)
        narrative = text[:first].strip()
        if narrative:
            parts.append(narrative)
        if why_match:
            end = how_match.start() if (how_match and how_match.start() > why_match.start()) else len(text)
            why = text[why_match.end():end].strip()
            if why:
                parts.append(f"**Why:** {why}")
        if how_match:
            end = why_match.start() if (why_match and why_match.start() > how_match.start()) else len(text)
            how = text[how_match.end():end].strip()
            if how:
                parts.append(f"**How to apply:** {how}")
    else:
        parts.append(text)

    foot = []
    if cid:
        foot.append(f"_Contract:_ `{cid}` (satisfied)")
    if lid:
        foot.append(f"_Learned event:_ `{lid}`")
    if source:
        foot.append(f"_Source:_ {source}")
    if plan and plan.strip() != text:
        foot.append(f"_Truth claim:_ {plan}")
    if foot:
        parts.append("\n".join(foot))
    return "\n\n".join(parts) + "\n"


def _infer_memory_type(learning, source):
    """Heuristic mapping from the learning's surface form to a memory type.

    feedback — corrections / preferences / "BANNED" / "must always" rules
    project — dated decisions / ongoing initiatives ("we're going to X by Y")
    reference — facts, pointers, API/credential locations (default)
    """
    t = (learning or "").lower()
    if any(k in t for k in ("banned", "must always", "never ", "always ",
                            "do not ", "don't ", "stop ", "lesson:",
                            "correction:", "feedback:")):
        return "feedback"
    if any(k in t for k in ("we will ", "we're going to ", "by 2026-",
                            "by next ", "deadline ", "sprint ")):
        return "project"
    return "reference"


def _hook_from_learning(learning):
    """Generate a ≤200-char one-line hook from the full learning text."""
    text = _oneline(learning)
    # Prefer the lead sentence, fall back to a hard truncate.
    first = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0]
    if 30 <= len(first) <= 200:
        return first
    return text[:197].rstrip() + "..." if len(text) > 200 else text


def crystallize(base_name, title, description, body, scope_cwd,
                memory_type="reference", hook=None):
    """Write the memory file + push the Outline doc. Returns (mem_path, url)."""
    memory_dir = resolve_memory_dir(scope_cwd)
    mem_path = write_memory(memory_dir, base_name, description, body,
                            memory_type=memory_type, title=title, hook=hook)
    url = push_outline(title, body + f"\n\nMemory: `{mem_path}`\n")
    return str(mem_path), url


def from_contract(cid):
    """Hook path. Self-guarded: returns 0 (no-op) for any contract that is
    not a freshly-satisfied, learning-bearing, not-yet-crystallized one."""
    c = contract_core.get(cid)
    if not c or c.get("status") != "satisfied":
        return 0
    learning = c.get("learning")
    if not learning:
        return 0
    if contract_core.is_crystallized(cid):
        return 0
    plan = c.get("plan", "")
    body = _compose_body(learning, cid=cid, plan=plan)
    mtype = _infer_memory_type(learning, None)
    hook = _hook_from_learning(learning)
    # Title shown in MEMORY.md link text — capped human-readable phrase.
    title = _oneline(learning)[:70].rstrip()
    mem_path, url = crystallize(
        _slug(learning), title, learning, body,
        c.get("cwd"), memory_type=mtype, hook=hook)
    contract_core.record_crystallization(cid, mem_path, url)
    print(f"crystallized {cid}: memory={mem_path} outline={url or '(skipped)'}")
    return 1


def learn(text, source):
    """Verb path. Records a `learned` event, then crystallizes it."""
    lid = contract_core.record_learning(text, source)
    body = _compose_body(text, lid=lid, source=source)
    mtype = _infer_memory_type(text, source)
    hook = _hook_from_learning(text)
    title = _oneline(text)[:70].rstrip()
    mem_path, url = crystallize(
        _slug(text), title, text, body,
        os.getcwd(), memory_type=mtype, hook=hook)
    contract_core.record_crystallization(lid, mem_path, url)
    print(f"learned {lid}")
    print(f"  memory:  {mem_path}")
    print(f"  outline: {url or '(skipped or unreachable)'}")
    return 1


def self_check():
    ok = True
    d = resolve_memory_dir("/nonexistent/probe/path/xyz")
    if not d.is_dir() or not os.access(d, os.W_OK):
        print(f"self-check FAIL: memory dir {d} not writable")
        ok = False
    if contract_core.is_crystallized("00000000"):
        print("self-check FAIL: is_crystallized true for an unknown id")
        ok = False
    if _slug("Hello, World! 123") != "hello-world-123":
        print("self-check FAIL: _slug")
        ok = False
    token, _ = _outline_config()
    print(f"self-check: outline config {'present' if token else 'absent'}")
    print(f"self-check: memory fallback dir {d}")
    print("self-check PASS" if ok else "self-check FAIL")
    return 0 if ok else 1


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--self-check":
        return self_check()
    if argv[0] == "from-contract" and len(argv) > 1:
        from_contract(argv[1])
        return 0
    if argv[0] == "learn" and len(argv) > 1:
        text = argv[1]
        source = None
        rest = argv[2:]
        i = 0
        while i < len(rest):
            if rest[i] == "--source" and i + 1 < len(rest):
                source = rest[i + 1]
                i += 2
            else:
                i += 1
        learn(text, source)
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
