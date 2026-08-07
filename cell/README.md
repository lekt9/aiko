# cell — a fractal harness standard

> A `cell` is a harness composed from YAML, executed by Python, self-similar at every scale.

Self-contained. Does not import `contract/` or `neuron/`. Logic is Python when it needs to be; Zig is only the runtime.

---

## 30-second example

```yaml
# hello.cell.yaml
apiVersion: cell/v0
kind: Cell
metadata: { name: hello, description: minimal leaf }
spec:
  membrane: { inputs: {}, outputs: { greeting: { schema: string } }, caps: {} }
  run: { kind: python, code: |
      def run(inputs, ctx): return {"greeting": "hello world"} }
```

```sh
python run.py run hello.cell.yaml --out out/
cat out/greeting.json  # "hello world"
```

Composite — a DAG in YAML that composes programs:

```yaml
# pipeline.cell.yaml — exec -> python
spec:
  membrane: { inputs: { order: {schema: order.v1.json}}, outputs: { roster: {schema: roster.v1.json}}, caps: {}}
  organelles:
    - { name: qualify, cell: ./qualify-exec.cell.yaml }   # kind: exec  (a program)
    - { name: rank,    cell: ./rank-python.cell.yaml }    # kind: python
  wiring:
    - { from: membrane.order,    to: qualify.order }
    - { from: qualify.qualified, to: rank.qualified }
    - { from: rank.roster,       to: membrane.roster }
```

That file *is* a Cell — use it as an organelle in another Cell. Three leaf kinds (`exec` · `python` · `http`) share one membrane, so swapping an API for a binary is one `run:` block.

Fixed **primitives** (`primitives/session`, `auth`, `request`, `cas`) give frozen membranes for API reverse-engineering — session holds state, auth enriches it, request merges auth into HTTP, cas dedups. See `primitives/README.md` + `patterns/api-reveng/`.

Every firing writes `out/manifest.json` (cell hash, input/output digests, evidence, produced_by) — the Merkle. Large blobs go via `primitives/cas` (`.cell-cas/`). See SPEC §5.

Builder is itself a cell (`system/builder.cell.yaml` = parse | validate | emit) — the harness builds itself. See SPEC §3.

---

## Why this exists

`contract` proved two ideas and grew a lot of accretion:

1. **A harness is a DAG of typed steps that can be re-executed deterministically.**
2. **A harness is fractal** — any subgraph should be a node in a larger harness.

`cell` keeps the two, deletes the rest for v0. What was deleted returns as *organelles*, not axioms.

---

## Why `cell`

Biology's fractal unit — membrane, organelles, mitosis. A tissue *is* cells, an organism *is* cells. One primitive, every scale. `fractal` is a math word; `tissue` implies fixed hierarchy. File is `*.cell.yaml`.

---

## How it borrows the bitter lesson

Borrowed from Browser Use's *Bitter Lesson of Agent Harnesses* (don't wrap the agent, don't wrap its tools — give raw primitives, let the model write what it needs) and *Web Agents That Actually Learn* (exploration is the cost — distill skills, share, amortize). In `cell`:

- Helpers are thin and agent-editable (`helpers.py` ~150 lines) — missing helper -> edit, add one function, rerun.
- Leaves are raw: Python `def run(inputs, ctx)`, HTTP `method/url/headers/body`, exec `command` — no wrappers.
- Skills are distilled cells (`skills/*_skill.cell.yaml`) — same shape, shared, voted (see `docs/skills.md`).
- Primitives are frozen membranes for common wiring (session/auth/request/cas), not wrappers.
- Evidence grounding is a confirmation **cell** (`patterns/confirm/`) you compose where external effects matter — encouraged, not enforced.

---


> Discover more: `/skill:find-skills` → `npx skills find <query>` or https://skills.sh/. `cell` composes with any discovered skill as an `exec`/`http` leaf.

## Quick start

