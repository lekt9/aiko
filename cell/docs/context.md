# Context — what agents see, when

> Apply harness-engineering §02: progressive disclosure. AGENTS.md is the table of contents, not the book.

## Layers

1. **Always visible** (~30 lines) — `AGENTS.md`: name, one primitive, 3 commands, 5 rules, where to look.
2. **On demand** — `docs/` and `SPEC.md`: architecture, harness, constraints, leaves, primitives.
3. **Just in time** — `system/neurons/*.py` comments + `schemas/*.v1.json` + `example/*.cell.yaml`: leaf semantics, port schemas.

## Anti-patterns we avoid

- Dumping SPEC into AGENTS.md (bloat -> agent skims).
- No AGENTS.md (agent guesses).
- Stale AGENTS.md that contradicts SPEC.md (worse than none).

## Maps, not manuals

Bad: "open `run.py` line 240, change X." Good: "builder is `system/builder.cell.yaml` (parse | validate | emit); runtime is `run.py` (topo sort + fire leaves); primitives are `primitives/session|auth|request`."

## Cross-session memory

What survives: files on disk (`AGENTS.md`, `docs/`, `system/*.cell.yaml`, `primitives/`, `skills/`, git history). What doesn't: chat history. Rule: if a decision matters, write it to a file.
