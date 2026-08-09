# Migration guide: from implicit flows to witnessed graphs

This guide migrates behavior without inventing a new scheduler. Make declarations explicit first, then move execution only where the owning layer supports it.

## 1. Inventory the old flow

Write one row per residual unit of work. For each row answer:

- What result does it produce?
- Which earlier result does it actually read?
- What files/resources can it write?
- Is it deterministic with the same pinned inputs?
- Can it send, charge, deploy, or mutate an external system?
- Which installed skill/module grounds the method?
- Which command independently proves completion?

Do not turn headings, phases, or “and then” into dependencies. If step B never reads or waits for a settled fact from A, remove the edge.

## 2. Apply the chain-vs-graph gate

Before creating workers, count the current ready units.

| Old shape | Migration decision |
|---|---|
| One task, or every task reads the previous result | Keep one worker: **chain, not a graph**. |
| Several roots with no data edge | Declare independent nodes; inspect collisions; then isolate and fan out. |
| Several roots that share a write/effect resource | Keep serial, or isolate each workspace and add a reconcile node. |
| An unknown/circular dependency | Repair the plan; do not run an acyclic prefix. |

This gate is re-evaluated after each settlement. A walk can be a chain now and expose a graph in the next wave.

## 3. Replace prose steps with a Contract walk

Old:

```text
Research, then audit, then write the report.
```

This wording hides whether research and audit are independent. New:

```json
{"nodes":[
  {"id":"research","plan":"produce research.json","depends_on":[],"status":"pending",
   "reads":["brief.md"],"writes":["work/research.json"],
   "invoke_skills":["websearch"],"inspire_from":[],"capability_gaps":[],
   "witness":"test -s work/research.json"},
  {"id":"audit","plan":"produce audit.json","depends_on":[],"status":"pending",
   "reads":["src/**"],"writes":["work/audit.json"],
   "invoke_skills":["code-review-and-quality"],"inspire_from":[],"capability_gaps":[],
   "witness":"test -s work/audit.json"},
  {"id":"report","plan":"join the two pinned products","depends_on":["research","audit"],"status":"pending",
   "reads":["work/research.json","work/audit.json"],"writes":["docs/report.md"],
   "invoke_skills":["copywriting"],"inspire_from":[],"capability_gaps":[],
   "witness":"test -s docs/report.md"}
]}
```

`reads` documents the data contract for humans/other runtimes. The current pure analyzer derives topology from `depends_on` and collisions from `writes`; it does not verify `reads`/producer intersections. Keep those declarations honest rather than assuming the planner enforces them.

Required parser fields are `id`, `depends_on`, and `status`. In practice, give every active node a specific `plan`, `writes`, one grounding route, and a runnable `witness` so diagnostics are empty.

### Status migration

Only `pending` and `failed` are active. Preserve settled nodes in the walk so pending descendants can reference them, but they disappear from new frontiers. Do not delete historical identity merely to make a planner output look smaller.

## 4. Close diagnostics before launch

Run:

```sh
./zig-out/bin/aiko-doctor graph-plan walk.json | tee verdict.json | python3 -m json.tool
```

Treat fields differently:

- `unknown_dependencies` or `cycle_list`: hard refusal; `ready` must be empty.
- `write_collisions`: isolate/serialize/reconcile; never assume dependency freedom solves it.
- `grounding_gaps`: choose an installed skill, cite a stable source, or retain an explicit capability gap.
- `gating_gaps`: add a falsifiable command that checks durable output/state rather than stdout resemblance.

The planner reports the latter three; your launcher/policy must refuse unsafe launch. Do not misdocument them as analyzer-enforced blocks.

## 5. Move in-process wiring to Cell

Use Cell when the old flow is a typed program composition rather than a durable multi-agent obligation.

Old Python orchestration:

```python
left = transform(value)
right = classify(value)
return combine(left, right)
```

New composite shape:

```yaml
apiVersion: cell/v0
kind: Cell
metadata: {name: joined-work, description: independent transforms with explicit join}
spec:
  membrane:
    inputs: {value: {schema: string}}
    outputs: {result: {schema: object}}
    caps: {}
  organelles:
    - {name: left, cell: ./left.cell.yaml}
    - {name: right, cell: ./right.cell.yaml}
    - {name: reduce, cell: ./reduce.cell.yaml}
  wiring:
    - {from: membrane.value, to: left.value}
    - {from: membrane.value, to: right.value}
    - {from: left.item, to: reduce.left}
    - {from: right.item, to: reduce.right}
    - {from: reduce.result, to: membrane.result}
```

Migration rules:

1. Give every endpoint a declared port and schema.
2. Use a named reducer for fan-in; never rely on an implicit shared dictionary/file.
3. Remove ambient inputs; undeclared root inputs are refused.
4. Declare network/write/spawn capabilities for audit. Only a mechanically confined and witnessed kind may ever parallelize. All same-frontier Python/exec siblings serialize because those caps are not mechanical confinement.
5. Make required recompute paths deterministic; verify with `python3 cell/run.py check ...`.
6. Retain `out/manifest.json`; a result without provenance is failure.

