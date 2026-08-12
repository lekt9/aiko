# Repository audit: graph-engineering nativeness

> **Historical.** Dated review or transcript. Not current product documentation. What the tree is today: [../SOURCE-OF-TRUTH.md](../SOURCE-OF-TRUTH.md).

**Snapshot:** current working tree, 2026-08-08
**Scope:** root Aiko composition, `cell/`, standalone `neuron/`, `contract/libcontract/`, and the Rust host in `aiko/`. This is an architecture audit, not a claim that the current graph witness is green.

## Executive verdict

Aiko already contains most of the *runtime* pieces of a native graph system, but they are split across four vocabularies and two planners:

- **Cell** has the clearest compositional graph declaration: membranes, named organelles, typed port wiring, explicit fan-in, DAG validation, and deterministic manifests.
- **Neuron** has the strongest reactive derivation graph: canonical firings, `produced_by`, grounded evidence sources, staleness projection, joins, and the three-case redrive refusal.
- **Contract** has the strongest durable execution graph: bounded topological waves, dependency-ready leases, canonical node settlement, input bindings, graph digests, and append-only replay.
- **The Rust Aiko host** composes admitted Skill nodes, creates explicit discovery nodes, executes leased waves concurrently, and independently gates settlement with witnesses.

That is substantial graph nativeness. It is not yet one coherent graph-engineering surface. The production execution path is more capable than `graph_plan.zig`, while the automatic graph verdict and its checked-in witness claim fields that the analyzer does not emit. Cell's “parallel” graph is currently executed serially, and its documented Merkle and compensation properties are only partial. The root acceptance gate does not cover the Cell or Rust-host graph path.

**Current classification:** graph-native execution substrate, **not yet graph-native repository contract**.

## Audit basis and working-tree caveat

The audit read the current files, including uncommitted content, rather than assuming `HEAD` behavior. Relevant observations were mechanically checked:

- `zig build test` passes in both `neuron/` and `contract/libcontract/`.
- `cell/patterns/graph-cell/graph.cell.yaml` builds and passes `run.py check` with a temporary input.
- `bash aiko/scripts/witness-graph-frontier.sh` fails immediately: `graph_plan.zig lacks fn scopeOverlap`.

The repository was already dirty. At the final snapshot it contained:

- modified desktop files: `aiko/apps/desktop/src-tauri/src/{console,webhost}.rs`;
- a dirty `aiko/apps/frontend` submodule worktree;
- modified Cell policy/hook files: `cell/SKILL.md`, `cell/docs/constraints.md`, `cell/hooks/hooks.json`;
- untracked Cell hook/reuse implementation: `cell/hooks/{fractal-grind.sh,pre_write_cell_steer.py}` and `cell/scripts/`;
- modified `contract/libcontract/src/{graph_plan,ledger}.zig`;
- untracked `career-ops/`.

`aiko/Cargo.lock` appeared modified in the initial status and became clean during the audit without this audit editing it, so the worktree is being changed concurrently. The desktop/frontend changes belong to the separate onboarding walk in `.claude/jesus-graph.local.json` (6/8 settled when observed); they are not evidence for this audit and must not be overwritten by graph work.

The uncommitted `graph_plan.zig` patch fixes the `peak_parallelism` calculation to use maximum group size and changes test verdict bindings to `var`. It does **not** implement Kahn waves, collisions, tiers, or cycle reporting. The uncommitted ledger patch lowers `readAll` from 1 GiB to 16 MiB; the Skill claim/settle projections use streaming readers, but every other `readAll` caller must be audited before treating that cap change as harmless. The Cell changes introduce a reuse radar and Stop-hook “fractal grind”; they are proposed guardrails, not settled graph primitives yet.

## Existing reusable primitives

### 1. Root Aiko composition

| Primitive | Location | Reuse value |
|---|---|---|
| One-way two-layer build | `build.zig` | Composes standalone Neuron and Contract without restating either build. |
| Typed seam witness | `src/main.zig`, `tests/bridge-gate.sh` | Proves Contract can consume the shared typed-Neuron request while Neuron remains standalone. |
| Public behavioral gates | root `zig build gate` | Drives public CLI and durable state rather than accepting stdout resemblance. |
| Single product CLI | Neuron artifact installed as `zig-out/bin/aiko` | Keeps ports, telemetry, limb lifecycle, and redrive behind one surface. |

