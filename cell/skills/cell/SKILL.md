---
name: cell
description: Fractal harness — Cell = membrane + (run | organelles+wiring). DAG in YAML that composes programs (exec/python/http) behind one membrane. Fixed primitives (session/auth/request) for API wiring. Use when building or running a harness, writing a cell, or extending helpers.
---

# Cell — agent skill

> One primitive, every scale. Read SPEC.md once, then act.

## When to use

- Building or changing a harness (any DAG of typed steps).
- Writing a new `*.cell.yaml` (leaf or composite).
- Wiring cells together or debugging a firing.
- Adding a leaf kind or extending `helpers.py`.

## The only abstraction

```
Cell = membrane + ( run | organelles + wiring )
```

- `membrane`: typed `inputs`/`outputs`/`caps` — the only thing a parent sees.
- `run`: leaf — one of `exec` · `python` · `http` — same membrane.
- `organelles + wiring`: composite — named sub-cells, typed edges. **DAG only** (cycles refused at `build`).

> Builders are cells: `system/builder.cell.yaml` (parse | validate | emit) — `build` delegates to it, so the harness builds itself. Same membrane, no second code path.

## Fixed primitives — frozen membranes you compose (SPEC §5)

`primitives/` are fixed cells with frozen schemas — blessed wiring, ordinary implementation. No new syntax. If a target needs HMAC/OAuth/signing, add one function to `primitives/neurons/request.py` and rerun (same self-heal as `helpers.py`).

| Primitive | `inputs -> outputs` | Use |
|---|---|---|
| `session` | `base_url (+headers?) -> session` | Holds cookies/headers/base_url. One per api-rev-eng run. |
| `auth` | `session + credentials -> session` | Login/token, enriches session. `{{token}}` / `{{api_key}}` / `{{username,password}}`. |
| `request` | `session + method? + url -> response` | Merges session auth into raw HTTP, respects `allow_net`. Thin — add HMAC/OAuth to `request.py` and rerun. |

```yaml
organelles: [{name: session, cell: ../primitives/session.cell.yaml}, {name: auth, cell: ../primitives/auth.cell.yaml}, {name: fetch, cell: ../primitives/request.cell.yaml}]
wiring: [{from: session.session, to: auth.session}, {from: auth.session, to: fetch.session}]
```
See `primitives/README.md` + `patterns/api-reveng/` (session->auth->request->extract).

## Commands

```sh
python run.py build <root.cell.yaml>                               # validate DAG, emit canonical JSON + digest
python run.py run   <root.cell.yaml> --inputs inputs.json --out out/
python run.py check <root.cell.yaml> --inputs inputs.json         # run + schemas + double-fire determinism

# builder is a cell — harness builds itself
python run.py run system/builder.cell.yaml --inputs '{"root":"example/pipeline.cell.yaml"}' --out /tmp/b
```

Zig is only the runtime: `zig build && ./zig-out/bin/cell build <root>` — same validation, no Python needed.

## Writing a leaf — three executors, one membrane

All share `inputs/*.json -> run -> outputs/*.json`. Pick the thinnest that works — the graph doesn't change.

```yaml
# exec — program or binary (reads inputs/*.json, writes outputs/*.json)
run:
  kind: exec
  command: ["./bin/qualify", "--flag"]
  env: { FOO: "bar" }

# python — file or inline, same contract (def run(inputs, ctx) -> dict)
run:
  kind: python
  entry: neurons/rank.py              # file exporting def run(inputs, ctx)
  # or
  # code: |
  #   def run(inputs, ctx):
  #       return {"greeting": "hello world"}

# http — API request as a cell (templated; allow_net gates it)
run:
  kind: http
  http:
    method: POST
    url: https://api.example.com/v1/rank
    headers: { Authorization: "Bearer {{env.API_TOKEN}}" }
    body: { order: "{{inputs.order}}", candidates: "{{inputs.qualified}}" }
```
For `http`, set `membrane.caps.allow_net: ["api.example.com"]` or the request is refused. See `SPEC.md §2.2` for full shape and `helpers.py` for `render_template`.

## Composing

```yaml
spec:
  membrane:
    inputs: { order: { schema: order.v1.json } }
    outputs: { roster: { schema: roster.v1.json } }
    caps: {}
  organelles:
    - name: qualify
      cell: ./qualify-exec.cell.yaml
    - name: rank
      cell: ./rank-python.cell.yaml
  wiring:
    - { from: membrane.order,   to: qualify.order }
    - { from: qualify.qualified, to: rank.qualified }
    - { from: rank.roster,      to: membrane.roster }
```

- DAG only — `build` refuses cycles.
- Fan-out `one->many` allowed; fan-in needs an explicit `reduce` organelle.
- `cellInline:` for ad-hoc children (no file needed).
- See `example/` for a live pipeline (exec -> python) and `example/echo-http.cell.yaml` for an http leaf.

## Helpers — thin and editable (bitter lesson)

`helpers.py` is ~150 lines: `read_input`, `write_output`, `validate`, `http_request`, `render_template`. It is **agent-editable**.

> If a helper is missing: `grep helpers.py` → add the one function → rerun. That's the self-heal loop. Keep helpers raw (JSON, files, HTTP) — don't pre-build semantic wrappers. The model already knows Python and HTTP.

## Native patterns — the five layers as runnable cells (SPEC §6)

Each is a `*.cell.yaml` you can `build` and `run`. A prompt is a `python` leaf; context is `wiring` + optional `retrieve`/`curate` cells; harness is `caps`/`policy`/`skills`; loop is a `python` loop inside a leaf (no `policy.loop`); graph is wiring + typed handoffs.

- `patterns/prompt-cell/` — classify leaf (wording inside digest, no prompt field)
- `patterns/context-cell/` — retrieve (re-rank top-k) + curate (minimal toolset) + answer
- `patterns/loop-cell/` — `iterate` leaf (`for _ in range(max): ... if done: break`) — no spec syntax, raw Python bounded `for`
- `patterns/graph-cell/` — router -> parallel workers -> reduce -> human `kind: http` approval gate
- `patterns/api-reveng/` — `session -> auth -> request -> extract` demo using primitives

> Build for deletion: every pattern is an ordinary cell. When the model outgrows it, delete the organelle, not the spec.

## Evidence grounding — confirmation cell (encouraged, not required)

`patterns/confirm/confirm.cell.yaml` (`claim + evidence -> confirmed + diff`) is the encouraged organelle where external effects matter: after `primitives/request`, read back `GET` and compare digests. Not substrate — compose it where it matters (`patterns/api-reveng/confirm.cell.yaml` wraps `api-reveng` with confirmation).

## Merkle + CAS

Every `run` emits `out/manifest.json`; parent hash covers children + wiring. Same manifest -> cache hit. Large blobs via `primitives/cas` (`.cell-cas/`, sha256, write-if-absent). `system/redrive.cell.yaml` is an organelle (manifests + prior -> stale vs compensation).

## Guardrails — read before debugging

- Schemas, DAG, caps, and determinism are enforced — see `docs/constraints.md`.
- Fail-closed: first violated port or cap aborts the firing and names it.
- `policy.determinism: required` leaves are double-fired in `check` — byte mismatch fails. Models belong at edges with `best_effort`.

## Where to look

- YAML shape + execution + determinism -> `SPEC.md`
- Fixed primitives -> `primitives/README.md` + `SPEC.md §5`
- Architecture, harness map, context, constraints -> `docs/`
- Builder self-host -> `system/builder.cell.yaml` and `system/neurons/`
- Patterns -> `patterns/`  Helpers -> `helpers.py`  Runtime -> `run.py`
