# audits/memory-layering

## Rule

Every crystallized memory file separates **title**, **description**, **body**, and **hook** into three distinct non-duplicating layers:

| Layer | Cap | Source |
|---|---|---|
| Title | ≤ 8 words | MEMORY.md link text |
| Description | ≤ 200 chars (one sentence) | frontmatter `description:` |
| Body | full Markdown, structured | the file body |
| Hook (derived) | ≤ 150 chars, ≠ description | MEMORY.md em-dash teaser |

Full rule: see `/contract` SKILL.md → "Audits / memory-layering" + memory `three-layer-memory-doc-org-rule.md`.

## Files

- `verify.sh` — exits 0 if every memory file in `scope.txt`'s corpora passes the layering rule. Non-zero on any violation, with per-file diagnostics. Pure-read.
- `fix.sh` — idempotent. Walks the same corpora, trims over-long descriptions/hooks/titles, indexes orphans in MEMORY.md. Re-running on a green corpus is a no-op. Never touches body content.
- `scope.txt` — newline-separated globs of memory directories the rule applies to.

## Idempotency

Both scripts are idempotent: `verify.sh` is read-only; `fix.sh` only writes when a violation exists. After `fix.sh` runs, `verify.sh` must exit 0.

## How the rule was introduced

Contract organ `767fd41d` (2026-05-23) added the layering rule. Initial backfill via `scripts/backfill-memory-layering.py` covered one project (115 files). The audits convention (this directory, contract `d4074595`) generalises the rule to all 38+ memory directories.
