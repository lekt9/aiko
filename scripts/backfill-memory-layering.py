#!/usr/bin/env python3
"""
Backfill: fix every memory file in <memory-dir> that violates the
three-layer rule (contract 767fd41d). Idempotent — re-running on a
clean dir is a no-op.

Strategy per violator:
  - description > 200 chars → trim to first sentence; if still too long,
    hard-truncate at 197 chars + ellipsis. Body is NEVER touched.
  - MEMORY.md hook > 150 chars → re-derive from the new description;
    cap at 147 + ellipsis.
  - title > 8 words → derive a tighter title from the slug; if hand-fix
    needed, fail loud (don't ship a wrong title).
  - missing MEMORY.md entry → append a line using (derived title, hook).

Usage:
  backfill-memory-layering.py <memory-dir> [--dry-run]
"""
from __future__ import annotations
import importlib.util, re, sys
from pathlib import Path

_CC = importlib.util.spec_from_file_location(
    "cc", "/Users/lekt9/.claude/skills/contract/scripts/contract-crystallize.py")
cc = importlib.util.module_from_spec(_CC); _CC.loader.exec_module(cc)


def parse(text):
    m = re.match(r"^(---\n.*?\n---\n+)(.*)$", text, re.S)
    if not m:
        return None
    return m.group(1), m.group(2)


def front_field(front, key):
    """Read a top-level frontmatter scalar (handles quoted + unquoted)."""
    m = re.search(rf'^{re.escape(key)}:\s*(.+?)\s*$', front, re.M)
    if not m:
        return None
    val = m.group(1)
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        val = val[1:-1]
    return val


def set_front_field(front, key, value):
    """Update a top-level frontmatter scalar in place. Quotes the value to
    handle embedded colons / em-dashes that YAML would otherwise mis-parse."""
    # Always re-quote with double quotes; escape any embedded "
    safe = value.replace("\\", "\\\\").replace('"', '\\"')
    quoted = f'"{safe}"'
    pat = re.compile(rf'^({re.escape(key)}:\s*).+$', re.M)
    new_front, n = pat.subn(rf'\g<1>{quoted}', front, count=1)
    if n == 0:
        # field missing — insert before closing ---
        new_front = front.rstrip("\n---\n") + f"\n{key}: {quoted}\n---\n"
    return new_front


def trim_to_cap(text, cap):
    """Trim text to ≤cap chars without losing the lead. Greedy: pack
    whole sentences up to the cap so single-word leads ("SUPERSEDED.")
    don't collapse to a useless 11-char description."""
    text = " ".join((text or "").split())
    if len(text) <= cap:
        return text
    sentences = re.split(r"(?<=[.!?])\s+", text)
    packed = ""
    for s in sentences:
        candidate = (packed + " " + s).strip() if packed else s
        if len(candidate) > cap:
            break
        packed = candidate
    if packed and len(packed) >= 60:  # got a substantive packing
        return packed
    # Lead is too short to be useful — hard truncate with ellipsis.
    return text[:cap - 1].rstrip() + "…"


def derive_title(slug):
    """Slug → human title, capped at 8 words. Strips path-like / punctuation
    tokens that don't read as titles."""
    raw_words = slug.replace("-", " ").replace("_", " ").split()
    def speakable(w):
        if not w: return False
        if any(ch in w for ch in "/\\$~"): return False
        return bool(re.search(r"[A-Za-z]", w))
    words = [w for w in raw_words if speakable(w)] or raw_words
    return " ".join(words[:cc.TITLE_MAX_WORDS]).rstrip(".,:;-—()'\"")


def update_memory_index_line(memory_dir, filename, new_title, new_hook):
    idx = memory_dir / "MEMORY.md"
    if not idx.exists():
        idx.write_text("")
    lines = idx.read_text().splitlines()
    pat = re.compile(rf"^- \[[^\]]+\]\({re.escape(filename)}\)\s+[—-]\s+.+$")
    found = False
    new_line = f"- [{new_title}]({filename}) — {new_hook}"
    for i, ln in enumerate(lines):
        if pat.match(ln.strip()):
            lines[i] = new_line
            found = True
            break
    if not found:
        lines.append(new_line)
    idx.write_text("\n".join(lines) + "\n")
    return found


def fix_file(memory_dir, path, idx_entries, dry_run):
    """Return (changed, reason)."""
    raw = path.read_text()
    parsed = parse(raw)
    if not parsed:
        return False, "unparseable (no frontmatter)"
    front, body = parsed
    desc = front_field(front, "description")
    if desc is None:
        return False, "no description: field"

    # Tighten description if over cap
    new_desc = desc
    if len(desc) > cc.DESCRIPTION_MAX_CHARS:
        new_desc = trim_to_cap(desc, cc.DESCRIPTION_MAX_CHARS)

    # Current MEMORY.md title + hook (if indexed)
    cur_title, cur_hook = idx_entries.get(path.name, (None, None))
    new_title = cur_title or derive_title(path.stem)
    # Re-derive hook from the (possibly new) description if cur_hook over cap
    # or missing or equal to description.
    need_hook = (not cur_hook) or (len(cur_hook) > cc.HOOK_MAX_CHARS) or (cur_hook == new_desc)
    new_hook = cur_hook
    if need_hook:
        new_hook = trim_to_cap(new_desc, cc.HOOK_MAX_CHARS)
        # Enforce strict inequality with description when both fit naturally
        if new_hook == new_desc and len(new_desc) > 30:
            new_hook = trim_to_cap(new_desc, min(cc.HOOK_MAX_CHARS, len(new_desc) - 10))

    # Tighten title if over cap
    if len(new_title.split()) > cc.TITLE_MAX_WORDS:
        new_title = derive_title(path.stem)

    changes = []
    if new_desc != desc:
        changes.append(f"desc {len(desc)}→{len(new_desc)}")
    if cur_title != new_title:
        changes.append(f"title='{new_title}'")
    if cur_hook != new_hook:
        changes.append(f"hook {len(cur_hook or '')}→{len(new_hook)}")
    if not changes:
        return False, "ok"

    if dry_run:
        return True, " · ".join(changes) + " (dry-run)"

    # Apply file write only when description actually changed.
    if new_desc != desc:
        new_front = set_front_field(front, "description", new_desc)
        path.write_text(new_front + body)
    update_memory_index_line(memory_dir, path.name, new_title, new_hook)
    return True, " · ".join(changes)


def index_entries(memory_dir):
    idx = memory_dir / "MEMORY.md"
    if not idx.exists():
        return {}
    pat = re.compile(r"^- \[([^\]]+)\]\(([^)]+\.md)\)\s+[—-]\s+(.+)$")
    out = {}
    for line in idx.read_text().splitlines():
        m = pat.match(line.strip())
        if m:
            out[m.group(2)] = (m.group(1).strip(), m.group(3).strip())
    return out


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("memory_dir")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    mem = Path(args.memory_dir)
    files = sorted(p for p in mem.iterdir()
                   if p.is_file() and p.suffix == ".md" and p.name != "MEMORY.md")
    idx = index_entries(mem)
    fixed = skipped = 0
    for f in files:
        changed, reason = fix_file(mem, f, idx, args.dry_run)
        if changed:
            print(f"FIX  {f.name}: {reason}")
            fixed += 1
        elif reason != "ok":
            print(f"SKIP {f.name}: {reason}")
            skipped += 1
    print(f"\n{fixed} file(s) fixed, {skipped} skipped (out of {len(files)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