```sh
python run.py build example/pipeline.cell.yaml
python run.py run   example/pipeline.cell.yaml --inputs example/inputs.json --out out/
python run.py check example/pipeline.cell.yaml --inputs example/inputs.json
cat out/roster.json
cat out/manifest.json  # {cell, inputs{digest}, outputs{digest}, evidence[], produced_by}
```

Patterns (SPEC §6):

```sh
python run.py run patterns/prompt-cell/classify.cell.yaml --inputs '{"ticket":{"text":"refund please"}}' --out /tmp/p
python run.py run patterns/context-cell/context.cell.yaml --inputs '{"query":"battery?"}' --out /tmp/c
python run.py run patterns/loop-cell/loop.cell.yaml --inputs '{"ticket":{"text":"battery issue"},"capacity":{"available_pct":90}}' --out /tmp/l
python run.py run patterns/graph-cell/graph.cell.yaml --inputs '{"query":"battery refund"}' --out /tmp/g
python run.py run patterns/api-reveng/api-reveng.cell.yaml --inputs '{"base_url":"https://postman-echo.com","credentials":{"token":"demo"},"path":"/get"}' --out /tmp/a  # session->auth->request
python run.py run patterns/api-reveng/confirm.cell.yaml --inputs '{"base_url":"https://postman-echo.com","credentials":{"token":"demo"},"path":"/get"}' --out /tmp/ac  # with confirmation
```

Zig is only the runtime: `zig build && ./zig-out/bin/cell build <root>`

## Build and verify

```sh
zig build        # -> zig-out/bin/cell (Zig mirror, validates DAG)
zig build test   # python test suite (tests/test_cell.py)
zig build gate   # 10 witnesses — the acceptance criterion (empty dir, CLI, durable state)
```

Gates prove the thing works by failing when you delete it. See `tests/gates/` for each witness + falsifier. `tests/gate.sh` aggregates all 10.

---

## Nested skills (skill contains skills)

Every `*.cell.yaml` is a Cell — so a skill **contains skills** by wiring sub-skills as organelles. Example:

```yaml
# skills/seedance-bundle.cell.yaml
organelles:
  - { name: seedance, cell: ../patterns/video/seedance.cell.yaml }  # seedance itself wires fal-generate + poll
wiring:
  - { from: membrane.prompt, to: seedance.prompt }
  - { from: seedance.video_url, to: membrane.video_url }
```

Need a capability you don't have yet? Don't write one-off Python — declare a gap and author a cell:

```yaml
organelles:
  - { name: author, cell: ../primitives/author.cell.yaml }  # gap -> cell (bounded search, never reads expect_contains)
```

See `primitives/author.cell.yaml` (seedance, http-wrap, echo) and `patterns/video/seedance*.cell.yaml` for realistic Seedance 2 videos.

## Documentation map

| Doc | What |
|---|---|
| `SPEC.md` | Normative standard — YAML shape, membrane, 3 leaves, wiring, DAG, determinism, primitives, patterns |
| `SKILL.md` | Agent skill — when/how to act, leaf recipes, helpers + primitives + confirmation + merkle |
| `docs/architecture.md` | Architecture overview + directory |
| `docs/harness.md` | How this repo applies harness-engineering layers |
| `docs/context.md` | Progressive disclosure (AGENTS -> docs/ -> SPEC) |
| `docs/constraints.md` | Enforced guardrails + one-rule-per-mistake |
| `docs/skills.md` | Skills lifecycle (distill, vote, PII gate) |
| `example/` | Live pipeline (exec -> python) + http leaf + schemas |
| `primitives/` | Fixed cells: `session`/`auth`/`request`/`cas` — e.g. `session -> auth -> request` for API rev eng |
| `patterns/` | Prompt -> Context -> Harness -> Loop -> Graph + `api-reveng` + `confirm` |
| `system/` | Builder that builds itself + `redrive` organelle |
