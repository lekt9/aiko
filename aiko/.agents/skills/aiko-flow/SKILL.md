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

- **Smithers** controls, never duplicates the ledger. Two entry points — both wired by the default plugin:
  - **MCP** `smithers` tools: `list_workflows`, `run_workflow`, `watch_run`, `get_run`, `list_pending_approvals`, `resolve_approval`, `ask_human`, …
  - **CLI** `smithers` (via `node bin/smithers.mjs` in the installed control limb)
- **Cell** executes deterministic DAGs: `python3 cell/run.py run cell/patterns/fde/self-wire.cell.yaml --inputs '{...}'` or `aiko-doctor bind-workflow cell/patterns/fde/self-wire.cell.yaml --plan` then `workflow-control pause/resume` (durable file).
- **Aiko** projects digest/ports/caps into Contract graph nodes; `aiko-doctor graph-plan walk.json` is the analyzer.

## Self-wire (Aiko seats Aiko)

The fractal harness: `deploy-workflow` authors a seat `Cell` whose only organelle is `deploy-aiko`; `deploy-aiko` seats `{"agent":"aiko","seat":"employee","auth":"account-handle"}` on `cred:<tenant>/<origin>/<account>`. Raw `token/api_key/password/cookie` is refused at the membrane — use opaque `cred:` handles.

```sh
python3 cell/run.py run cell/patterns/fde/self-wire.cell.yaml \
  --inputs '{"account":{"tenant":"acme","origin":"https://ops.example","account_id":"aiko-ops"},"role":"ops-staffer","outcome":"own daily roster confirmation"}' \
  --out /tmp/fde
./zig-out/bin/aiko-doctor bind-workflow cell/patterns/fde/self-wire.cell.yaml --plan
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

`tests/fde-workflow-gate.sh` + `cell/tests/gates/fde-self-wire.sh` (handle not API key, digest-pinned, authored harness wires `deploy-aiko`) and `tests/aiko-smithers-limb-gate.sh` (Aiko discovers `smithers` skill+MCP, `node bin/smithers.mjs --mcp` boots, Cell scheduled and resume does not refire). See `docs/AIKO-WORKFLOW-BINDING.md` and `docs/AI-FORWARD-DEPLOYED-ENGINEER.md`.
