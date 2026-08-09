# Aiko documentation map

**Read [the goal](GOAL.md) first.** Zero setup, one-shot prompts, native tooling,
Unbrowse for integration — nothing for the user to install. It is the north star
every change is judged against.

Then start with the [visual repository guide](REPOSITORY-GUIDE.md). It explains
the whole tree, runtime boundaries, data flows, persistent state, build outputs,
and the right place to make each kind of change.

## Product goal

| Document | Purpose |
|---|---|
| [The goal](GOAL.md) | North star: zero setup, one-shot prompts, internal tooling, Unbrowse integration, no user-installed skills/MCPs — and how it decides scope |

## Architecture and operations

| Document | Purpose |
|---|---|
| [Visual repository guide](REPOSITORY-GUIDE.md) | Repo-wide architecture, diagrams, ownership, code map, state, builds, and debugging |
| [Internal development](../CONTRIBUTING.md#internal-development) | Toolchain prerequisites, inner-loop commands, focused tests, formatting, and Contract task verification |
| [Photon / positron → Contract → EBM](PHOTON-POSITRON-CONTRACT-EBM.md) | Faithful physics map of the substrate: ledger as field, claim×check collisions, EBM as energy of verified work (canon in `Unbrowse/contract`) |
| [Photon / positron gaps](PHOTON-POSITRON-GAPS.md) | Gap register: built chamber vs depth/wiring/scale/containment/truth; priority 1–5 (canon in `Unbrowse/contract`) |
| [Photon / positron runtime](PHOTON-POSITRON-RUNTIME.md) | Waves, daemon-as-clock-hand, preempt; product plan [`plan3.md`](../plan3.md) |
| [Photon / positron first principles](PHOTON-POSITRON-FIRST-PRINCIPLES.md) | Full law set: fractal seal, duals catalog, composition, conservation (canon in `Unbrowse/contract`) |
| [Collective architecture plan](../plan-arch.md) | Contract-first decentralized protocol decisions and delivery phases |
| [Collective verification](collective-verification.md) | Executed acceptance tests and packaged artifact evidence |
| [Contract agency runtime](contract-agency-runtime.md) | Turn ledger, governed agency roles, grounding, and Contract packaging |
| [Contract as Neuron substrate](CONTRACT-FRACTAL-CELL.md) | Canonical Neuron ownership, Meta-Agent topology, ABI 13 graph abandonment and settlement, and tool-effect membrane |
| [Contract-native Skills](CONTRACT-NATIVE-SKILLS.md) | Skill discovery, immutable admission, script boundary, and generative-limb lifecycle |
| [Native application runtime](native-application-runtime.md) | Aiko-owned CDP/Electron observation and action layer |
| [Provider gateway](aiko-provider-gateway.md) | Model-provider request path and gateway behavior |

## Frontend integration

| Document | Purpose |
|---|---|
| [Native API guide](aiko-native-api.md) | Loopback discovery, authentication, ACP WebSocket, and HTTP examples |
| [OpenAPI schema](aiko-native-api.openapi.json) | Machine-readable native HTTP API |
| [Interface registry](aiko-native-interfaces.json) | Stable interface ownership and versions |
| [Native SDK](../sdk/aiko-native/README.md) | JavaScript/TypeScript client |
| [Generative UI](../apps/desktop/src/generative/README.md) | Safe JSON-driven desktop components |

## Fast routes

- To **install** Aiko (source, package, login, proxy), start with
  [Installation](../README.md#installation) and the docs witness
  `bash scripts/check-install-docs.sh`.
- To understand a prompt from keypress to model response, read
  [Turn lifecycle](REPOSITORY-GUIDE.md#turn-lifecycle).
- To understand how contracts spread between Aikos, read
  [Collective publication and replication](REPOSITORY-GUIDE.md#collective-publication-and-replication).
- To find a source file, use
  [Where to change what](REPOSITORY-GUIDE.md#where-to-change-what).
- To build installers, use
  [Build and packaging map](REPOSITORY-GUIDE.md#build-and-packaging-map).
