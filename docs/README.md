# Documentation map

Code is the source of truth. Start with
[`SOURCE-OF-TRUTH.md`](SOURCE-OF-TRUTH.md) if a document disagrees with the
tree.

## Read first

| Audience | Document |
|---|---|
| Humans cloning the repo | [`../README.md`](../README.md) |
| Agents on turn one | [`../CLAUDE.md`](../CLAUDE.md) |
| What exists vs what is unpublished | [`SOURCE-OF-TRUTH.md`](SOURCE-OF-TRUTH.md) |
| Product north star (user path) | [`../aiko/docs/GOAL.md`](../aiko/docs/GOAL.md) |
| Rust host field guide | [`../aiko/docs/REPOSITORY-GUIDE.md`](../aiko/docs/REPOSITORY-GUIDE.md) |

## Layers

| Layer | Human README | Normative / implementation |
|---|---|---|
| Neuron | [`../neuron/README.md`](../neuron/README.md) | [`../neuron/AGENTS.md`](../neuron/AGENTS.md), [`../neuron/IMPLEMENTATION.md`](../neuron/IMPLEMENTATION.md) |
| Contract | [`../contract/README.md`](../contract/README.md) | [`../contract/DOCTRINE.md`](../contract/DOCTRINE.md) |
| Cell | [`../cell/README.md`](../cell/README.md) | [`../cell/SPEC.md`](../cell/SPEC.md) |
| Rust host | [`../aiko/README.md`](../aiko/README.md) | [`../aiko/docs/README.md`](../aiko/docs/README.md) |

## Cross-cutting

| Document | Purpose |
|---|---|
| [`AI-FORWARD-DEPLOYED-ENGINEER.md`](AI-FORWARD-DEPLOYED-ENGINEER.md) | Product boundary: Proven / Designed / Absent |
| [`AIKO-WORKFLOW-BINDING.md`](AIKO-WORKFLOW-BINDING.md) | Smithers controls, Cell describes; no second scheduler |
| [`../sdk/registry/stack.lock.json`](../sdk/registry/stack.lock.json) | Compatible layer versions and ABIs |
| [`graph-engineering/README.md`](graph-engineering/README.md) | Chain-vs-graph planning; `aiko-doctor graph-plan` |
| [`providers/README.md`](providers/README.md) | BYOK / provider gateway |
| [`../CONFORMANCE.md`](../CONFORMANCE.md) | Gate-backed architecture verdicts |
| [`../VISION.md`](../VISION.md) | Requirements and deletions (still current intent) |
| [`../PLAN.md`](../PLAN.md) | **Historical** on-chain commons plan — not a worklist |
| [`../PLAN-aiko-convergence.md`](../PLAN-aiko-convergence.md) | **Historical** convergence plan — T1–T4 already landed |

## Open-source files

| File | Purpose |
|---|---|
| [`../LICENSE`](../LICENSE) | Apache-2.0 |
| [`../NOTICE`](../NOTICE) | Attribution and third-party notices |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | How to change this tree |
| [`../SECURITY.md`](../SECURITY.md) | Private vulnerability reports |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Conduct bar |

Do not place customer operational data in this repository.

- [`AIKO-HOYSAN-BENCHMARK.md`](AIKO-HOYSAN-BENCHMARK.md) — synthetic Aiko→Cell→Aiko benchmark and honest Smithers blocker.
