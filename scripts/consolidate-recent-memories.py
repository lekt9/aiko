#!/usr/bin/env python3
"""
One-shot: consolidate + rewrite the 6 memories I created in the last two
turns into 4 properly-layered files. The 3 `cbb2a1d3`-organ
crystallize-learnings dupes merge into one canonical doc.

Idempotent: each new memory has a fixed slug; if the file already exists
we skip and the run is a no-op. The audit cell verifies the result.
"""
from __future__ import annotations
import importlib.util, sys, re
from pathlib import Path

MEM = Path("/Users/lekt9/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/memory")
assert MEM.is_dir(), MEM

_spec = importlib.util.spec_from_file_location(
    "cc", "/Users/lekt9/.claude/skills/contract/scripts/contract-crystallize.py")
cc = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(cc)


# (old_files_to_delete, new_slug, type, title, description, body, hook)
PLAN = [
    # 1. graff bot
    (["a-graff-driven-telegram-bot-called-through-cloudflare-pages.md"],
     "graff-bot-cf-pages-30s-budget",
     "reference",
     "Graff Telegram bot — 30s Cloudflare turn budget",
     "Cloudflare Pages workers kill the script when a graff turn exceeds ~30s, so the bot's sendMessage never fires; pin a fast Nebius MoE and disable reasoning.",
     ("Cloudflare Pages' `ctx.waitUntil` terminates the worker before "
      "`sendMessage` can fire when a single graff turn runs longer than "
      "~30 seconds. The bot drops the reply silently — no glitch text, "
      "`pending_update_count` stays at 0, but the brain log shows /think "
      "entries proving the model WAS called.\n\n"
      "**Why:** the worker dies between the model returning and the bot "
      "sending — there is no error to log because the runtime itself was "
      "killed. Symptom is invisible without inspecting the brain side.\n\n"
      "**How to apply:** pin a fast Nebius MoE such as "
      "`Qwen/Qwen3-30B-A3B-Instruct-2507` and set `[reasoning] enabled=false` "
      "in `~/forge/.forge.toml`. The fix lives in "
      "`bot-tools/graff-brain/deploy-tencent.sh`.\n\n"
      "_Source:_ `bot-tools/graff-brain/deploy-tencent.sh`"),
     "Cloudflare Pages worker kills sendMessage after ~30s; pin a fast Nebius MoE and disable reasoning."),

    # 2. doc-edit format preservation
    (["doc-edit-format-preservation-pattern-1-before-any-google-doc.md"],
     "doc-edit-format-preservation",
     "feedback",
     "Doc-edit preserves source format inventory",
     "Every Google-Doc or .docx edit captures the source's bold/italic/alignment/bullet inventory and verifies the post-edit inventory is ≥ source on every non-zero dimension.",
     ("Plain-text `deleteContentRange + insertText` batchUpdate on a "
      "Google Doc — or unpack-and-rewrite on a `.docx` — strips all bold, "
      "italic, alignment, and bullet structure. The agent must capture "
      "the source's format inventory BEFORE the edit and verify the "
      "post-edit inventory matches or exceeds it on every non-zero "
      "dimension AFTER.\n\n"
      "**Why:** on 2026-05-23 a SAFE-to-convertible-note rewrite reduced "
      "Doc 2 from 68 bold runs / 8 bullets / 67 JUSTIFIED paragraphs to "
      "zero of each — visible only when the agent re-ran the fidelity "
      "diff. Lewis caught it before the doc was sent.\n\n"
      "**How to apply:** for `.docx` use `anthropics/skills@docx` "
      "(unpack → edit `word/document.xml` → repack). For native Google "
      "Docs use structural `batchUpdate` with `updateTextStyle` + "
      "`updateParagraphStyle` + `createParagraphBullets`. Run the "
      "fidelity diff (`.safe-sync/format-inventory.py diff source.json "
      "edited.json`) afterwards — exit non-zero on any reduction.\n\n"
      "_Contract:_ `1283fd8f` (satisfied)"),
     "Plain-text batchUpdate strips bold/alignment/bullets; capture inventory before, verify ≥ source after."),

    # 3. CONSOLIDATED — three cbb2a1d3 dupes → one canonical doc
    (["the-contract-skill-crystallizes-learnings-a-contract-declare.md",
      "the-contract-skill-crystallizes-learnings-into-a-memory-file.md",
      "the-contract-skill-now-crystallizes-learnings-a-contract-dec.md"],
     "contract-skill-crystallize-learnings",
     "reference",
     "Crystallize emits memory file + Outline doc",
     "A satisfied --learning contract (or `contract learn`) emits a memory file plus an Outline doc via the crystallize-learning hook; one `crystallized` ledger row is the idempotency key.",
     ("The `/contract` skill turns a learning into durable knowledge on "
      "two surfaces beyond the ledger: a memory file in the project's "
      "Claude Code memory folder (see [[contract-crystallize-memory-location]]), "
      "and an Outline document in the `Contracts` collection at "
      "`docs.getfoundry.app`. The two surfaces are independent — a memory "
      "write never depends on Outline reachability and vice versa.\n\n"
      "**Why:** the ledger is internal substrate; memory and Outline are "
      "the reachable knowledge surfaces. Both are best-effort: missing "
      "Outline config skips the doc cleanly, never blocks the memory.\n\n"
      "**How to apply:** declare with `--learning \"<insight>\"` for "
      "auto-crystallization on `_mark satisfied`, OR call "
      "`contract learn \"<text>\" [--source <ref>]` on demand. The "
      "`crystallize-learning` hook fires on the contract's internal "
      "hook bus; idempotency is enforced by a single `crystallized` "
      "ledger row per contract.\n\n"
      "**Gotcha:** the Cloudflare edge in front of the self-hosted Outline "
      "403s the default Python-urllib User-Agent — the client must send "
      "a custom UA. Already fixed in `contract-crystallize.py`.\n\n"
      "_Contract organ:_ `cbb2a1d3` (satisfied); supersedes 3 prior dupes."),
     "Crystallize-learning hook + `contract learn` verb emit a memory file and an Outline doc; one `crystallized` row is the idempotency key."),

    # 4. WHERE crystallized learnings live
    (["where-crystallized-learnings-live-claude-projects-slug-memor.md"],
     "contract-crystallize-memory-location",
     "feedback",
     "Crystallized memories live under ~/.claude",
     "Crystallized memories land in ~/.claude/projects/<slug>/memory/ (project) or ~/.claude/memory/ (global fallback) — never ~/.contracts/, which is reserved for the literal contract ledger.",
     ("Crystallized learnings live in the Claude Code memory tree under "
      "`~/.claude/`. The `~/.contracts/` path is reserved for the literal "
      "contract ledger and MUST NOT receive memory files.\n\n"
      "Resolution order (longest-prefix wins): walk UP from the contract's "
      "`cwd` and try each ancestor as a slug under "
      "`~/.claude/projects/<slug>/memory/`. First existing directory wins. "
      "If none exist, fall back to `~/.claude/memory/` (global). The old "
      "`~/.contracts/learnings/` fallback is removed.\n\n"
      "**Why:** the previous resolver only tried the exact cwd's slug, so "
      "a child directory (like `unbrowse/frontend`) never matched the "
      "parent project's memory folder (`unbrowse`) and silently dumped "
      "five learnings into `~/.contracts/learnings/`.\n\n"
      "**How to apply:** call `cc.resolve_memory_dir(scope_cwd)` from any "
      "crystallizer. The 5 misplaced files were migrated by "
      "`scripts/contract-backfill-learnings.py`; the fallback dir is now "
      "empty.\n\n"
      "_Contract organ:_ `5721fa50` (satisfied)\n"
      "_Related:_ [[contract-skill-crystallize-learnings]]"),
     "Memories under ~/.claude/projects/<slug>/memory/ (longest-prefix walk) or ~/.claude/memory/ as fallback — never ~/.contracts/."),
]


