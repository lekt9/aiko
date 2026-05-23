#!/usr/bin/env python3
"""
One-shot migrator: move misplaced learnings from ~/.contracts/learnings/
into the canonical project memory folder, rewrite them in the house
format (via contract-crystallize.write_memory), then remove the source
files + the fallback MEMORY.md.

Idempotent: running again is a no-op once the source dir is empty.

We do NOT call crystallize.from_contract — that re-fires the hooks and
mutates the ledger. The contracts these files came from are already
marked crystallized; we just need their bodies moved.
"""
import importlib.util, sys, re, os
from pathlib import Path

FALLBACK = Path.home() / ".contracts" / "learnings"
TARGET = Path("/Users/lekt9/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/memory")
assert TARGET.is_dir(), f"target memory dir missing: {TARGET}"

spec = importlib.util.spec_from_file_location(
    "cc", "/Users/lekt9/.claude/skills/contract/scripts/contract-crystallize.py")
cc = importlib.util.module_from_spec(spec); spec.loader.exec_module(cc)


def parse_old_memory(path: Path):
    """Return (description, original_learning_text, source_pointer)."""
    text = path.read_text()
    # Frontmatter description
    m = re.search(r"^description:\s*(.+)$", text, re.M)
    desc = m.group(1).strip() if m else path.stem
    # The learning text in the body
    body_match = re.search(r"^\*\*Learning:\*\*\s*(.+?)(?:\n\n|\Z)",
                           text, re.S | re.M)
    learning = body_match.group(1).strip() if body_match else desc
    # Source / event provenance (best-effort)
    src_match = re.search(r"^\*\*Source:\*\*\s*(.+)$", text, re.M)
    source = src_match.group(1).strip() if src_match else None
    return desc, learning, source


def migrate():
    if not FALLBACK.exists():
        print(f"no fallback dir at {FALLBACK} — nothing to do")
        return 0
    files = sorted(p for p in FALLBACK.iterdir()
                   if p.is_file() and p.name != "MEMORY.md")
    if not files:
        # Already empty — still clean up MEMORY.md if it lingers
        if (FALLBACK / "MEMORY.md").exists():
            (FALLBACK / "MEMORY.md").unlink()
            print(f"removed empty {FALLBACK}/MEMORY.md")
        return 0
    moved = []
    for src in files:
        desc, learning, source = parse_old_memory(src)
        # Skip if a memory with this slug already lives in the target
        if (TARGET / src.name).exists():
            print(f"skip (already in target): {src.name}")
            src.unlink()
            continue
        body = cc._compose_body(learning, source=source)
        mtype = cc._infer_memory_type(learning, source)
        hook = cc._hook_from_learning(learning)
        title = cc._oneline(learning)[:70].rstrip()
        # Reuse the source's slug (it's already a slug) so the existing
        # ledger crystallized-row's memory_path stays a valid reference.
        base = src.stem
        new_path = cc.write_memory(TARGET, base, desc, body,
                                   memory_type=mtype, title=title, hook=hook)
        src.unlink()
        moved.append((src.name, new_path.name, mtype))
        print(f"migrated  {src.name}  ->  {new_path}  [type={mtype}]")
    # Drop the now-orphan MEMORY.md
    fb_index = FALLBACK / "MEMORY.md"
    if fb_index.exists():
        fb_index.unlink()
        print(f"removed   {fb_index}")
    print(f"\nmigrated {len(moved)} files; fallback dir now empty")
    return 0


if __name__ == "__main__":
    sys.exit(migrate())
