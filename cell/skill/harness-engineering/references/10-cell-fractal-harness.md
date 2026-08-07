# 10 — Cell: fractal harness as a composable standard

When you need a harness that is YAML-composed, fractally recursive, and executed by a runtime (not a scheduler), use **cell**. It is the concrete standard for the 2026 stack (Prompt → Context → Harness → Loop → Graph) where each layer is wiring, not prose.

## What: one primitive, every scale

```
Cell = membrane + ( run | organelles + wiring )
```

- **membrane**: typed `inputs`/`outputs`/`caps` — the only thing a parent sees. Typed by JSON Schema.
- **run**: leaf — one of `exec` (program/binary) · `python` (inline/file `def run(inputs,ctx) -> dict`) · `http` (API request, templated). Same membrane.
- **organelles + wiring**: composite — named sub-cells, typed edges. DAG only (cycles refused at `build`). Any Cell is usable as an organelle in another — fractal by construction.
- **Builder is a cell**: `system/builder.cell.yaml` = `parse | validate | emit` — `build` delegates to it, so the harness builds itself.

Determinism is the termination proof: same inputs + same sub-cells → same outputs, or it never settles. See `../../SPEC.md §4`.

## When to use

- **Harness work** (new harness, composing programs, API reverse-engineering): prefer `cell` over bespoke orchestration. It is harness-engineering §3 made executable: schema + DAG + caps + confirmation cell.
- **Graph work** (§04): when roles diverge, steps parallelize, or handoffs need auditing — `wiring:` plus `reduce`/`router`/`approval` (see `../../patterns/graph-cell/`).
- **Loop work** (§08): when you need retries/stop — **not** `policy.loop` — use a `python` loop inside a leaf (`for _ in range(max): if done: break`) with bounded `for` (see `../../patterns/loop-cell/neurons/iterate.py`). Spec stays minimal.
- **API rev-eng / session+auth**: use fixed primitives `primitives/session` → `auth` → `request` (frozen membranes, blessed wiring). Add HMAC/OAuth by editing one function in `request.py` and rerun.

## How to implement (copy, not invent)

**Start from cell, don't invent a second harness:**

```sh
python ../../run.py build ../../example/pipeline.cell.yaml
python ../../run.py run   ../../example/pipeline.cell.yaml --inputs ../../example/inputs.json --out out/
cat out/manifest.json  # {cell, inputs{digest}, outputs{digest}, evidence[], produced_by} — Merkle DAG
```

**Three leaf kinds, one membrane — pick the thinnest:**

```yaml
run: { kind: exec,   command: ["./bin/tool"] }
run: { kind: python, entry: neurons/rank.py }   # def run(inputs,ctx) -> dict
run: { kind: http,   http: { method: POST, url: "https://.../{{inputs.id}}" } }  # allow_net gates
```

**Common wiring: session handoff for API work:**

```yaml
organelles: [{name: session, cell: ../../primitives/session.cell.yaml}, {name: auth, cell: ../../primitives/auth.cell.yaml}, {name: fetch, cell: ../../primitives/request.cell.yaml}]
wiring: [{from: session.session, to: auth.session}, {from: auth.session, to: fetch.session}]
# Live demo: ../../patterns/api-reveng/api-reveng.cell.yaml  (+ confirm variant)
```

**Evidence grounding is a cell, not substrate:**

`../../patterns/confirm/confirm.cell.yaml` (`claim + evidence -> confirmed + diff`) — compose it after `request` where external effects matter, read back `GET` and compare digests. Encouraged, not enforced.

**Merkle + CAS (good from contract):**

Every `run` emits `out/manifest.json` (cell + input/output digests, evidence, produced_by). Parent hash covers children + wiring. Large blobs via `primitives/cas` (`.cell-cas/`, sha256, write-if-absent). Selective recompute is an organelle (`system/redrive.cell.yaml`: `manifests+prior -> stale vs ALREADY_SENT/compensation`), not spec.

## Progressive disclosure (how to route)

1. Agent sees `cell` via SKILL.md frontmatter (`DAG in YAML`, `fractal harness`, `composable`, `harness` keywords).
2. Agent reads `../../SKILL.md` (150 lines) for leaf recipes + helpers pattern.
3. Agent reads `../../SPEC.md` for normative YAML shape.
4. Agent reads `../../primitives/README.md` + `../../patterns/<name>/` for runnable examples.

## Self-update

This reference lives beside `01–09`. When a new reusable harness pattern emerges that is fractal execution (not just agent ops), add it as `patterns/<name>/` in `cell/` and update this file's "How to implement" table. Keep `cell` as the single standard — don't fork patterns into bespoke harness code.
