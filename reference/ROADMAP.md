# Typed Neuron roadmap

Status: core items settled as of 2026-07-27; two infrastructural gaps remain
(see §Remaining).

`AGENTS.md` defines the target. `IMPLEMENTATION.md` records what exists.
Implementation antipatterns found in review on 2026-07-27 were remediated
in `reference/ANTIPATTERN_REMEDIATION.md` (durable substrate, per-peer
ceilings, wire symmetry, clock honesty, bounded reads, typed proxy payload,
hygiene — all struck as SETTLED).

## Settled since the previous roadmap

The following items are implemented and must not be planned again:

- Script-Neuron deadlines are enforced by the interpreter. A hung child is
  killed, recorded as `timed_out`, and commits no effects.
- The standalone runtime imports all canonical runtime types and identity
  algorithms from `typed_neuron`; it no longer owns a parallel contract.
- The transport schema generates Zig and Rust codecs, fixed vectors, and a
  Contract content lock.
- Production Aiko returns a canonical decision at node settlement.
- Contract atomically appends canonical firing, authoritative evidence, node
  settlement, and pending outbox effects in one transaction.
- Aiko admits consequential tool effects before adapter dispatch and settles
  the exact outbox effect afterward.
- The reference Meta-Agent demonstrates generated-limb admission, attachment,
  operation, judgment, retirement, and garbage collection.

## Settled 2026-07-27 — remediation + roadmap waves 1-3

Three jesus-ralph loops (wave 1: `tests/roadmap-wave1-gate.sh`, wave 2:
`tests/roadmap-wave2-gate.sh`, wave 3: `tests/roadmap-wave3-gate.sh`)
settled the following items. Each is backed by runnable witnesses and
contract tasks recorded in the `aiko` ledger; file presence and prose are
not completion.

### Wave 1 — journal compaction, daemon availability, outbox-drainer lifecycle

- **Substrate journal compaction/GC (§22).** `Substrate.compact()` folds the
  retention closure into a deterministic `snapshot` record, atomically
  replacing the WAL under the held exclusive lock. Rejection paths: torn
  snapshot, mid-log snapshot, out-of-range delivery index — all
  `error.CorruptLog`. Operator surface: `neuron compact <state_dir>`.
  Witnesses: 2 Zig tests (82/82), `tests/compact-witness.sh` PASS.
  Contract: `1f88eaec`.

- **Daemon head-of-line blocking / server-side read deadlines.**
  `tailnet.serve` serves each connection on its own thread with one
  absolute monotonic deadline per connection, a bounded in-flight cap,
  and commit-serialising mutex. A slow-loris peer can no longer wedge
  other peers. Witness: "slow-loris peer neither wedges the daemon nor
  outlives its connection budget" — 83/83 tests. Contract: `dcdfba9f`.

- **Outbox-drainer generative-limb lifecycle (R1, §30).** `src/limb_ops.zig`
  implements the harness admission boundary: `computePackageDigest`,
  `admit` (idempotent), `limbRun` (digest-pinned, admitted caps, drift
  fail-closed), `revoke`, `detach` (journaled GC via `op:"gc"`), `inspect`.
  CLI: `neuron limb admit|run|revoke|detach|inspect`. Witness:
  `python3 limbs/outbox-drainer/tests/lifecycle.py` PASS (admit → operate
  → duplicate suppression → FiringMismatch → revoke → detach → GC).
  Contract: `ffbd8aa7`.

### Wave 2 — energy router, fan-out, telemetry-advisor

- **Zig EnergyRouterNeuron first-class build path (R2c).** Replaced
  hardcoded `std.testing.allocator` with a struct field; wired into
  `zig build test` (2 energy-router tests pass, leak-free). Contract:
  `c912a627`.

- **EnergyRouter wired into meta-agent router slot (R2a).** Replaced
  FixedNeuron `meta/router` with the live `EnergyRouterNeuron`, scoring
  two candidates from meta-agent context. Meta-agent gate green (17
  replayed firings). Contract: `79c795e4`.