def remove_index_lines(filenames):
    """Strip MEMORY.md lines that link to any of the given filenames."""
    idx = MEM / "MEMORY.md"
    if not idx.exists():
        return 0
    lines = idx.read_text().splitlines()
    targets = set(filenames)
    kept = [l for l in lines
            if not any(f"]({fn})" in l for fn in targets)]
    if len(kept) != len(lines):
        idx.write_text("\n".join(kept) + ("\n" if kept else ""))
    return len(lines) - len(kept)


def main():
    rewrites = 0
    for old_files, slug, mtype, title, description, body, hook in PLAN:
        target = MEM / f"{slug}.md"
        if target.exists():
            print(f"skip (already canonical): {slug}.md")
            continue
        # Delete old files first so MEMORY.md cleanup is consistent.
        deleted = []
        for old in old_files:
            p = MEM / old
            if p.exists():
                p.unlink()
                deleted.append(old)
        if deleted:
            n = remove_index_lines(deleted)
            print(f"  removed {len(deleted)} old file(s), {n} index line(s): {deleted[0]}…")
        # Write the new canonical memory (write_memory enforces layering).
        try:
            cc.write_memory(MEM, slug, description, body,
                            memory_type=mtype, title=title, hook=hook)
            print(f"WROTE  {slug}.md  [type={mtype}]")
            rewrites += 1
        except ValueError as e:
            print(f"LAYERING REJECTED {slug}.md: {e}", file=sys.stderr)
            return 1
    print(f"\nrewrote {rewrites} memory file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