The root is a composition boundary, not a graph scheduler. That is correct. Its reusable role should remain integration and acceptance, not a fifth graph engine.

### 2. Cell: declarative composition graph

| Primitive | Location | Exact behavior |
|---|---|---|
| Fractal node contract | `cell/SPEC.md` | `Cell = membrane + (run | organelles + wiring)`; leaves and composites share one membrane. |
| Typed data edges | `spec.wiring` | Ports are explicit; fan-out is allowed; fan-in is intended to require a reducer. |
| DAG/cycle detection | `cell/run.py:265-295`, `resolve_organelles` | Kahn-orders organelles and refuses cycles; also refuses recursive cell inclusion. |
| Explicit reducer pattern | `cell/patterns/graph-cell/reduce.cell.yaml` | Makes fan-in a named executable node instead of an implicit merge. |
| Capability membrane | leaf `membrane.caps` | Bounds writes/network at the cell edge. |
| Determinism check | `run.py check` | Double-fires required paths and compares results. |
| Content-addressed storage | `cell/primitives/cas.cell.yaml` | Reusable write-if-absent blob identity. |
| Manifest vocabulary | `cell/run.py:_manifest_entry` | Records input/output digests, evidence ports, and `produced_by`. |
| Reactive/compensation patterns | `patterns/reactive-cell/`, `system/redrive.cell.yaml` | Compares manifest versions and separates stale work from nominal compensation. |
| Graph pattern | `patterns/graph-cell/graph.cell.yaml` | Router/fan-out/reduce/approval topology expressed with ordinary cells. |

### 3. Neuron: firing and reactive derivation graph

| Primitive | Location | Exact behavior |
|---|---|---|
| Canonical firing identity and settlement | `neuron/src/runtime.zig`, `substrate.zig` | Idempotent commit/replay; contradictory reuse fails closed. |
| Derivation edges | `substrate.Artifact.produced_by`, persisted evidence `sources` | Artifact → firing and firing → cited sources reconstruct provenance without a separate graph database. |
| Grounded-read validation | `runtime.zig:302+` | Evidence sources must be stimulus/message/pinned substrate reads. |
| Join/quorum | `neuron/src/topology.zig:JoinNeuron` | Deduplicates typed messages and fires only at declared quorum. |
| Topology-aware execution | `interface.zig`, `membrane.zig`, `redrive.zig` | Attached hops carry deterministic/effect-boundary properties used in classification. |
| One staleness projection | `limb_ops.collectStale` | Detection, action, and observation share journal-order invalidation logic. |
| Three-case redrive | `redrive.zig` | Deterministic rederive; agent escalation when uncrossed but unavailable; compensation gap when already sent. |
| Read-only graph observation | `observe.zig` | Streams citations and production edges without locking substrate or exposing payloads. |
| Admission by digest | `limb_ops.zig`, `morphogenesis.zig` | Generated/discovered implementations remain inert until admitted and attached. |

Neuron is natively a **reactive data/effect graph**, not a general task-DAG planner. That boundary should be preserved.

### 4. Contract: durable obligation/execution graph

| Primitive | Location | Exact behavior |
|---|---|---|
| Bounded topological scheduler | `contract/libcontract/src/muscle.zig:schedule` | Cycle/depth bounded waves (`MAX_NODES=128`, `MAX_WAVES=32`, `MAX_PARALLEL=16`). |
| Durable graph materialization | `c_abi.zig:expandGraphJson` | Declares a root and typed child rows, resolves key dependencies, validates direct input bindings, computes graph digest, emits runnable waves. |
| Typed agency edges | `agency.zig` | Role/effect/cadence envelopes and allowed relationship kinds. |
| Dependency-ready leasing | `skill_execution/claim.zig` | Projects the admitted graph from the ledger and leases one ready wave with attempt/lease bounds. |
| Independent settlement | `skill_execution/settle.zig` | Validates ownership, attempt, declared evidence, dependency digests, and canonical Neuron decision before transactionally settling. |
| Append-only replay | `ledger.zig`, `skill_execution/common.zig` | Claims and settlements survive restart; nested transaction events fold into state. |
| Typed handoff | graph-node `input_bindings` | A node reads named evidence only from direct settled dependencies, replacing ambient “previous text.” |
| Merkle checkpoint | `collective_checkpoint.zig` | Deterministic, domain-separated tree and inclusion proofs for admitted object IDs. |

