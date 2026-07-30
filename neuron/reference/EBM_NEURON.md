# EBM Lens on Typed Neurons (Nested Micro-EBMs for Settlement and Recommendation)

**Status**: Diagnostic lens plus an experimental scorer. Not a new primitive
and not an admitted production routing policy.

This document translates the typed-neuron architecture (AGENTS.md) into Energy-Based Model (EBM) language while remaining strictly faithful to the single primitive and the existing control, effects, evidence, budgets, scheduler, and meta-agent decomposition. It identifies where explicit energy minimization can improve **neuron firing recommendation**, **action selection**, and **generation**, and how "small breaking sub-EBMs" are already mechanically supported.

## 1. Core Mapping (no new primitives)

A firing is a configuration search in an energy landscape.

- `Decision.control.continue_wait(predicate)` = local energy still high; sub-problem unresolved. The neuron is suspended until new evidence can lower the energy.
- `Decision.control.terminate(result)` = acceptable low-energy configuration reached and grounded; settlement.
- `Decision.control.branch(target)` = a lower valley is visible via another neuron; transfer.

Effects are the only way one EBM affects the landscape for others:

- `spawn` creates new micro-EBM instances (narrow specialist neurons or limbs).
- `write` emits content-addressed artifacts (new evidence that can resolve sibling or descendant EBMs).
- `send` delivers typed messages (the resolving signal).

Evidence + confidence_milli + grounding requirement = inverse energy signal. Every externally meaningful claim must be traceable to stimulus fields, permitted reads, or messages with digests. The harness rejects undeclared evidence. Weak confidence or missing provenance raises energy.

Budgets (Caps + WorkEnvelope) = explicit cost term in any energy function.

Scheduler progressDigest (receptor + depth + exact read digests + messages) enforces "no free energy reduction". Re-entry with identical measure is CycleWithoutProgress. Only new evidence that can plausibly lower energy allows re-evaluation.

## 2. Micro Breaking Sub-EBMs

The architecture and Meta-Agent witness support the following composition:

1. A neuron (or router) spawns a narrow specialist (micro-EBM) for a leaf work item.
2. The specialist returns `continue_wait` on its local predicate (high local energy, "broken").
3. Sibling or parent neurons work; when they produce the required artifact or message, the stimulus for the waiting neuron now contains new grounded evidence.
4. The progress measure changes → scheduler permits re-fire.
5. If the new evidence is sufficient, the specialist can now terminate (energy lowered to settlement threshold) or emit recovery.

Recovery neurons on red verification are exactly spawned sub-EBMs that stay unresolved until compensation or re-plan evidence arrives.

The frontier in the meta-agent snapshot is the global set of open high-energy subproblems.

No kernel change is required. The reusable Energy Router Skill which chooses
this shape dynamically is not yet complete.

## 3. Recommendation Becomes Explicit Energy Minimization

Current router/context/planner primarily use schema compatibility, explicit topology, heuristics, budget checks, and acceptance predicates.

An EBM-aware layer adds (or replaces part of) the selection with a scored energy:

```
E(candidate_firing) =
    λ1 * grounding_violations
  + λ2 * (1.0 - avg_evidence_confidence_milli / 1000)
  + λ3 * normalized_budget_cost
  + λ4 * settlement_distance (frontier distance to root predicate)
  + λ5 * (optional) manifold_or_fractal_geometry_penalty   # see M-EBM 2303.04343 and fractal energy carpets
  + ...
```

The router (or an EnergyRouter limb) can enumerate candidate next neurons/limbs/actions/generations, score them by predicted ΔE, and prefer the one expected to produce the largest drop (or best evidence/cost/settlement trade-off) while still satisfying schema and authority.

Context selection becomes "narrowest set of prior artifacts whose inclusion most reduces expected future energy of the planner/executor".

Generation (limb-designer, code emission, artifact write) is accepted only when the produced item, when read back with its provenance, measurably lowers energy for the dependent work items.

## 4. Relation to Existing Components

- `context` neuron already produces `ContextManifest` with inclusion reasons and digests. Adding per-item energy_delta or expected_energy_reduction is a natural extension.
- `router` already selects targets. Replacing or augmenting the selection heuristic with an energy scorer is the direct improvement for "recommend neurons to fire better".
- `planner` + `verifier` already require acceptance predicates. The predicate can be expressed as "energy below threshold after independent verification".
- JESPA structural energy (bench/jespa) is the same idea applied at the document/spec level: violation energy ranks faithful vs adversarial variants. The runtime can apply analogous structural energy over candidate decisions.

## 5. Generative Limb Target (per AGENTS.md §30)

A conforming `energy-router` limb would be:

- Describe: versioned NeuronDef that reads WorkItem + ContextManifest + Topology + prior EvidenceIndex, emits scored RouteChoice with energy components and rationale.
- Write: the implementation + schemas + tests as content-addressed artifacts.
- Admit: independent validation (including adversarial energy-scoring tests).
- Attach: least-authority grant, connected by typed edges from planner and to executor.
- Operate, Judge (compare against explicit acceptance evidence on energy reduction and settlement speed), Cache (content-addressed), Retire.

It remains an ordinary admitted neuron network. It does not become kernel.

The reference meta-agent can be extended (or a variant limb generated) to
insert an EnergyRouter between planner and router/executor.

A reference generative limb package now exists in `limbs/energy-router/`:
- `neuron.json` manifest + `neurons/energy_router.py` (full Neuron returning Decision with EnergyScore write + conditional spawn)
- Versioned schemas including `PackageOffer`, `Usage`, `SettlementClaim` for EBM-native paid mesh commons
- Harness execution via `neuron run --def` produces grounded decisions
- Pure scorers (`scorer.py`, `energy.zig`) + early Zig prototype remain

It is the concrete reference for structural-energy routing and sub-EBM spawning.
It is not yet wired into the meta-agent router slot, nor has it produced published
benchmark deltas on settlement tasks. See ROADMAP R2 for remaining work.

## 6. Benchmarking and Evaluation (JESPA spirit)

The existing agents-contract-discrimination and zig-runtime benchmarks remain the primary gates. Any EBM extension must not reduce their scores and should ideally add new witnessed properties (e.g., "energy-ranked routing produces lower settlement energy than schema-only routing on synthetic workloads" witnessed by a named test that constructs a small neuron graph, runs both policies, and asserts the energy delta).

Honest negatives are recorded when data or frontier teacher strength makes a win impossible for the current implementation.

See `bench/jespa/` for the ledger discipline: every attempt is a row; only reproduced wins (witness re-runs green now) count toward TARGET.

## 7. Sources and Prior Art (from prior search)

- M-EBM: "Towards Understanding the Manifolds of Energy-Based Models" (2303.04343) — manifold structure for training stability.
- "Fractal energy carpets in non-Hermitian Hofstadter quantum mechanics" (1504.02269) — real fractal energy spectra.
- LeCun latent-variable EBMs and JEPA papers — prediction in representation space (lower energy = better alignment).
- No prior packaged skill or paper implemented "one EBM per typed neuron with nested breaking sub-EBMs for substrate routing".

The diagnostic mapping is implemented in the standalone scorer; a faithful,
primitive-preserving admitted routing limb remains open work.

---

Grounding note: every claim above traces to AGENTS.md sections on Neuron/Decision/Effect/Evidence/Caps/Scheduler/Settlement/Generative Limbs (§2,3,19,20,23,25,26,30,31), the meta-agent reference, and the executable sources in src/ (scheduler.zig progressDigest, script.zig parseDecision + evidence, runtime.zig, caps.zig, limb.zig, meta_agent.zig, and the bench/jespa validators).
