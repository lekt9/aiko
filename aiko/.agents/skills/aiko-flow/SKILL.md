---
name: aiko-flow
description: "Aiko Flow — durable Cell+Smithers harness. Use for long-running, multi-step, crash-safe, pause/resume, approval, retry, or self-wiring work; triggers the default Smithers control plane (no flag) and Cell patterns under cell/patterns/fde/."
---

# Aiko Flow

Aiko Flow is the **default durable harness** for agentic work. Cell is the typed workflow artifact; **Smithers is the default control plane** that authors, pauses, resumes, and approves it; Contract owns the frontier; Neuron fires admitted limbs. It is installed and **enabled by default** — no `--with-control` flag, no manual `aiko plugin enable smithers` needed.

## When to use

Use `aiko-flow` when ANY of these is true:

- long-running, multi-step, or backgroundable work
- needs crash-safety, resume after restart, or pause/resume
- needs approvals, human-in-the-loop, retries, or loops with verified exits
- should survive handoff (continue without the Aiko host)
- self-wiring / self-deploy: `account-handle → deploy-workflow → deploy-aiko` (`cell/patterns/fde/self-wire.cell.yaml`)

Do NOT use for a trivial one-off edit in a single file — run it directly. If the ask is one clear goal (even repo-wide, up to ~300k tokens), prefer `aiko-flow` via `smithers oneshot`; only author a full workflow when ordered phases, approvals, loops, or reuse are required.

## How it wires (native, no second scheduler)

```
Smithers/control UI ──authors/pauses/approves──► Cell workflow (typed DAG, digest-pinned)
Aiko host ──materializes frontier───────────┤
                                           ▼
Contract ledger ◄──W6H, occurrences── Neuron admitted limbs + outbox → Unbrowse/local adapters
```

## Layer lock (do not invert)

These are four different things. Mixing them is how Hoysan grew `POST /api/smithers/run` that did roster math and called itself `aiko-flow-local`.

| Layer | Owns | Must not |
|---|---|---|
| **Cell** | Deterministic product (`cell/run.py`, `runCell`) | HTTP, credentials, a ledger, the name Smithers |
| **Smithers** | Start / pause / approve / resume the Cell | Smithers does not compute the product; do not `fetch` a Worker to do Cell work |
| **Worker / UI** | Project the last Cell product for humans | Implement `/api/smithers/run`, claim `engine: "aiko-flow-local"` |
| **Contract** | Lineage, W6H, settlement | Live in wrangler memory |

Refusals (a gate fails the tree if these appear as implementations):

- Do not add `POST /api/smithers/run` that runs business logic.
- Do not label an in-process handler `aiko-flow-local`.
- Do not write a Smithers workflow whose only task is `fetch(…/api/smithers/run)`.
- Do not `smithers init` a product app and keep the seeded whole-foods / federation pack.
- Do not fork `cell/patterns/hoysan-draft` into a new TypeScript engine.

One-shot without creds = run the **Cell**. Smithers is optional control around that Cell. A Worker may *host* the Cell (`POST /api/cell/run`) or *apply* a product (`POST /api/projections/apply`). That is not Smithers.

- **Smithers** controls, never duplicates the ledger. Two entry points — both wired by the default plugin:
  - **MCP** `smithers` tools: `list_workflows`, `run_workflow`, `watch_run`, `get_run`, `list_pending_approvals`, `resolve_approval`, `ask_human`, …
  - **CLI** `smithers` (via `node bin/smithers.mjs` in the installed control limb)
- **Cell/runCell** executes deterministic typed DAGs; it keeps no credential, context, readiness, or durable-control truth.
- **ContractCell** composes that typed harness with the native Contract driver for lifecycle and recovery. `aiko-doctor graph-plan walk.json` remains the read-only analyzer.

## Self-wire (Aiko seats Aiko)

The fractal harness: `deploy-workflow` authors a seat `Cell` whose only organelle is `deploy-aiko`; `deploy-aiko` seats `{"agent":"aiko","seat":"employee","auth":"account-handle"}` on `cred:<tenant>/<origin>/<account>`. Raw `token/api_key/password/cookie` is refused at the membrane — use opaque `cred:` handles.

```sh
python3 cell/run.py run cell/patterns/fde/self-wire.cell.yaml \
  --inputs '{"account":{"tenant":"acme","origin":"https://ops.example","account_id":"aiko-ops"},"role":"ops-staffer","outcome":"own daily roster confirmation"}' \
  --out /tmp/fde
```

On the Smithers surface, `Cell` is a native workflow element (same class as `Task`/`Sandbox`):

```tsx
<Sequence>
  <Cell id="wire" cell="cell/patterns/fde/self-wire.cell.yaml" inputs={...} output={outputs.handoff} />
  <Task id="aiko" agent={new AikoAgent()} deps={{ handoff: outputs.handoff }}>You are seated. Own the outcome.</Task>
</Sequence>
```

## Right-size the route

1. **Trivial edit** → do it directly, no harness.
2. **One clear goal, any size** → `smithers oneshot "<goal>"` (Aiko Flow runs one strong agent durably).
3. **Genuinely multi-goal** (ordered phases, approvals, loops, reuse) → full `aiko-flow` workflow under `.smithers/workflows/<id>.tsx` (fetch `https://smithers.sh/llms-full.txt` first) with optional live UI at `.smithers/ui/<id>.tsx`.

Disable only if you must: `aiko plugin disable smithers` (or `aiko plugin disable aiko-flow` when renamed); explicit `disabled` still wins over default-enable.

## Witness

`tests/no-duplicate-fde-primitives-gate.sh` preserves and smokes Cell/runCell while refusing the retired authority paths. `tests/smithers-contract-driver-gate.sh` and `tests/smithers-control-package-gate.sh` witness native Contract-backed control; `tests/recursive-aiko-organism-gate.sh` witnesses the composed Aiko path. See `docs/AI-FORWARD-DEPLOYED-ENGINEER.md`.