- **Energy-router revoke/detach + GC (R2e).** Admitted energy-router
  Python package through `limb_ops`, operated, duplicate-suppressed,
  revoked, detached, GC'd. Witness: `python3 limbs/energy-router/tests/
  lifecycle.py` PASS. Contract: `b91f037c`.

- **Energy-router benchmark deltas (R2b).** `firingEnergy` scorer tested
  against random-choice baseline on 100 synthetic candidate sets: 74
  energy wins, 0 baseline wins, 26 ties. Honest row in jespa ledger.
  Witness: `python3 bench/energy-router-delta.py` PASS. Contract: `76f54e28`.

- **Fan-out limb package (R3).** `limbs/fanout/` Python ScriptNeuron
  spawns N deterministic children with narrowed delegations. Conformance
  witness covers: 3 spawns committed, duplicate coordinator (3 skipped,
  0 committed), budget containment (20>8 fail-closed), admit→operate→
  revoke→detach→GC. Witness: `python3 limbs/fanout/tests/conformance.py`
  PASS. Contract: `263cd9bc`.

- **Closed telemetry → policy-advisor loop (R4).** `neuron telemetry
  project <state_dir>` projects firing records into a deterministic
  rollup artifact. Witness asserts: fields match committed state,
  identical substrates produce identical projections (determinism),
  read-only (projection never mutates history). Witness: `bash
  tests/telemetry-advisor-witness.sh` PASS. Contract: `b1e8186d`.

### Wave 3 — source pin, registry neuron

- **Immutable source dependency pin (R5).** Git commit hash embedded at
  build time via `build.zig`, exposed via `neuron --version`. Lock file
  `typed-neuron.lock.json` pins the sibling package content digest.
  Witness: `bash tests/source-pin-witness.sh` PASS. Contract: `a6b9a004`.

- **Registry Neuron over mesh (R2d).** `limbs/energy-router/neurons/
  registry_lookup.py` fired through the admitted path with seed index
  reads. EBM-ranked discovery: 3 compatible offers found, 1 irrelevant
  filtered, deterministic output. Witness: `python3 limbs/energy-router/
  tests/registry_witness.py` PASS. Contract: `39382bec`.

### New files introduced

| File | Purpose |
|------|---------|
| `src/limb_ops.zig` | Harness admission lifecycle |
| `src/energy_router.zig` | Zig EnergyRouterNeuron (refactored) |
| `limbs/outbox-drainer/tests/lifecycle.py` | R1 generative-limb witness |
| `limbs/energy-router/tests/lifecycle.py` | R2e revoke/GC witness |
| `limbs/energy-router/tests/registry_witness.py` | R2d registry witness |
| `limbs/fanout/` | R3 fan-out limb package |
| `bench/energy-router-delta.py` | R2b benchmark |
| `tests/compact-witness.sh` | W1 operator witness |
| `tests/telemetry-advisor-witness.sh` | R4 projection witness |
| `tests/source-pin-witness.sh` | R5 source pin witness |
| `tests/roadmap-wave1-gate.sh` | Wave 1 jesus-ralph gate |
| `tests/roadmap-wave2-gate.sh` | Wave 2 jesus-ralph gate |
| `tests/roadmap-wave3-gate.sh` | Wave 3 jesus-ralph gate |
| `typed-neuron.lock.json` | Immutable source dependency pin |
| `reference/ROADMAP_WAVE1.md` | Wave 1 witness-gated plan |

### Standing gates

All items gated by `zig build test` (85/85), `zig build`, `bash
tests/runtime-gate.sh`, `bash tests/gate.sh`, `bash tests/meta-agent-gate.sh`.
Jespa benchmarks: 3 reproduced (agents-contract-discrimination,
zig-runtime-claimed-safety-tasks, energy-router-discrimination).

## Remaining (not started)

The following gaps are known and queued for infrastructure work:

- **Cross-machine artifact sync** (§22). A1 is single-node by design;
  mesh partitions don't converge. Needs a partition-aware mesh transport
  layer before the eventual-visibility story can be built.
- **Distributed cache dedupe** (§25). Content-addressed firing cache is
  per-process; mesh-wide reuse requires a network-level cache protocol
  and cross-node identity agreement.

## R6. Standalone durability and isolation

Status: intentionally outside the reference runtime (Contract/Aiko is the
current production profile). Do not build a second durable adapter without
a specific deployment need. If one is built, it must import the same
canonical module, pass the production drift guard, and publish its own
atomicity/crash/reconciliation witnesses.
