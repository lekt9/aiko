# Harness — how this repo follows harness-engineering

> Harness = operating system for agents. Model is CPU, context is RAM, harness is OS. Start simple, add only when needed, build for deletion.

This file maps that doctrine onto `cell`.

## Layers (what this repo has)

| Layer | In this repo | Notes |
|---|---|---|
| Project setup | `AGENTS.md` (router) + `docs/` (system of record) | AGENTS points, docs holds — 50–200 lines vs focused docs |
| Context | Progressive disclosure: AGENTS -> docs/ -> SPEC.md -> system/neurons/DESIGN_NOTES | See `docs/context.md` |
| Constraints | Schema validation, DAG cycle refusal, caps allowlist | See `docs/constraints.md` |
| Eval & feedback | `python run.py check` + `tests/` + fixture-driven cases | See `tests/README.md` |
| Primitives | `primitives/session·auth·request·cas` (frozen membranes) | `primitives/README.md` + `patterns/api-reveng/` + `out/manifest.json` (merkle) |
| Patterns | `patterns/prompt·context·loop·graph` (examples, not spec) | `patterns/README.md` + `SPEC.md §6` |
| Loop | `patterns/loop-cell/` — `python` loop inside a leaf (no spec syntax) | Bounded `for` in `neurons/iterate.py` |
| Graph | `wiring:` + typed `schemas/` + `reduce`/`router`/`approval` | `patterns/graph-cell/` |
| Long-running | `run.py` fires in topo order, work dirs per leaf | Caps + DAG give handoff |
| Evidence | `patterns/confirm/` (encouraged confirmation cell) | `patterns/api-reveng/confirm.cell.yaml` |
| Redrive | `system/redrive.cell.yaml` (organelle, not spec) | manifests + prior -> stale vs ALREADY_SENT |
| Memory | Git history + distilled `skills/` (shared cells) + `.cell-cas/` (CAS) | Skills amortize exploration |

## How we apply the workflow

1. **Assess** — python-native DAG that composes programs (exec/python/http) + fixed primitives (session/auth/request), fractal, minimal.
2. **Setup** — `AGENTS.md` + `docs/` + `primitives/` + `patterns/` + `system/` + `example/` + `schemas/` + `skills/`.
3. **Context** — see `docs/context.md`.
4. **Constraints** — see `docs/constraints.md`.
5. **Eval** — `python run.py check <root> --inputs <json>` is the gate. Add a gate per mistake.
