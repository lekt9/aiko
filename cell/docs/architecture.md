# Architecture — cell

> The fractal harness. One primitive, every scale.

## The primitive

```
Cell = membrane + ( run | organelles + wiring )
```

`membrane` is typed ports (`inputs`/`outputs`/`caps`) — the only thing a parent sees. `run` is a leaf (one of `exec` · `python` · `http`). `organelles + wiring` is a composite — named sub-cells, typed edges. A composite is usable wherever a leaf is expected — fractal by construction.

Determinism is the termination proof: same inputs + same sub-cells -> same outputs, or the graph never settles. See `SPEC.md §4`.

## Directory

```
cell/
  SPEC.md          normative YAML standard (read before writing a cell)
  SKILL.md         agent skill — how to act
  primitives/      fixed cells: session -> auth -> request (SPEC §5, frozen membranes)
  patterns/        prompt/context/loop/graph (SPEC §6, examples not spec) + api-reveng demo
  system/          the harness that builds itself (builder.cell.yaml = parse|validate|emit)
    builder.cell.yaml   the cell that builds cells
    parse|validate|emit.cell.yaml
    neurons/parse.py, validate.py, emit.py   def run(inputs, ctx) -> dict
  run.py           canonical runtime — DAG -> topo sort -> fire leaves
  helpers.py       thin editable helpers — ~150 lines, agent may extend
  src/main.zig     Zig mirror — validates DAG only, no compiler logic
  example/         hello (python inline) + pipeline (exec -> python) + echo-http
  schemas/         JSON Schemas for membrane ports
  skills/          distilled cells — shared, amortized exploration
  docs/            this directory — system of record
```

## Execution

`run.py build <root>` delegates to `system/builder.cell.yaml` — no second code path. `run` fires leaves depth-first in topo order; composites delegate, they have no code. `check` = `run` + schema validation + double-fire determinism. Fail-closed: first violated port or cap aborts the firing.

Zig is only the runtime: `zig build && ./zig-out/bin/cell build <root>` — same semantics, validation only.

## Why `cell`

Biology's fractal unit — membrane, organelles, mitosis. Tissue *is* cells, organism *is* cells. One primitive, every scale. `fractal` is a math word; `tissue` implies fixed hierarchy. `cell` already the directory name.

## What cell is not

- Imperative steps. Edges are typed ports.
- A prompt harness. Prompts are `python` leaves if you want them.
- Infra. `caps` scopes effects; it doesn't provision them.
