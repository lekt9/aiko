#!/usr/bin/env python3
"""contract-context-of.py — orchestrate on-demand library/topic context.

Lewis 2026-05-24: "/contract should give access to any library full context
of how to use it and rely on bun and nanobrew from justrach to fetch
whatever is relevant at the point of time to execute, /contract should
programmatically establish context via relevant setups including deepwiki
github or even arxiv, but be non binding to those contexts as it could
literally be grabbing context from the chat or the person as part of a
prior /contract dependency that could be reused."

Resolves a topic to a context envelope. Tries pluggable sources in
declared order — any subset can be present, any one fills the cache,
and once cached every subsequent call short-circuits. Sources live as
standalone scripts under scripts/context-sources/<name>.sh so the agent
or user can drop in a new source without touching this orchestrator.

Envelope shape (cached at ~/.contracts/context/<slug>.json):
    {
      "topic":      "<original topic>",
      "slug":       "<topic-slug>",
      "source":     "<which source produced this>",
      "fetched_at": "2026-05-24T...Z",
      "body":       "<context content — README, deepwiki page, paste, etc.>",
      "refs":       ["<url1>", "<url2>", ...]
    }

Sources MUST be non-binding. A missing bun, a missing deepwiki MCP, a
host with no network — any of those just makes that one source skip
quietly; the orchestrator moves to the next.
"""
from __future__ import annotations
import argparse, json, os, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

SOURCES_DIR = Path(__file__).resolve().parent / "context-sources"
CACHE_DIR = Path(os.path.expanduser("~/.contracts/context"))
DEFAULT_ORDER = ["prior", "deepwiki", "bun-fetch", "stdin"]


def slugify(topic: str) -> str:
    s = re.sub(r"[^a-z0-9._/-]+", "-", topic.lower().strip())
    s = re.sub(r"/+", "__", s)
    s = re.sub(r"-+", "-", s).strip("-_.")
    return s or "topic"


def cache_path(slug: str) -> Path:
    return CACHE_DIR / f"{slug}.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def try_source(name: str, topic: str, slug: str, stdin_data: str | None) -> dict | None:
    src = SOURCES_DIR / f"{name}.sh"
    if not src.exists() or not os.access(src, os.X_OK):
        return None
    env = dict(os.environ, CONTEXT_TOPIC=topic, CONTEXT_SLUG=slug)
    try:
        cp = subprocess.run(
            ["bash", str(src), topic],
            input=stdin_data if stdin_data is not None else "",
            text=True, capture_output=True, timeout=60, env=env,
        )
    except subprocess.TimeoutExpired:
        sys.stderr.write(f"  source {name}: timeout (>60s)\n")
        return None
    if cp.returncode != 0:
        return None
    out = cp.stdout.strip()
    if not out:
        return None
    try:
        envelope = json.loads(out)
    except json.JSONDecodeError:
        envelope = {"body": out, "refs": []}
    envelope.setdefault("topic", topic)
    envelope.setdefault("slug", slug)
    envelope["source"] = envelope.get("source") or name
    envelope.setdefault("fetched_at", now_iso())
    envelope.setdefault("refs", [])
    return envelope


def emit_context_needed_block(topic: str, slug: str, tried: list[str]) -> None:
    print()
    print("  === CONTEXT NEEDED ===")
    print(f"  topic:       {topic}")
    print(f"  slug:        {slug}")
    print(f"  sources_tried: {', '.join(tried) if tried else '(none — no source scripts found)'}")
    print()
    print("  No source produced an envelope. Non-binding by design — supply context via any of:")
    print(f"    contract context-of '{topic}' --from-stdin < <paste>")
    print(f"    echo '{{\"body\":\"...\",\"refs\":[]}}' | contract context-of '{topic}' --from-stdin")
    print( "    # or have a prior contract declare --bind-to context:<topic>, then re-iterate")
    print()
    print("  Render this block per transport:")
    print("    Telegram → reply requesting docs paste · Web → modal with textarea")
    print("    Panel    → inline context-paste card · Terminal → user pipes file")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("topic", help="topic / library / repo to fetch context for")
    p.add_argument("--source", default=None, help="force a specific source (default: tries all in order)")
    p.add_argument("--from-stdin", action="store_true", help="read context envelope or body from stdin (the 'stdin' source)")
    p.add_argument("--cache-only", action="store_true", help="only return if cached; never fetch")
    p.add_argument("--refresh", action="store_true", help="bypass cache and refetch")
    p.add_argument("--json", action="store_true", help="emit envelope JSON to stdout (default)")
    p.add_argument("--order", default=None, help="comma-separated source order override")
    args = p.parse_args()

    topic = args.topic.strip()
    if not topic:
        sys.stderr.write("usage: contract context-of <topic> [--source <name>] [--from-stdin] [--cache-only] [--refresh]\n")
        return 2

    slug = slugify(topic)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cf = cache_path(slug)

    # Cache hit — short-circuit unless --refresh
    if cf.exists() and not args.refresh:
        try:
            cached = json.loads(cf.read_text())
            cached["_cache_hit"] = True
            print(json.dumps(cached, indent=2))
            return 0
        except json.JSONDecodeError:
            pass  # fall through; refetch

    if args.cache_only:
        sys.stderr.write(f"  cache miss for slug {slug!r} and --cache-only; no fetch attempted\n")
        return 1

    # Validate forced source if any
    if args.source:
        src_file = SOURCES_DIR / f"{args.source}.sh"
        if not src_file.exists():
            sys.stderr.write(f"  unknown --source {args.source!r}; available: {sorted(p.stem for p in SOURCES_DIR.glob('*.sh'))}\n")
            return 2

    # Decide source order
    if args.source:
        order = [args.source]
    elif args.order:
        order = [s.strip() for s in args.order.split(",") if s.strip()]
    else:
        order = list(DEFAULT_ORDER)

    stdin_data = None
    if args.from_stdin or "stdin" in order:
        if not sys.stdin.isatty():
            stdin_data = sys.stdin.read()

    tried = []
    for name in order:
        if name == "stdin" and not stdin_data:
            continue  # nothing to feed; skip silently
        envelope = try_source(name, topic, slug, stdin_data)
        tried.append(name)
        if envelope is None:
            continue
        # Cache the winner
        try:
            cf.write_text(json.dumps(envelope, indent=2))
        except OSError as e:
            sys.stderr.write(f"  warning: could not cache envelope: {e}\n")
        envelope["_cache_hit"] = False
        print(json.dumps(envelope, indent=2))
        return 0

    # All sources tried, none answered
    emit_context_needed_block(topic, slug, tried)
    return 1


if __name__ == "__main__":
    sys.exit(main())