### 5. Rust host: graph composition and concurrent execution

| Primitive | Location | Exact behavior |
|---|---|---|
| Skill graph vocabulary | `contract_native/skill_registry.rs:SkillNode` | `depends_on`, `input_bindings`, effect/reversibility/evidence, `writes`, capability/research gaps, and witness. |
| Admitted connectome composition | `skill_registry/graph.rs` | Prefixes node identities, connects matched-limb roots/leaves to the core graph, and respects a 16-node budget. |
| Discovery as data | `graph.rs:inject_discovery_nodes` | Deduplicates capability/research questions into explicit artifact-producing dependency nodes; never auto-installs. |
| Native graph expansion | `contract_native.rs`, `neuron_bridge.rs` | Crosses the Contract C ABI rather than maintaining a host-only durable graph. |
| Real wave concurrency | `execute_claim_neuron_graph` | Executes all nodes in a leased wave with `join_all`, then settles each through Contract. |
| Witness-on-edge judgment | `settlement_rejection` | A claimed success is changed to retry when its declared command is red or its discovery artifact is invalid. |
| Attenuated subagent root | `delegate_subagent_root` | Gives fan-out workers bounded child authority rather than the parent root. |

## Exact gaps and contradictions

### P0 — the automatic graph verdict is not the execution graph

`contract/libcontract/src/graph_plan.zig` is a second, weaker planner beside `muscle.schedule` and Skill claim scheduling. It:

1. computes readiness, but does not emit Kahn `waves`;
2. greedily groups **all** pending nodes by shared dependency names, rather than walking frontiers;
3. treats siblings sharing a dependency as incompatible even though they become parallel in the same frontier;
4. ignores `writes`, `input_bindings`, `can_parallel`, effects, and capability budgets;
5. emits no `write_collisions`, `model_tiers`, or `cycle_list`;
6. does not reject unknown dependencies or cycles;
7. counts pending rows before validating required node fields, so malformed pending entries can leave allocated `NodeEntry` slots uninitialized;
8. assumes `nodes` is an array when the key exists instead of failing closed on the JSON type.

Meanwhile `contract_native.rs:5830+` tells the model that `waves` is executable and reads `write_collisions`, even though current `graph_plan.zig` cannot return either. The checked-in `witness-graph-frontier.sh` correctly detects this and is red. Its frontend targets, `aiko/apps/desktop/src/contract/{native,neurons}.ts`, do not currently exist.

### P0 — graph contracts are richer in Rust than at durable admission

`SkillNode` carries `writes`, `capabilities`, `research`, and `witness`, but:

- `aiko/.agents/contract-skill.schema.json` does not declare those fields;
- `expandGraphJson` journals dependencies/bindings/evidence but not write scopes, discovery metadata, or witness;
- `graph_plan` sees only `depends_on` and currently ignores even the `writes` copied into the host walk;
- `can_parallel` is present in the Rust manifest type but is not rendered into graph children or enforced by Contract.

Witness enforcement currently relies on the host rebuilding a `plan_index` from the live registry. Contract owns the lease and settlement, but does not durably pin the witness/discovery policy it expects the host to apply. Registry drift between expansion and settlement is therefore a split-source risk.

### P0 — Cell's documented graph behavior exceeds its runtime

- `run_composite` computes a topological order but fires nodes one-by-one. “sibling workers” describes topology, not concurrency.
- Validation checks wiring shape only; it does not mechanically enforce that every membrane input is consumed, every output has exactly one producer, endpoints/ports exist, or fan-in uses an explicit reducer.
- `_manifest_entry.cell` hashes the path and wiring, not the cell definition bytes; the composite manifest does not hash child manifests/digests. It is not the documented Merkle root of child code plus wiring.
- Composite manifest write failures are swallowed by `except Exception: pass`, allowing a successful run with missing provenance.
- `system/redrive` reads `prior_sent`, but `redrive.cell.yaml` does not declare that input. The direct-leaf gate passes because extra root inputs are not rejected; a composite cannot wire the value through its membrane, so case-3 compensation is not reusable as advertised.
- Cell redrive compares caller-supplied digests; it does not independently read back an external effect or create a durable compensation obligation.

### P1 — no shared graph interchange contract

