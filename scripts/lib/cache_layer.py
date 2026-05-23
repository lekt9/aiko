"""cache_layer — 10s sliding-window per-(contract, action, stdin, user) cache.

Origin: 2026-05-24, Lewis: "/contract stdin + contract + 10 second bucket kv
caching of /contracts ... 10 second bucket is last used + key with the user -
where user can be anon/public".

Design:
  * Key  = sha256(contract_id ⨂ action ⨂ stdin_data ⨂ user)
  * TTL  = 10s sliding from mtime (touch-on-read extends the window)
  * Scope = stdio-shaped pointer types ONLY (cli, api, x402, machine, harness).
           agent-judges + composition shapes (funnel, funnel-first, sequence,
           quorum, contract-ref, loop, tool-guard) bypass the cache — KEY 2 is
           in-thread for those and a cached verdict would smuggle a stale
           judgment.
  * Audit = every cache HIT appends a `cached` event row to the ledger. Wave
           is NOT incremented (wave = "times the action actually fired"). Cache
           hits are invisible to wave but visible to the audit trail.

The cache file is JSON; mtime IS the last-used clock. Atomic write via
tempfile + os.replace, so concurrent iterates never read a half-written file.
"""
from __future__ import annotations
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Optional

CACHE_DIR = Path.home() / ".contracts" / "cache"
TTL_SECONDS = 10
CACHEABLE_PTYPES = {"cli", "api", "x402", "machine", "harness"}


def resolve_user() -> str:
    """User identity for cache keying. Distinguishes the REQUESTING user from
    CONTRACT_AGENT (which carries the agent's own identity). Falls back to
    'anon' for unauthenticated / public-tier callers."""
    return (
        os.environ.get("CONTRACT_USER")
        or os.environ.get("CONTRACT_AGENT")
        or "anon"
    )


def is_cacheable(ptype: str) -> bool:
    return ptype in CACHEABLE_PTYPES


def cache_key(contract_id: str, action: str, stdin_data: str, user: str) -> str:
    m = hashlib.sha256()
    for part in (contract_id, action, stdin_data, user):
        m.update((part or "").encode("utf-8"))
        m.update(b"\x00")
    return m.hexdigest()[:32]


def _cache_path(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


def lookup(key: str) -> Optional[dict]:
    """Return cached entry if mtime within TTL; touch mtime on hit. None on miss
    or expiry. Expired files are removed eagerly so the dir doesn't accumulate."""
    p = _cache_path(key)
    if not p.exists():
        return None
    age = time.time() - p.stat().st_mtime
    if age > TTL_SECONDS:
        try:
            p.unlink()
        except OSError:
            pass
        return None
    try:
        data = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        try:
            p.unlink()
        except OSError:
            pass
        return None
    # touch — sliding window extends from last access
    try:
        os.utime(p, None)
    except OSError:
        pass
    data["_age_s"] = round(age, 3)
    return data


def write(key: str, action_exit: int, action_result: str, wave: int,
          ptype: str) -> None:
    """Atomic-write a cache entry. Caller has already determined the pointer
    type is cacheable."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = _cache_path(key)
    payload = {
        "action_exit": action_exit,
        "action_result": (action_result or "")[:4096],
        "source_wave": wave,
        "ptype": ptype,
        "written_at": time.time(),
    }
    fd, tmp = tempfile.mkstemp(dir=str(CACHE_DIR), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(payload))
        os.replace(tmp, p)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def record_hit(contract_id: str, source_wave: int, cache_age_s: float,
               user: str, key: str, action_exit: int) -> None:
    """Append a `cached` event row to the ledger. Wave is NOT incremented —
    cache hits don't count as new iterations. The row carries action_exit so
    downstream detectors (Ε1 failure-streak, Ε2 over-iteration) can treat
    cached + iterated events as one merged evaluation stream."""
    import contract_core  # local import; bash side guarantees PYTHONPATH
    contract_core._append({
        "event": "cached",
        "id": contract_id,
        "source_wave": source_wave,
        "action_exit": action_exit,
        "cache_age_s": round(cache_age_s, 3),
        "cache_key": key,
        "user": user,
        "ts": contract_core._now(),
    })


def cli_lookup(contract_id: str, action: str, stdin_data: str,
               ptype: str) -> None:
    """Bash-callable: prints either `MISS` or `HIT <action_exit> <age_s>` then
    the cached action_result on stdout. Side-effects (touch, record_hit) only
    fire on HIT."""
    if not is_cacheable(ptype):
        print("BYPASS")
        return
    user = resolve_user()
    key = cache_key(contract_id, action, stdin_data, user)
    entry = lookup(key)
    if entry is None:
        # emit the key + user so the caller can write on miss
        print(f"MISS {key} {user}")
        return
    record_hit(contract_id, entry["source_wave"], entry["_age_s"], user, key,
               int(entry["action_exit"]))
    print(f"HIT {entry['action_exit']} {entry['_age_s']} {entry['source_wave']} {key} {user}")
    print(entry["action_result"])


def cli_write(contract_id: str, action: str, stdin_data: str, ptype: str,
              action_exit: int, wave: int, action_result: str) -> None:
    """Bash-callable: writes a cache entry on miss-then-execute path."""
    if not is_cacheable(ptype):
        return
    user = resolve_user()
    key = cache_key(contract_id, action, stdin_data, user)
    write(key, action_exit, action_result, wave, ptype)


if __name__ == "__main__":
    import sys
    op = sys.argv[1] if len(sys.argv) > 1 else ""
    if op == "lookup":
        # args: contract_id action ptype  (stdin = the stdin_data)
        cid, action, ptype = sys.argv[2], sys.argv[3], sys.argv[4]
        stdin_data = sys.stdin.read()
        cli_lookup(cid, action, stdin_data, ptype)
    elif op == "write":
        # args: contract_id action ptype action_exit wave  (stdin = stdin_data + action_result, NUL-separated)
        cid, action, ptype = sys.argv[2], sys.argv[3], sys.argv[4]
        action_exit, wave = int(sys.argv[5]), int(sys.argv[6])
        blob = sys.stdin.read()
        stdin_data, _, action_result = blob.partition("\x00")
        cli_write(cid, action, stdin_data, ptype, action_exit, wave, action_result)
    elif op == "key":
        # args: contract_id action  (stdin = stdin_data)
        # Prints the would-be cache key. For debugging / gate use.
        cid, action = sys.argv[2], sys.argv[3]
        stdin_data = sys.stdin.read()
        print(cache_key(cid, action, stdin_data, resolve_user()))
    else:
        print(f"usage: cache_layer.py {{lookup|write|key}} <args>", file=sys.stderr)
        sys.exit(2)
