# CLAUDE.md — aiko

Session context for this repository. `README.md` is the human-facing document;
this file is what an agent needs on turn one.

## What this is

**Aiko** is a meta-fractal harness, exposed as an MCP, mounted inside Hermes.
It is assembled from two Zig layers with a deliberate one-way dependency:

```
aiko  (root build → zig-out/bin/aiko)
  ├─ neuron/    the firing primitive, the membrane, the served `port` surface,
  │             and `redrive`. Standalone: NO runtime dependency on contract.
  └─ contract/  the durable interpreter: append-only ledger, W6H, occurrence
                invalidation, validity windows, cadence.

aiko/           the Rust host. Present, NOT in the Zig build — see below.
```

**Never reverse that direction.** neuron building and testing *without* contract
is the mechanical evidence that a delivered system survives Aiko being
unavailable or handed off. That is a contractual condition, expressed as an
architecture rather than a promise. Fusing the trees deletes the evidence to
solve a problem that does not exist — they already share one repository.

It is spelled **Aiko**. Meeting notes and transcripts say "Ico"; that is a
transcription artifact.

## Build and verify

```sh
zig build                 # → zig-out/bin/aiko  AND  contract/libcontract/zig-out/lib/libcontract.a
zig build test            # both layers' suites
zig build gate            # the runnable witnesses — THIS is the acceptance criterion
./zig-out/bin/aiko-doctor # prove both layers are linked in one process
```

**Gates are the acceptance criterion, not the unit tests.** Each gate drives the
public CLI from an empty directory and asserts against durable state — never
stdout resemblance. If you change behaviour, the gate is what proves it. Never
write a gate that can pass without the feature working: prove it by removing the
feature and confirming the gate catches the removal.

## The one idea, if you read nothing else

Every mechanism here is one refusal wearing different clothes: **refuse to claim
something happened when it didn't.**

| Mechanism | What it refuses |
|---|---|
| W6H (`contract/libcontract/src/w6h.zig`) | a row that cannot answer who/what/when/where/why/how — the write fails, naming the missing one |
| admission by digest | code not pinned to bytes that existed before the pin |
| outbox + independent read-back | settling an external effect on the sender's word |
| evidence grounding | a claim that cannot cite the stimulus, a message, or a pinned read |
| "nothing retained on compilation alone" | a generated limb that compiled but never satisfied its gap |
| `redrive` case 3 | re-crossing a boundary already crossed |

This is why it can reduce setup: not by magic self-configuration, but by making
"done" mechanically checkable, so re-checking stops being rational.

## Reactive: the invalidation loop

The system is event-driven in one specific sense — a node re-fires when the
thing it was derived from moves.

```
contract   a new occurrence INVALIDATES the resolved contract, and its dependants
              ↓
neuron     `telemetry stale` reconstructs the derivation graph from `produced_by`
           plus each firing's cited `evidence[].sources`
              ↓
`aiko redrive <state_dir>` classifies every stale row into exactly three cases:

  redrivable:true                  → re-fire under a NEW firing id
  false, nothing crossed           → open an agent goal (an agent is three writes)
  false, ALREADY SENT to outbox/   → CompensationGap. NEVER re-fired.
```

The third case is the one that matters in production and the one most designs
lack. Re-firing "notify 35 workers" after an amendment re-messages the 31 who
did not change and still fails to tell the 4 who did. Compensation diffs the
superseded product against the new one and acts on the delta only.

**Two constraints follow, and they bind anything built on this:**

1. **A producer on the recompute path must be deterministic.** A
   non-deterministic producer re-derives a different answer, invalidates its own
   dependents, and never reaches a fixpoint. Determinism is the termination
   proof, not a preference. Put models at the edges — OCR, message wording,
   exception summaries — never on the recompute path.
2. **A firing is invisible to invalidation unless it cites its sources.**
   Staleness is reconstructed from citations. An uncited read is a dependency
   that does not exist as far as the loop is concerned.

## Self-wiring and self-writing

Both exist and are gated. They are not the same thing and are not yet joined.

- **Self-wiring** — `morphogenesis.zig`: a `CapabilityGap` is closed by
  discovering a boundary that already declares a schema, deriving an inert
  manifest, testing, admitting, attaching, retrying on the real path, judging.
  Witness: `interface-morphogenesis-gate.sh`, `self-constructing-agent-gate.sh`.
- **Self-writing** — the Meta-Agent path: a limb is *written inert*, admitted by
  digest, attached, used, revoked, detached, collected. Witness:
  `meta-agent-gate.sh` asserting `generated_limb_attached`.

The invariant is **not** "never write code". It is *write inert → admit by digest
→ never retain on compilation alone.* Generation and admission are separate
firings, so generated bytes exist before their own pin.

**The open gap:** nothing takes a gap and *writes a handler for it*. If no
boundary out there satisfies a gap, the loop retires it rather than authoring
what would close it. See `PLAN-aiko-convergence.md` (T2).

## Traps that have cost real time

- **`now_ms` is inside the firing identity.** A wall clock in a stimulus makes
  every redelivery a new identity and turns idempotent replay into
  `FiringMismatch`. The `now_ms = 0` in `agent_ops.zig` is load-bearing; timing
  lives on the journal record (`committed_at_ms`), outside identity. This is why
  the bridge carries a **commit ordinal**, not a clock.
- **Zig 0.16 API drift.** `std.process.argsAlloc` and `init.env` do not exist —
  use `std.process.Args.Iterator.initAllocator(init.minimal.args, a)` and
  `init.minimal.environ`. Both were invisible from reading and only appeared on
  `zig build`.
- **macOS-verified is not Linux-verified.** Two bugs shipped that way: `build.zig`
  never called `linkLibC` while `mesh.zig` used `std.c.fcntl`, and `limb_ops.zig`
  opened `schemas/` without `.iterate` so every package with that directory
  panicked `BADF`. Both were invisible on macOS.
- **A dependency's install step is a no-op in dependency context.**
  `dep.builder.getInstallStep()` compiles, depends cleanly, and builds nothing.
  The sub-builds are driven as system commands because that is the version that
  actually rebuilds. Falsifier: delete `contract/libcontract/zig-out`, rebuild,
  check it came back.
- **`artifact("contract")` panics** — libcontract publishes both a static lib and
  a dylib under that name.

## House style

Match the surrounding code. Comments explain *why a refusal exists*, not what a
line does — keep that. Prefer failing closed over degrading. Do not report work
as done without running its gate.

## Where the doctrine lives

| Document | Authority |
|---|---|
| `neuron/AGENTS.md` | normative architecture (~85KB — read the section, not the file) |
| `neuron/IMPLEMENTATION.md` | what exists today, code map, known limits |
| `neuron/reference/ROADMAP.md` | unsettled work only |
| `contract/DOCTRINE.md` | the substrate's doctrine and parity spec |
| `contract/docs/AGENCY-SUBSTRATE.md` | schema, migration, adversarial evidence |
| `PLAN-aiko-convergence.md` | risk-ordered remaining work (T1 done, T2–T4 open) |

`contract/NEVER-PUBLISH.md` applies: that subtree is closed-source. Do not paste
customer operational data (worker names, NRIC, rosters) into this repository —
it is not the place for it.