Cell edges are `<organelle>.<port>`, Neuron edges are citations plus `produced_by`, Contract edges are row IDs plus `input_bindings`, and the host analyzer consumes `{id, depends_on, writes, status}`. Conversions are implicit and incomplete. There is no versioned neutral envelope defining node identity, typed reads/produces/writes, dependency edge, effect class, witness, and settlement state across layers.

### P1 — root acceptance misses graph surfaces

Root `zig build gate` covers Neuron/Contract integration and redrive, but not:

- `cell/tests/gate.sh`;
- `aiko/scripts/witness-graph-frontier.sh`;
- `aiko/scripts/witness-meta-agent-neuron-graph.sh`;
- the real Contract dylib ↔ desktop binding.

The Rust host is intentionally outside the root Zig build for resource reasons. That is reasonable, but it requires an explicit separate acceptance aggregate; otherwise “root green” can coexist with a red production graph path.

### P1 — the new Cell hooks are not a scheduler or settlement proof

The untracked `fractal-grind.sh` builds only the first 100 discovered cell files, compiles some inline Python, and checks one example pipeline. It does not walk graph frontiers, verify declared witnesses per node, validate the manifest Merkle, or prove compensation. The reuse radar is useful authoring steering, but heuristic similarity must never become admission authority.

## Forbidden dependency directions

These constraints are architectural, not optional cleanup:

1. **Never make `neuron/` import or require `contract/` or the Rust host.** Contract may import the shared typed-Neuron module; Neuron standalone build/test is the handoff evidence.
2. **Never move durable truth into Cell or the Rust host.** Contract remains the interpreter/ledger for leases, authoritative evidence, occurrences, and settlement. Host and Cell may project or execute, not create a competing ledger.
3. **Never make Contract depend on Cell's Python/YAML runtime or desktop code.** If vocabulary is shared, place a small versioned schema at the seam and implement it independently; do not call upward.
4. **Never make observation decide effect safety.** Neuron telemetry cannot classify topology it does not open; graph UI/analyzers must distinguish visible provenance from Contract/Neuron execution verdicts.
5. **Never infer an edge from prose or order.** A dependency must carry declared data (`input_bindings`/typed ports/citations). “Then” is not an edge.
6. **Never parallelize overlapping effects in one workspace merely because dependencies are disjoint.** Write/effect collisions require isolation and an explicit reconcile node.
7. **Never put nondeterministic producers on a recompute path.** Models belong at terminal edges or behind a pinned cache/artifact; otherwise invalidation has no termination proof.
8. **Never refire a node that already crossed an external boundary.** Emit a compensation obligation grounded in before/after evidence.
9. **Never let a producer self-certify settlement.** Named evidence and runnable witnesses must be pinned at admission and judged at the settlement edge.

## File-level change plan

### Phase 0 — make the checked-in graph witness honest and green

1. **Unify analysis with the real scheduler.** Introduce a small pure DAG kernel in `contract/libcontract/src/` (or extend `muscle.zig`) that validates node IDs/dependencies, performs Kahn frontiers, reports cycles/unknown dependencies, and is reused by both `muscle.schedule` and `graph_plan.zig`. Do not maintain two topological algorithms.
2. **Rewrite `contract/libcontract/src/graph_plan.zig`.** Parse fail-closed; emit `waves`, `ready`, `cycle_list`, honest `peak_parallelism`, and deterministic ordering. Add component-aware scope intersection for `writes` (path/glob semantics must be explicitly tested), collision pairs, and documented tier calculation. Analyze only runnable frontier peers, not arbitrary pending rows.
3. **Pin the C ABI.** Extend tests in `contract/libcontract/src/c_abi.zig` for waves, cycles, unknown dependencies, collisions, malformed JSON, deterministic ordering, and empty/single-node chains. Keep the ABI additive.
4. **Carry graph fields through admission.** Update `aiko/.agents/contract-skill.schema.json`, `aiko/crates/codegen/xai-grok-shell/src/contract_native/skill_registry.rs`, `skill_registry/graph.rs`, and `contract/libcontract/src/c_abi.zig` so `writes`, witness, and discovery policy are validated and digest-pinned with the admitted graph. Either remove `can_parallel` or enforce it; a decorative safety field is worse than none.
5. **Settle from pinned policy.** Update `contract/libcontract/src/skill_execution/{common,claim,settle}.zig` and the Rust `neuron_bridge.rs` types so the leased occurrence carries the admitted witness/discovery identity. The host may execute the check, but Contract must verify it corresponds to the admitted graph digest before accepting settlement.
6. **Finish or narrow the witness.** Implement `aiko/apps/desktop/src/contract/{native,neurons}.ts` and its tests if desktop-local planning is required; otherwise remove that duplicate planner requirement and bind the already-computed Contract verdict read-only. Then run `aiko/scripts/witness-graph-frontier.sh` end to end.

