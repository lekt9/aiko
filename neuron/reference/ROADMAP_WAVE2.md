# Roadmap wave 2 — energy router, fan-out, telemetry-advisor

> **Historical.** Dated roadmap wave. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Status: SETTLED 2026-07-27 (jesus-ralph gate `bash tests/roadmap-wave2-gate.sh`)

Wave 2 covered R2a/R2b/R2c/R2e (energy-router completion), R3 (fan-out limb),
and R4 (telemetry-advisor loop). Each item settled through a runnable witness.

## Items settled

- **R2c · Zig EnergyRouterNeuron first-class build path.** Replaced hardcoded
  `std.testing.allocator` with struct field; wired into test suite (2 tests,
  leak-free). Contract: `c912a627`.

- **R2a · EnergyRouter wired into meta-agent router slot.** Replaced FixedNeuron
  `meta/router` with live `EnergyRouterNeuron` scoring 2 candidates. Meta-agent
  gate green (17 replayed firings). Contract: `79c795e4`.

- **R2e · Energy-router revoke/detach + GC.** Admitted energy-router Python
  package through `limb_ops`, lifecycle witness: admit → operate → duplicate
  suppression → revoke → detach → GC. Witness: `python3 limbs/energy-router/
  tests/lifecycle.py` PASS. Contract: `b91f037c`.

- **R2b · Energy-router benchmark deltas.** `firingEnergy` scorer vs
  random-choice baseline on 100 candidate sets: 74 energy wins, 0 baseline
  wins, 26 ties. Honest row in jespa ledger. Contract: `76f54e28`.

- **R3 · Fan-out limb package.** `limbs/fanout/` spawns N deterministic children
  with narrowed delegations. Conformance: 3 spawns, duplicate coordinator (3
  skipped, 0 committed), budget containment (20 > 8 fail-closed), lifecycle.
  Contract: `263cd9bc`.

- **R4 · Closed telemetry → policy-advisor loop.** `neuron telemetry project
  <state_dir>` projects firing records into a deterministic rollup. Witness
  asserts: fields match state, determinism, read-only. Contract: `b1e8186d`.

## Standing gates

All green: `zig build test` 85/85, `zig build`, `bash tests/runtime-gate.sh`,
`bash tests/gate.sh`, `bash tests/meta-agent-gate.sh`. Jespa: 3 benchmarks
reproduced.

## Remaining from wave scope

- R2d (Registry Neuron over mesh) — deferred to wave 3 (infra-dependent).
- R3 pipeline sibling — deferred to amen cycle.
