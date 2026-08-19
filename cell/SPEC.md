# Cell Spec — `cell/v0`

**Status:** draft · self-contained · python-native.

Layer of the published Aiko monorepo. Must not import `contract/` or
`neuron/`. Inventory: [`../docs/SOURCE-OF-TRUTH.md`](../docs/SOURCE-OF-TRUTH.md).
**Canonical form:** JSON. YAML is authoring sugar — `run.py` normalizes to JSON before execution.
**Runtime:** `run.py` (python) is canonical. `src/main.zig` is an optional static mirror (Zig is only the runtime).

---

## 1. One primitive

```
Cell = membrane + ( run | organelles + wiring )
```

* **membrane** — what crosses the boundary. The only thing a parent sees.
* **run** — leaf: one executor, behind the same membrane.
* **organelles + wiring**  — composite: named sub-cells and typed edges.

A composite Cell is usable wherever a leaf Cell is expected. Fractal by construction.

---

## 2. File shape

```yaml
apiVersion: cell/v0
kind: Cell
metadata:
  name: <kebab-lower, 1-32 chars>   # required
  description: <one sentence>        # required — what it does
  version: <semver>                  # optional, default 0.1.0
spec:
  membrane: { ... }                  # required
  run: { ... }                       # XOR organelles
  organelles: [ ... ]                # XOR run
  wiring: [ ... ]                    # required if organelles
  policy: { ... }                    # optional
```

### 2.1 `membrane`

```yaml
membrane:
  inputs:
    <port>: { schema: <path-or-uri>, required: true|false, render: <json-render.json|inline-object>? }  # default true; render optional
  outputs:
    <port>: { schema: <path-or-uri>, render: <json-render.json|inline-object>? }
  caps:
    allow_write: ["out/**"]   # glob allowlist, default []
    allow_net: []             # host allowlist for http leaves, default [] (no net)
    allow_spawn: false        # default false
```

