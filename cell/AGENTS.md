# AGENTS.md — cell

> Fractal harness. One primitive: `Cell = membrane + (run | organelles+wiring)`. Python-native.

## Quick start

```sh
python run.py build example/pipeline.cell.yaml
python run.py run   example/pipeline.cell.yaml --inputs example/inputs.json --out out/
python run.py check example/pipeline.cell.yaml --inputs example/inputs.json
```

## Architecture

Single primitive: a leaf `run` (one of `exec` · `python` · `http`) and a composite `organelles + wiring` share the same `membrane` (`inputs`/`outputs`/`caps`). Any Cell can be an organelle in another Cell — fractal by construction. See `docs/architecture.md`.

Execution is a DAG in YAML that composes programs: `build` delegates to `system/builder.cell.yaml` (parse | validate | emit), `run` topologically sorts and fires leaves, `check` adds schema + determinism validation. Fail-closed on first violated port or cap.

## Directory

```
cell/
  SPEC.md          normative standard (read before writing a cell)
  SKILL.md         agent skill — how to act, leaf recipes, helpers + primitives + merkle/confirm
  primitives/      fixed cells: session -> auth -> request (frozen membranes, HMAC/OAuth in request.py)
  patterns/        prompt/context/loop/graph + api-reveng demo of primitives
  system/          builder that builds itself (builder.cell.yaml = parse|validate|emit)
  run.py           canonical runtime — DAG -> topo sort -> fire leaves
  helpers.py       thin editable helpers (~150 lines) — agent may extend
  src/main.zig     Zig is only the runtime — validates DAG, no compiler logic
  example/         hello (python inline) + pipeline (exec->python) + echo-http
  schemas/         JSON Schemas for membrane ports
  skills/          distilled cells — shared, amortized exploration
  docs/            system of record — architecture, harness, context, constraints, skills
  out/manifest.json  per-firing merkle (cell + input/output digests, evidence, produced_by)
```

## Key conventions

1. One primitive only. New concept? Make it an organelle (a Cell), not a new top-level kind.
2. Three leaf kinds share one membrane: `exec` · `python` · `http`. Pick the thinnest that works.
3. Fixed primitives are frozen membranes (`session`/`auth`/`request`) — compose them, don't wrap.
4. Helpers are thin and editable — missing helper -> edit `helpers.py`, add one function, rerun.
5. Determinism on the path (`required`); models at edges (`best_effort`). DAG only, cycles refused at `build`.

## Documentation map

| Topic | File |
|---|---|
| YAML shape, membrane, wiring, determinism | `SPEC.md` |
| How to write a leaf, compose, extend helpers | `SKILL.md` |
| Fixed primitives (session/auth/request) | `primitives/README.md` + `SPEC.md §5` |
| Architecture + directory | `docs/architecture.md` |
| Harness layers map | `docs/harness.md` |
| What agents see, when (progressive disclosure) | `docs/context.md` |
| Enforced guardrails + one-rule-per-mistake | `docs/constraints.md` |
| Skills lifecycle (distill, vote, PII gate) | `docs/skills.md` |
| Native patterns (prompt/context/loop/graph) | `patterns/<name>-cell/` + `SPEC.md §6` |
| Builder internals | `system/builder.cell.yaml` + `system/neurons/` |
| Runtime | `run.py` + `helpers.py` |

## Common tasks

| Task | Files |
|---|---|
| Write a new cell | `SPEC.md` + `example/*.cell.yaml` |
| Add a leaf (exec/python/http) | `SKILL.md` Writing a leaf + `helpers.py` |
| Wire a composite (incl. session->auth->request) | `SPEC.md §5` + `patterns/api-reveng/api-reveng.cell.yaml` |
| Wire a DAG | `SPEC.md §2.3` + `example/pipeline.cell.yaml` |
| Debug a firing | `docs/constraints.md` + `python run.py check` |
| Extend helpers / add HMAC/OAuth | `helpers.py` or `primitives/neurons/request.py` (keep thin) |
| Try a native pattern | `patterns/README.md` + `patterns/*-cell/*.cell.yaml` |
| Distill a skill | `docs/skills.md` + `skills/README.md` |
