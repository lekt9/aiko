# audits/references-purge

Enforces Β3 doctrine (contract `9d3f399f`, 2026-05-24): `~/.claude/skills/contract/references/`
holds only `REGISTRY.md` (the doctrine → standing-gate-id + Outline-anchor map) and
optionally `README.md`. Any other `.md` file is the aspirational-prose anti-pattern that Β3
purged — doctrine duplicated across file + standing-gate + Outline with no binding gate.

When a new doctrine wants a reference file: declare its standing-gate contract in the
global ledger, append the narrative to the Outline router doc as an appendix, and add
one row to `REGISTRY.md`. The prose file is the fourth surface no one needs.

`fix.sh` never auto-deletes — the agent decides each file's migration disposition.
