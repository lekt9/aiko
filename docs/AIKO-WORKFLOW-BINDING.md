# Aiko workflow binding — Smithers controls, Cell describes

**No second scheduler.** Contract owns the durable frontier. Cell is the typed
workflow artifact. Neuron fires what has been admitted. Aiko plans; it does
not grow a side ledger.

The code path lives in `src/workflow_binding.zig`, mounted on `aiko-doctor`:

```sh
./zig-out/bin/aiko-doctor bind-workflow cell/patterns/fde/self-wire.cell.yaml --plan
./zig-out/bin/aiko-doctor workflow-control /tmp/rev bind --digest <cell-digest>
./zig-out/bin/aiko-doctor workflow-control /tmp/rev pause   # survives process restart
./zig-out/bin/aiko-doctor workflow-control /tmp/rev resume
```

`bind-workflow` asks Cell's own builder (`cell/run.py build`, or `AIKO_CELL_RUNNER`)
for the canonical JSON and definition digest. It does not parse YAML and does
not reimplement the builder. Organelles become walk nodes; child→child wiring
becomes `depends_on`. `--plan` runs Contract's existing graph analyzer on that
walk — Kahn waves, collisions, grounding — without executing anyone.

`workflow-control` is a durable revision record (`control.json`). Pause/resume
survive a new process because the record is a file. `scheduler` is always
`false`: this file does not pick the next organelle.

On the Smithers control surface, Cell is a **native workflow element** — the
same class as `Task` and `Sandbox`, not a sidecar script:

```tsx
<Sequence>
  <Cell id="wire" cell="patterns/fde/self-wire.cell.yaml" inputs={...} output={outputs.handoff} />
  <Task id="aiko" agent={new AikoAgent()} deps={{ handoff: outputs.handoff }}>
    You are seated. Own the outcome.
  </Task>
</Sequence>
```

The Cell is a harness *inside* the agent workflow. Smithers pauses and resumes
the run; Cell executes the typed DAG. No second scheduler.

```text
Smithers / control UI  ──authors, pauses, approves──►  Cell workflow
                                                         │ digest + ports
Aiko host  ──materializes the current frontier───────────┤
                                                         ▼
Contract ledger  ◄── W6H, occurrences ──  Neuron admitted limbs
```

## What each layer is allowed to do

| Layer | Owns | Must not |
|---|---|---|
| Smithers / control | Author, pause, resume, approve a Cell | Execute beside Cell, keep a second durable ledger |
| Cell | Typed membranes, wiring, content digest, Merkle manifest | Import `contract/` or `neuron/` |
| Aiko | Project Cell digest / ports / caps into Contract graph nodes | Reimplement Kahn analysis |
| Contract | Frontier, occurrences, claims, invalidation | Guess effect safety from a topology it cannot see |
| Neuron | Admitted execution, outbox, redrive, compensation | Depend on Contract at runtime |

## Cell-native self-wire

The first bound workflow is `cell/patterns/fde/self-wire.cell.yaml`:

1. `account-handle` admits `cred:<tenant>/<origin>/<account>` and refuses raw secrets.
2. `deploy-workflow` authors a seat Cell whose only organelle is `deploy-aiko`.
3. `deploy-aiko` seats Aiko as the employee on that digest.

The authored Cell is itself a harness that deploys Aiko. That is the fractal:
Aiko → deploy workflow → deploy Aiko → deploy workflow as Cells.

Witness: `tests/fde-workflow-gate.sh` (wraps `cell/tests/gates/fde-self-wire.sh`).

## What this increment does not claim

- Pause/resume of a bound Cell revision across `aiko-doctor` process restart is
  **Proven** (`workflow-control`). Smithers UI driving that record is still
  **Designed**.
- The OS credential vault is **Absent**; the Cell primitive only refuses secrets
  and carries an opaque handle.
- The local unpublished Smithers checkout is not a shipped Aiko product surface
  (see `docs/SOURCE-OF-TRUTH.md`). Published docs name the control role, not
  that checkout.

## Graph

`docs/graph-engineering/aiko-fde-self-wire.walk.json` is the executable walk
for this increment. The longer delivery graph remains
`docs/graph-engineering/aiko-fde.walk.json`.