A Contract walk does not automatically become this YAML. Use Contract for durable obligations/leases/settlement and Cell for the typed execution unit each worker invokes.

## 6. Replace implicit lineage with Neuron citations

Old behavior often reads a file/message and emits a product without recording the dependency. That product cannot become stale when the source moves.

For each firing:

- pin or identify the stimulus/message/substrate read;
- cite it in `evidence[].sources`;
- attach artifacts with `produced_by` set to the firing;
- commit once under canonical firing identity.

After migration, `/graph` can project `source --cites--> firing --produces--> artifact`. The observer intentionally does not add task readiness or effect-safety labels.

## 7. Separate computation from effects

Classify every old retry:

| State | New route |
|---|---|
| Deterministic, runnable, no external boundary crossed | Recompute under a new firing ID. |
| Not runnable mechanically, no boundary crossed | Open a bounded agent goal. |
| Independent read-back says old product crossed the boundary | Create compensation from before/after evidence; never replay. |

Do not treat “the sender returned success” as read-back. Persist an outbox/receipt/digest observed independently enough to establish `prior_sent`. The Cell redrive organelle accepts that state; it does not create its authority.

For an old “retry notify everyone” loop, split it into:

```text
pinned roster -> deterministic delta -> proposed messages -> send/read-back
                                         | source moves after send
                                         v
                              CompensationGap(old,new)
```

The compensation computes the delta (cancel/change/add) rather than sending the superseded batch again.

## 8. Move witnesses to the settlement edge

Replace checks such as “worker said done” or `grep` over its explanatory stdout with commands that inspect the produced artifact or durable state. Pin witness identity with the admitted work where the production Contract path supports it, and have a position independent of the producer execute it.

Good examples:

```sh
test -s out/report.json
python3 -c 'import json; x=json.load(open("out/report.json")); assert x["schema"]=="report/v1"'
bash tests/behavior-gate.sh
```

A non-empty witness string only clears the planner’s `ungated` diagnostic. It is not proof until executed and its evidence participates in settlement.

## 9. Preserve compatibility during rollout

A safe sequence is additive:

1. Add graph declarations beside the old serial runner.
2. Compare deterministic planner output for reordered inputs.
3. Run one frontier serially while validating dependencies/writes.
4. Isolate workspaces and enable fan-out only for a proven independent frontier.
5. Add an explicit join/reconcile step.
6. Add citations and manifests before enabling reactive recomputation.
7. Add durable effect read-back before enabling automatic redrive.
8. Remove the old implicit scheduler only after the cross-layer gate remains green.

Do not migrate durable truth into a YAML manifest, move Cell into Contract, or import Contract from Neuron to reduce adapter work.

## 10. Known compatibility bounds

- Planner input order is irrelevant; output order is lexical.
- `cycle_list` and `cycles`, `ungrounded` and `grounding_gaps`, and `ungated` and `gating_gaps` are additive aliases in current JSON output.
- Planner collision analysis sees declarations, not real syscalls or remote resources.
- Grounding presence does not prove a named skill exists.
- Cell frontiers are topological, not concurrency authority. Only a mechanically confined and witnessed kind may ever parallelize. Today every same-frontier sibling serializes; Python/exec caps are audit metadata.
- Neuron’s compacted observer view is final folded state, not full reconstructed message history.
- The root graph gate anchors the Rust host ABI but does not rebuild its large test target.
- The dated repository audit may describe pre-migration failures; use current gates for current behavior.

## Source vs. synthesis

The supplied lecture directly recommends understanding intent, planning with declared tools, using them, reflecting on results, solving real business problems, and keeping generated-code liabilities visible. It does not prescribe this migration, a graph schema, Kahn execution, Cell, Neuron, Contract, witnesses, or compensation. Those steps are repository-specific synthesis and must be judged by the runnable gates below.

## Migration acceptance checklist

- [ ] Every dependency carries data/evidence/authority/settlement.
- [ ] Current chain-vs-graph verdict is understood; no premature fleet.
- [ ] No unknown dependency or cycle.
- [ ] Every collision is serialized or isolated and reconciled.
- [ ] Every active node names a method or honest capability gap.
- [ ] Every active node has a runnable, falsifiable witness.
- [ ] Typed Cell ports replace ambient mutable state.
- [ ] Recompute-path producers are deterministic.
- [ ] Every derivation cites its source.
- [ ] External effects have durable independent read-back.
- [ ] Case 3 routes to compensation and cannot re-enter stale work.
- [ ] Standalone Neuron and forbidden directions remain green.
- [ ] `bash tests/graph-engineering-gate.sh` passes.
