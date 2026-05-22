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
LEARNINGS_FALLBACK = Path.home() / ".contracts" / "learnings"


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
    Falls back to ~/.contracts/learnings/ when no project memory dir exists.
    CONTRACT_CRYSTALLIZE_MEMORY_DIR overrides everything (tests)."""
    override = os.environ.get("CONTRACT_CRYSTALLIZE_MEMORY_DIR")
    if override:
        d = Path(override)
        d.mkdir(parents=True, exist_ok=True)
        return d
    if scope_cwd:
        slug = str(Path(scope_cwd)).replace("/", "-")
        proj = Path.home() / ".claude" / "projects" / slug / "memory"
        if proj.is_dir():
            return proj
    LEARNINGS_FALLBACK.mkdir(parents=True, exist_ok=True)
    return LEARNINGS_FALLBACK


def write_memory(memory_dir, base_name, description, body):
    """Write one memory file + a pointer line into that dir's MEMORY.md.
    Never clobbers an existing file: collisions get a numeric suffix."""
    memory_dir.mkdir(parents=True, exist_ok=True)
    path = memory_dir / f"{base_name}.md"
    n = 2
    while path.exists():
        path = memory_dir / f"{base_name}-{n}.md"
        n += 1
    name = path.stem
    desc = _oneline(description)
    front = (
        "---\n"
        f"name: {name}\n"
        f"description: {desc}\n"
        "metadata:\n"
        "  type: reference\n"
        "---\n\n"
    )
    path.write_text(front + body.rstrip() + "\n")
    index = memory_dir / "MEMORY.md"
    with index.open("a") as f:
        f.write(f"- [{desc}]({path.name}) - crystallized learning {_now_iso()[:10]}\n")
    return path


# -- Outline surface ----------------------------------------------------------

def _outline_config():
    try:
        token = (OUTLINE_DIR / "token").read_text().strip()
        base = (OUTLINE_DIR / "baseurl").read_text().strip()
        if token and base:
            return token, base
    except OSError:
        pass
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

def crystallize(base_name, title, description, body, scope_cwd):
    """Write the memory file + push the Outline doc. Returns (mem_path, url)."""
    memory_dir = resolve_memory_dir(scope_cwd)
    mem_path = write_memory(memory_dir, base_name, description, body)
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
    body = (
        f"**Learning:** {learning}\n\n"
        f"**Contract:** `{cid}` (satisfied)\n\n"
        f"**Truth claim:** {plan}\n\n"
        f"Crystallized from the contract ledger on {_now_iso()}.\n"
    )
    mem_path, url = crystallize(
        _slug(learning), f"Learning: {learning}", learning, body, c.get("cwd"))
    contract_core.record_crystallization(cid, mem_path, url)
    print(f"crystallized {cid}: memory={mem_path} outline={url or '(skipped)'}")
    return 1


def learn(text, source):
    """Verb path. Records a `learned` event, then crystallizes it."""
    lid = contract_core.record_learning(text, source)
    body = (
        f"**Learning:** {text}\n\n"
        f"**Learned event:** `{lid}`\n"
    )
    if source:
        body += f"**Source:** {source}\n"
    body += f"\nRecorded via `contract learn` on {_now_iso()}.\n"
    mem_path, url = crystallize(
        _slug(text), f"Learning: {text}", text, body, os.getcwd())
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
