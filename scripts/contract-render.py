#!/usr/bin/env python3
"""contract-render.py — universal renderer dispatch for substrate stdio.

Lewis 2026-05-24: "this post tool /contract that we wire in could be the
/contract interface to stdout from — whether its /contract from the merjs
ui or the aiko notch generative ui /contract that we will build or
/contract ing humanisation in a video or /contract ing like a video
message on telegram via /contract after passing through curve
humanisation for /contract — figure shit out thanks"

The substrate's stdout is already universal. context-of (knowledge in),
next-of (resolution out), iterate/status/mark (state), Φ1 OpenAI render
(API translator). This verb is the SURFACE side: same substrate stdio,
N rendering surfaces, swappable plug-ins.

Pipeline:
    contract iterate <id> | contract render <id> --surface <name> [--humanize]

Or with --from-stdin:
    cat any-substrate-output | contract render <id> --surface <name> --from-stdin

Resolution:
  --surface <name> looks up scripts/renderers/<name>.{sh,py}
  --humanize pipes through scripts/humanize.py first
  --to <file> writes to file instead of stdout
  --hint   forces HINT-envelope mode for renderers backed by external
            services (e.g. video-message, tg-video) — useful when the
            service isn't configured on this host
"""
from __future__ import annotations
import argparse, os, subprocess, sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent
RENDERERS_DIR = SKILL / "renderers"
HUMANIZER = SKILL / "humanize.py"
DEFAULT_SURFACE = "stdout"
LIB = SKILL / "lib"
sys.path.insert(0, str(LIB))


def resolve_renderer(name: str) -> Path | None:
    for ext in (".sh", ".py"):
        candidate = RENDERERS_DIR / f"{name}{ext}"
        if candidate.exists() and os.access(candidate, os.X_OK):
            return candidate
    return None


def fetch_substrate_stdio(cid: str) -> str:
    """When stdin is empty, default to 'contract iterate <id>' output."""
    cli = str(SKILL / "contract")
    try:
        cp = subprocess.run(
            ["bash", cli, "iterate", cid],
            text=True, capture_output=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return ""
    return cp.stdout or cp.stderr or ""


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("id", nargs="?", default="", help="contract id (optional with --from-stdin)")
    p.add_argument("--surface", default=DEFAULT_SURFACE)
    p.add_argument("--humanize", action="store_true",
                   help="pipe through scripts/humanize.py before the renderer")
    p.add_argument("--hint", action="store_true",
                   help="ask renderers backed by external services to emit a HINT envelope")
    p.add_argument("--from-stdin", action="store_true",
                   help="read substrate stdio from stdin instead of running iterate")
    p.add_argument("--to", default=None, help="write to file instead of stdout")
    args = p.parse_args()

    if not args.from_stdin and not args.id:
        sys.stderr.write("usage: contract render <id> [--surface <name>] [--humanize] [--from-stdin]\n")
        return 2

    renderer = resolve_renderer(args.surface)
    if renderer is None:
        avail = sorted({p.stem for p in RENDERERS_DIR.glob("*") if p.is_file()})
        sys.stderr.write(f"unknown --surface {args.surface!r}; available: {avail}\n")
        return 2

    # Step 1 — gather raw substrate stdio
    if args.from_stdin and not sys.stdin.isatty():
        raw = sys.stdin.read()
    elif args.id:
        raw = fetch_substrate_stdio(args.id)
    else:
        raw = ""

    if not raw:
        sys.stderr.write("contract render: no substrate stdio to render (empty stdin and no iterate output)\n")
        return 1

    # Step 2 — optional humanize pass. Honest semantics: when humanize
    # succeeds (exit 0), its output replaces raw even if empty (i.e. all
    # input was substrate jargon that should be stripped). Only on
    # non-zero exit do we fall back to raw input.
    if args.humanize and HUMANIZER.exists():
        try:
            cp = subprocess.run(
                ["python3", str(HUMANIZER)],
                input=raw, text=True, capture_output=True, timeout=15,
            )
            if cp.returncode == 0:
                raw = cp.stdout
        except subprocess.TimeoutExpired:
            sys.stderr.write("humanize: timeout — using raw input\n")
    if not raw.strip():
        # Humanize stripped everything → all input was substrate jargon.
        # Emit a minimal aiko-voice placeholder so renderers have something.
        raw = "(I'm working on it. Nothing to show yet.)\n"

    # Step 3 — render
    env = dict(os.environ,
               CONTEXT_CONTRACT_ID=args.id or "",
               CONTEXT_HINT_MODE="1" if args.hint else "0",
               CONTEXT_SURFACE=args.surface)
    runner = ["bash", str(renderer)] if renderer.suffix == ".sh" else ["python3", str(renderer)]
    try:
        cp = subprocess.run(runner, input=raw, text=True, capture_output=True,
                            timeout=60, env=env)
    except subprocess.TimeoutExpired:
        sys.stderr.write(f"renderer {args.surface}: timeout\n")
        return 1
    out = cp.stdout
    if cp.returncode != 0:
        sys.stderr.write(f"renderer {args.surface} exited {cp.returncode}: {cp.stderr.strip()[:200]}\n")
        return 1
    if not out:
        sys.stderr.write(f"renderer {args.surface} emitted no output\n")
        return 1

    if args.to:
        try:
            Path(args.to).write_text(out)
        except OSError as e:
            sys.stderr.write(f"write {args.to}: {e}\n")
            return 1
    else:
        sys.stdout.write(out)
        if not out.endswith("\n"):
            sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
