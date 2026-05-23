#!/usr/bin/env python3
"""
check-memory-layering.py — audit memory files against the three-layer rule
(contract 767fd41d).

Usage:
  check-memory-layering.py <memory-dir> [--only file1.md,file2.md]

Walks <memory-dir>, reads each *.md (except MEMORY.md), parses frontmatter,
and runs the same _enforce_layering check the crystallizer applies on write.
Reports every violation and exits non-zero if any are found.

Exit 0 — all checked files pass.
Exit 1 — at least one violation.
"""
from __future__ import annotations
import importlib.util, sys, re, os
from pathlib import Path

_CC_PATH = "/Users/lekt9/.claude/skills/contract/scripts/contract-crystallize.py"
_spec = importlib.util.spec_from_file_location("cc", _CC_PATH)
_cc = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_cc)


def parse_memory(path: Path):
    """Return {title, description, body, hook?}. Title is derived from
    `name:` frontmatter (the slug, humanized). Hook is unknown from the
    file alone — checked separately against the MEMORY.md index entry."""
    text = path.read_text()
    m = re.match(r"^---\n(.*?)\n---\n+(.*)$", text, re.S)
    if not m:
        return None
    front, body = m.group(1), m.group(2)
    name_m = re.search(r"^name:\s*(.+)$", front, re.M)
    desc_m = re.search(r"^description:\s*(.+)$", front, re.M)
    name = _unquote(name_m.group(1).strip()) if name_m else path.stem
    desc = _unquote(desc_m.group(1).strip()) if desc_m else ""
    # Title — derived from the slug. Memories don't store a separate title
    # field; the MEMORY.md link text is the "title" surface. We probe THAT
    # below via index_hooks().
    return {"name": name, "description": desc, "body": body.strip()}


def index_entries(memory_dir: Path):
    """Read MEMORY.md and return {filename: (title, hook)} for every entry."""
    idx = memory_dir / "MEMORY.md"
    out = {}
    if not idx.exists():
        return out
    pat = re.compile(r"^- \[([^\]]+)\]\(([^)]+\.md)\)\s+[—-]\s+(.+)$")
    for line in idx.read_text().splitlines():
        m = pat.match(line.strip())
        if not m:
            continue
        out[m.group(2)] = (m.group(1).strip(), m.group(3).strip())
    return out


def audit(memory_dir: Path, only: set[str] | None) -> int:
    files = sorted(p for p in memory_dir.iterdir()
                   if p.is_file() and p.suffix == ".md" and p.name != "MEMORY.md")
    if only:
        files = [p for p in files if p.name in only]
    if not files:
        print(f"no memory files to audit under {memory_dir}", file=sys.stderr)
        return 0
    idx = index_entries(memory_dir)
    bad = 0
    for p in files:
        parsed = parse_memory(p)
        if not parsed:
            print(f"FAIL {p.name}: unparseable (no frontmatter)")
            bad += 1
            continue
        title, hook = idx.get(p.name, (None, None))
        if not title:
            # Synthesize a probe title from the slug — this is what the
            # MEMORY.md line WOULD show if it existed. The lack of an
            # index entry IS a violation in its own right.
            print(f"FAIL {p.name}: no MEMORY.md index entry")
            bad += 1
            continue
        try:
            _cc._enforce_layering(title, parsed["description"],
                                  parsed["body"], hook or "")
        except ValueError as e:
            print(f"FAIL {p.name}: {e}")
            bad += 1
            continue
        # Extra: the slug shouldn't be a verbatim chunk of the description
        # (the old "name = first 70 chars of desc" smell)
        slug_phrase = parsed["name"].replace("-", " ").lower()
        if slug_phrase and slug_phrase[:30] in parsed["description"].lower()[:60]:
            # Only fire when desc clearly starts with the slug-derived prefix
            # AND the slug is long (>= 6 words) — the lazy-default smell.
            if len(parsed["name"].split("-")) >= 6:
                print(f"FAIL {p.name}: slug looks like a truncated description "
                      f"(slug={parsed['name'][:60]!r})")
                bad += 1
                continue
        print(f"OK   {p.name}")
    if bad:
        print(f"\n{bad} violation(s) in {len(files)} file(s)", file=sys.stderr)
        return 1
    print(f"\nall {len(files)} memory files pass the three-layer rule")
    return 0


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("memory_dir")
    p.add_argument("--only", default="",
                   help="comma-separated filenames to limit the audit to")
    args = p.parse_args()
    only = {x.strip() for x in args.only.split(",") if x.strip()} or None
    return audit(Path(args.memory_dir), only)


if __name__ == "__main__":
    sys.exit(main())