* Ports are typed by JSON Schema draft 2020-12. Runtime validates inputs before firing, outputs after.
* `render` is the **visual membrane** — an optional [json-render.dev](https://json-render.dev) spec attached to the port's schema. One schema → one default view (type: `array` → table, `object` with `required` → form, etc), overridden by `render` when present.
* A Notion block is just a `Cell = membrane + (run|organelles+wiring)` whose `<port>.render` decides the block's UI. The dashboard is the DAG; the generative UI is the membrane's render.
* Caps declare intended authority for admission and audit. Today only `http` `allow_net` is mechanically checked; Python and exec leaves are not sandboxed, so their `allow_write`, `allow_spawn`, and network declarations do not confine ambient host authority.
* Every firing gets a scratch `inputs/` + `outputs/` + `out/` directory. Leaves read only `inputs/<port>.json`.

### 2.2 `run` — one membrane, three executors

All three share the contract:

```
inputs/*.json + caps  ->  run  ->  outputs/*.json + out/**
```

Same inputs, same executor bytes → same outputs, or the cell is non-deterministic (see §4).

#### `kind: exec` — program or binary

```yaml
run:
  kind: exec
  command: ["./bin/qualify", "--flag"]   # argv, resolved relative to this file
  env: { FOO: "bar" }                    # explicit only, default {}
  timeout_ms: 30000
```

Reads `inputs/<port>.json`, writes `outputs/<port>.json` by convention. Exit 0 means success.

#### `kind: python` — inline or file

```yaml
run:
  kind: python
  entry: neurons/rank.py          # file exporting `def run(inputs, ctx): -> dict`
  # or inline:
  # code: |
  #   def run(inputs, ctx):
  #       return {"roster": {"order_id": inputs["order"]["id"], "assigned": sorted(inputs["qualified"])[:2]}}
```

`inputs` is `dict[port, json]`, `ctx` is `{"caps": ..., "out_dir": "out/", "tmp_dir": "..."}`. Return value is `dict[port, json]` — one key per membrane output.

#### `kind: http` — API request wrapped as a cell

```yaml
run:
  kind: http
  http:
    method: POST
    url: "https://api.example.com/v1/rank"   # may use {{inputs.order.id}} templ
    headers: { Authorization: "Bearer {{env.API_TOKEN}}" }
    body: { order: "{{inputs.order}}", candidates: "{{inputs.qualified}}" }
    timeout_ms: 10000
```

Templating is `{{inputs.<port>.<path>}}` and `{{env.VAR}}` only. Response JSON is mapped to membrane outputs. Set `caps.allow_net: ["api.example.com"]` or the request is refused.

> All three are interchangeable — same membrane, same wiring. Swap an API for a binary by editing one leaf's `run:` block.

### 2.3 `organelles` + `wiring` (composite)

```yaml
organelles:
  - name: qualify
    cell: ./qualify.cell.yaml        # or cellInline: { apiVersion: cell/v0, ... }

wiring:
  - from: membrane.order
    to: qualify.order
  - from: qualify.qualified
    to: rank.qualified
  - from: rank.roster
    to: membrane.roster
```

Rules:

* DAG only. Cycles and recursive cell inclusion are refused at `cell build` and again before `run`.
* Wiring endpoints are strict `<node>.<port>` references. Sources may only be membrane inputs or declared organelle outputs; targets may only be declared organelle inputs or membrane outputs. Unknown nodes, unknown ports, reversed directions, and undeclared runtime inputs/outputs are refused.
* Every required membrane input is wired to >=1 organelle input (or explicitly `unused: true`). Optional membrane inputs may be unwired. Every required organelle input has exactly one source.
* Every membrane output is wired from exactly one source.
* Fan-out `one->many` is allowed. Fan-in requires an explicit `reduce` organelle — no implicit merge.
* An organelle receives only its wired input values and its own caps declaration. Python and exec code can still reach ambient host resources; do not treat that declaration as confinement.

---

## 3. Execution (and the builder is itself a cell)

```sh
python run.py build example/pipeline.cell.yaml
python run.py run   example/pipeline.cell.yaml --inputs example/inputs.json --out out/
python run.py check example/pipeline.cell.yaml --inputs example/inputs.json

# builder-as-cell — same membrane, same runtime
python run.py run system/builder.cell.yaml --inputs '{"root":"example/pipeline.cell.yaml"}' --out /tmp/b
python run.py run system/builder.cell.yaml --inputs '{"root":"system/builder.cell.yaml"}' --out /tmp/b  # self-hosted
```

* `build` delegates to `system/builder.cell.yaml` (parse | validate | emit). No second code path — the builder is a DAG like any other.
* `run` uses deterministic Kahn frontiers and fires every member of a frontier serially in lexical node order. In particular, Python siblings never run concurrently: their lack of effects is not mechanically established by `caps`. This conservative boundary remains until executor confinement is portable and witnessed. Composites delegate — they have no code.
* `check` = `run` + schema validation + double-fire determinism check (see §4).
* Fail-closed for graph, port, leaf, HTTP network-cap, output, and provenance-write failures: the first observed failure aborts the firing and names the violation. Python/exec effect declarations are audit metadata, not mechanically enforced capabilities. A result without its manifest is never success.

Zig is only the runtime: `zig build && ./zig-out/bin/cell build ...` same semantics, no second builder.

```
system/builder.cell.yaml
  parse   (python)  root -> data
  validate(python)  data -> data
  emit    (python)  data -> canonical + digest + organelle_count
```

---

## 4. Determinism is the termination proof

> A leaf on the recompute path must be deterministic. A non-deterministic leaf never settles — it re-derives a different answer, invalidates dependents, loops forever.

* `policy.determinism: required | best_effort` — default `required` for composites, `best_effort` for leaves. Set `required` whenever a leaf's output feeds another organelle.
* `run.py check` double-fires each `required` leaf with identical inputs and fails on byte mismatch.
* Models belong at **edges** as `kind: python` with `best_effort` and no downstream dependents — or behind a `cache` organelle that pins their output.

---

## 5. Fixed primitives — stdlib that ships with the harness

Bitter Lesson: maximal action space, then restrict. The spec is minimal (one primitive, three executors), but everyday wiring — especially API reverse-engineering — reuses the same membranes. Primitives are **fixed cells with frozen membranes** in `primitives/` that you compose like any other cell. No new syntax, just blessed wiring.

They are part of the spec in the way `string` is: frozen I/O, ordinary implementation.

| Primitive | Membrane | What it does | Example |
|---|---|---|---|
| `primitives/session.cell.yaml` | `base_url + headers? -> session` | Holds HTTP session state (cookies, headers, jar) across requests. One session per api-rev-eng run. | `outputs.session: {id, base_url, cookies, headers}` |
| `primitives/auth.cell.yaml` | `session + credentials -> session` | Takes a session + credentials, performs login / token exchange, outputs the same session enriched with auth (cookie or `Authorization`). Fail-closed on bad creds. Developer-API path. | `{{session.base_url}}/login` or token endpoint |
| `primitives/account-handle.cell.yaml` | `account -> handle + session` | Employee-account identity. Opaque `cred:` handle only. Refuses raw API keys, tokens, passwords, cookies. | `X-Aiko-Credential-Handle` on the session; never the secret |
| `primitives/request.cell.yaml` | `session + method? + url + headers? + body? -> response` | Merges session cookies/auth into an `http` call, respects `allow_net`, outputs raw response. Thin wrapper — model already knows HTTP. | Reuse after auth without repeating auth logic |
| `primitives/cas.cell.yaml` | `data -> key + deduped` | Content-addressed store (`.cell-cas/`), write-if-absent. Large bodies / captures deduped. | `key` is sha256 hex; `deduped` true if already present |

Schemas: `primitives/schemas/session.v1.json`, `response.v1.json`. Implementations: `primitives/neurons/*.py` (plain `def run(inputs, ctx)`), kept small and rewriteable — if a target API needs HMAC signing or OAuth, add one function to `request.py` and rerun (same self-heal as `helpers.py`).

Every `run` and `run_composite` atomically emits `out/manifest.json` — `{cell, inputs{port->digest}, outputs{port->digest}, evidence[{port,digest}], children{name->{cell,digest,produced_by}}, produced_by, digest}`. `cell` pins the canonical declaration, executable entry bytes, and all descendant definition digests; the parent manifest pins canonical child manifests plus wiring. This is the Merkle provenance root. Re-running the same deterministic graph with the same inputs produces the same manifest. Large blobs go via `primitives/cas` (`.cell-cas/`), not manifests.

`system/redrive` is an **organelle**, not substrate: feed its declared membrane `manifests + prior + prior_sent?` -> `{stale[], compensation[]}`. `prior_sent` is the durable digest set read back from the effect boundary. Stale means refire; a stale digest already present in `prior_sent` becomes an `ALREADY_SENT` compensation obligation and is removed from `stale` — case 3 is wireable and is never re-fired. Evidence grounding is a **confirmation cell** (`patterns/confirm/confirm.cell.yaml`: `claim + evidence -> confirmed + diff`), encouraged where external effects matter, not enforced in substrate.

Primitives compose natively:

```yaml
# api_reveng pattern — session holds state, auth enriches it, requests reuse it
organelles:
  - { name: session, cell: ../primitives/session.cell.yaml }
  - { name: auth,    cell: ../primitives/auth.cell.yaml }
  - { name: fetch,   cell: ../primitives/request.cell.yaml }
  - { name: extract, cell: ./extract.cell.yaml }
wiring:
  - { from: membrane.base_url,    to: session.base_url }
  - { from: session.session,      to: auth.session }
  - { from: membrane.credentials, to: auth.credentials }
  - { from: auth.session,         to: fetch.session }
  - { from: membrane.path,        to: fetch.url }
```

Non-primitives (prompt formatting, retrieval, loops, graphs) are **patterns**, not primitives — they stay in `patterns/` as examples you copy, not frozen membranes you must use. When the model outgrows a pattern, delete the organelle, not the spec.

See `primitives/README.md` for full primitive catalog and `patterns/api-reveng/` for a live API capture using `session -> auth -> request`.

---

## Input nodes are cells (no special source type)

An input node **is a cell**. Polling, webhook/event, hook, or CAS hash moving — all the same membrane, different `run:` inside. Wire whichever you need:

```yaml
# Any of these can be the source; parent just sees typed inputs
organelles:
  - { name: in,   cell: ./poll.cell.yaml }      # cursor? -> item + next_cursor  (timer/queue poll)
  - { name: work, cell: ./rank.cell.yaml }
# or: in.cell: ./webhook.cell.yaml  (webhook -> event, POST lands as inputs/webhook.json)
# or: in.cell: ./hook.cell.yaml     (file -> change, PostToolUse on Write|Edit)
# or: in.cell: ./cas-read.cell.yaml (key -> data, content hash moved in .cell-cas/)
wiring:
  - { from: in.item, to: work.order }
```

Each emits a `manifest: {source, digest}` alongside `item`. The Merkle (`out/manifest.json` `in:<port>` digests) is what `patterns/reactive-cell/check` compares — poll moved it, webhook moved it, hook moved it → `changed[]` → `system/redrive` says `stale` vs `ALREADY_SENT`. See `patterns/input-sources/` for all four runnable sources and `patterns/input-sources/harness.cell.yaml` for one harness that swaps them by rewiring, not by new `source:` syntax. `primitives/session` holds stateful inputs (cookies/base_url) across such firings.

## 6. Patterns — the five layers as wiring, not spec

Patterns are **examples**, not spec. Each maps one rung of Prompt -> Context -> Harness -> Loop -> Graph into ordinary cells you can `run`. Every pattern is an ordinary `*.cell.yaml`; when the model outgrows it, delete the organelle, not the spec.

- **Prompt** — wording lives in a `python` leaf (`def run(inputs, ctx)` returns `{"label": ...}`), prompt string stays inside the digest. See `patterns/prompt-cell/`.
- **Context** — wiring is context, plus optional `retrieve` (query->hits, re-rank) and `curate` (all_tools->allowed_tools) organelles. See `patterns/context-cell/`.
- **Harness** — `caps`/`policy`/`out/`/`skills`, builder that builds itself. See `system/` + `docs/harness.md`.
- **Loop** — not `policy.loop` — a `python` leaf that iterates (`for _ in range(n): out=run(inner); if done: break`) or a composite that wires retries via an explicit counter cell. See `patterns/loop-cell/`.
- **Graph** — wiring + typed handoffs; pipeline, router, fan-out->reduce, orchestrator-workers, human approval (`kind: http`). See `patterns/graph-cell/`.

Together: prompt is a leaf, context is wiring + optional retrievers, harness is caps+policy+memory, loop is a Python loop inside a leaf or a counter organelle, graph is a composite. Each contains the one below it — same `Cell`.

---

## 7. Minimal policy

```yaml
policy:
  determinism: required
  budget: { max_ms: 30000, max_writes: 8, max_depth: 8 }
  retain: on_success   # on_success | always | never
  writes:  [roster.json]                    # paths this node may modify
  witness: "grep -q ORD-7 roster.json"      # the runnable check that says it is done
```

No `loop` in policy — loops are patterns (python loops), not spec. No ledger, no signing, no chain for v0. Each can be a standard organelle later without changing this spec.

### 7.1 `writes` and `witness` — a cell is a graph node

Firing a node and settling it are different claims, and conflating them is how a
graph reports green while nothing landed.

* **`writes`** — relative paths, no `..`, no absolute paths. Two organelles in the
  **same Kahn frontier** are unordered by the graph; if both declare the same
  write, the run is **refused**. Lexical execution order is an accident of node
  naming, not a declared order, and a result that depends on it only looks
  deterministic. Ordering the two with a real edge admits the same writes.
* **`witness`** — a shell command run **after** the node fires, from the cell's own
  directory, with `$CELL_NODE` and `$CELL_WORKDIR` exported. Exit 0 settles the
  node and records `witness.settled` on its manifest; anything else refuses the
  whole run. Point it at what the node **declared it would write** — a witness the
  node's own success can satisfy without producing anything grades itself.

Witness: `tests/gates/node-settlement.sh`.

---

## 7.2 `harness` — how an agent reaches a system

An agent node touches an external system only through a declared harness, and
attachment is **verified against the live system before the node fires**.

```yaml
spec:
  harness:
    system: haulio-tms          # what it attaches to
    surface: mcp                # mcp | skill | http
    attach: "curl -sf $SYS_URL/health"   # proves the system answers, now
    tools: [list_orders]        # the operations this harness exposes
```

The probe runs **before** the handler, not after. A node that fired against an
absent system still hands a value downstream, and every consumer then treats it
as though the system produced it — refusing at attach is what keeps that value
from existing at all. The attachment lands on the node manifest (`harness.system`,
`surface`, `tools`, `attached`), so a reader can ask which system a value came
from instead of inferring it.

Fails closed at build time: no `attach` (attachment would be self-asserted), an
empty `tools` (a connection claim with no operation behind it — the same
emptiness an acceptance-free `SKILL.md` is refused for), an unknown `surface`,
or any unknown field.

The declaration is exported to its own probe as `$CELL_HARNESS_SYSTEM`,
`$CELL_HARNESS_SURFACE`, `$CELL_HARNESS_TOOLS`. Interpolating the system name by
hand is how these fail open — `grep -q ""` matches every line, so a probe whose
name never arrived attaches to anything that prints output.

Witness: `tests/gates/harness-attach.sh`.

### 7.3 Worked example — codegraff as the agent

`primitives/graff-agent.cell.yaml` is an agent node backed by
[codegraff](https://github.com/justrach/codegraff) (`graff`), a Zig agentic
harness with multi-provider models, MCP, and a one-shot `-p` mode. It reaches
its target system **only** through an MCP server registered with graff:

```yaml
harness:
  system: mcp-server
  surface: mcp
  attach: "graff --version >/dev/null && graff mcp 2>&1 | grep -q \"$CELL_HARNESS_SYSTEM\""
  tools: [one_shot]
```

The probe checks **both halves** — the harness binary answers, and the named
server is actually registered with it. Either half alone certifies a reach the
agent does not have.

`graff --schema` publishes a machine-readable interface, which is what makes a
harness derivable rather than hand-asserted — the same shape `morphogenesis.zig`
requires of a boundary before it will build against it.

**This node declares `determinism: none` and that is not a shortcut.** graff
drives a model, and a model on the recompute path re-derives a different answer,
invalidates its own dependants, and never reaches a fixpoint. An agent node
belongs at the edge; its `witness` is the only thing that can settle it, and its
output must not feed a deterministic producer.

Witness: `tests/gates/graff-agent.sh` (skips cleanly when graff is not installed).

**Not to be confused with `justrach/codedb`** — the same author's code-intelligence
MCP server, blogged on the same `codegraff.com` domain. Different tool.

---

## 8. Conventions

* File extension: `*.cell.yaml`
* Schemas: `schemas/<name>.v1.json` · `primitives/schemas/*.v1.json`
* Leaf code: `neurons/<name>.py` · `primitives/neurons/*.py`
* Build output: `.cell-canonical/<name>.cell.json` (committed for pinning)
* Render: `<port>.render` is optional json-render spec on the port. Omit it and the UI is inferred from `schema`.
* Patterns: `patterns/<name>-cell/` (runnable demos, not spec)
* Primitives: `primitives/*.cell.yaml` (frozen membranes, blessed wiring)

---

## 9. What `cell` is not

* Imperative steps. Edges are typed ports.
* A prompt harness. Prompts are `kind: python` leaves — no special field.
* Infra. `caps` declares intended effects; except for HTTP host checks, it neither confines nor provisions them.
* A second orchestrator. Loops and graphs are wiring + Python, not scheduler syntax.