### Phase 1 — make Cell mechanically match its specification

1. In `cell/run.py`, centralize validated graph construction: validate port existence/cardinality, required membrane coverage, explicit reducer fan-in, duplicate edges, unknown organelles, and cycles before execution.
2. Execute each Kahn frontier concurrently only when caps/effects allow it; preserve deterministic result ordering and fail the whole frontier on ambiguous partial effects. Expose the frontier plan in build output for inspection.
3. Replace `_manifest_entry` with a canonical digest over cell definition bytes, normalized wiring, input digests, and child manifest digests. Never include an environment-specific absolute path in identity. Remove the swallowed manifest exception.
4. Add `prior_sent` (preferably a durable read-back/effect receipt object, not a bare digest list) to `cell/system/redrive.cell.yaml`; add a composite gate proving case 3 can traverse a membrane and never re-enters the stale set.
5. Upgrade `cell/tests/gates/manifest-merkle.sh`, `redrive-case3.sh`, and graph tests with falsifiers: mutate child code, delete a child manifest, introduce invalid fan-in, force same-wave writes, and prove the gate turns red.
6. Make `cell/hooks/fractal-grind.sh` call the canonical Cell gate/catalog without `head -n 100`; hooks should accelerate feedback, never define a weaker acceptance rule than CI.

### Phase 2 — define seams without reversing dependencies

1. Add a versioned, data-only graph envelope (recommended home: shared schema/reference directory, not executable runtime) with: `id`, `depends_on`, typed `reads`, `produces`, `writes`, effect class, determinism, witness identity, status, and evidence references.
2. Map Cell wiring to this envelope in Cell; map Contract Skill nodes/input bindings to it in Contract/host; map Neuron `produced_by`/citations to a read-only provenance projection. Do **not** make Neuron consume the task-DAG planner.
3. Document the mapping in `README.md`, `cell/SPEC.md`, `neuron/IMPLEMENTATION.md`, and `aiko/docs/CONTRACT-FRACTAL-CELL.md`, naming which layer owns declaration, firing, durable lease, external effect, invalidation, and settlement.

### Phase 3 — aggregate acceptance at the repository root

1. Add a resource-aware graph acceptance step in `build.zig` or a separate checked-in root script. It should run the standalone Neuron tests, Contract tests, Cell gate, meta-agent graph witness, graph-frontier witness, and a real ABI smoke test without pulling the full Rust test suite into `zig build`.
2. Add a cross-layer fixture that expresses one fan-out/reduce graph, executes it through Contract leases and the Rust host, records canonical Neuron decisions, mutates a cited source, and proves: safe recompute, red witness reopening, collision isolation, and case-3 compensation without re-send.
3. Only after that fixture is green should the automatic UI/model directive claim that Aiko is graph-engineering native end to end.

## Top risks

1. **False fan-out authority:** the host tells agents to use nonexistent `waves`/collision data from `graph_plan.zig`, which can cause unsafe concurrency or misleading UI.
2. **Split durable policy:** witnesses and discovery constraints are reconstructed from the live Rust registry rather than fully pinned in the admitted Contract graph.
3. **Cell provenance false confidence:** current manifests are not a child-code Merkle root, and manifest-write failure is ignored.
4. **Effect duplication:** Cell's advertised case-3 compensation is not wireable through its declared membrane and is not based on independent external read-back.
5. **Planner drift:** `muscle.schedule`, Skill claim readiness, Cell Kahn ordering, host wave execution, and `graph_plan.zig` can disagree because no shared pure DAG contract/gate ties them together.
6. **Acceptance blind spot:** root gates can remain green while the checked-in production graph-frontier witness is red.
7. **Concurrent-worktree collision:** active onboarding edits and changing lockfile/submodule state make broad graph patches unsafe without isolated worktrees and explicit reconciliation.
