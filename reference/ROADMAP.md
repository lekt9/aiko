# Typed Neuron roadmap

Status: core items settled as of 2026-07-27; six infrastructural gaps remain
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

## Settled 2026-07-29 — bidirectional neuron communication (§10.1, SMP-33)

Communication was one-way: a `send` reached a target, but the message carried
no sender and no return path, so a Neuron could only be answered by a peer
that had been wired to it in advance.

Every message now carries an **interpreter-stamped envelope** — `from`,
`correlation`, `reply_to`, `turn`. A Neuron chooses only the `correlation`;
presenting its own `from`, `reply_to`, or `turn` is rejected `ForgedSender`
before any effect exists. **Reply authority is conferred by possession of the
request**: answering the attested `reply_to` on that request's correlation is
authorized by the request itself, so a Neuron holding *no send capability*
can answer whoever asked it and reach nobody else.

Bounded like every other cycle: a Neuron parks on `reply/<correlation>` and
the pump holds unrelated traffic while it is parked; an unanswered park
surfaces as pending; one firing answers a conversation once
(`DuplicateReply`); and `Budget.max_turns` caps the exchange
(`ConversationTurnsExceeded`), narrowing-only under delegation.

Carried through every boundary: the runtime valve, the durable journal and
snapshot (a conversation's return path survives restart and compaction), the
pump, the external script-neuron protocol, and signed mesh envelopes (where
`correlation` and `turn` are covered by the peer signature and the return
path is the verified peer device, never a self-declared frame identity).

Witnesses: `zig build test` 100/100 (was 85 — six new conversation tests);
`python3 limbs/conversation/tests/conformance.py` PASS (14 checks, each a real
`neuron limb ...` command against a durable substrate, across separate
processes); `bash tests/conversation-gate.sh` PASS. Falsifiers proven, not
merely asserted: an adversarial `forger` neuron bypasses the Python SDK to
assert its own provenance while holding a *full* send grant and is rejected
all three ways; a one-way message confers no reply authority; a conversation
past its ceiling fails closed; a parked conversation is not consumed by
unrelated traffic — with a journal-count assertion that all five rejected
firings committed nothing.

The canonical package digest moved (`src/wire.zig` changed), so the generated
bindings and content pins were regenerated across neuron, contract, and aiko.
`SCHEMA_DIGEST` is unchanged: the transport schema itself was not touched.

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
| `limbs/introspection/` | Self-aware inspection: capability map, gap analysis, promotion, limb generation |
| `limbs/pipeline/` | Pipeline stage neuron with in-flight budget + conformance |
| `limbs/introspection/tests/conformance.py` | Introspection limb lifecycle witness |
| `limbs/pipeline/tests/conformance.py` | Pipeline limb lifecycle witness |
| `limbs/conversation/` | §10.1 bidirectional communication limb: asker, responder (no send caps), adversarial forger |
| `tests/conversation-gate.sh` | Bidirectional communication gate |

### Standing gates

All items gated by `zig build test` (100/100), `zig build`, `bash
tests/runtime-gate.sh`, `bash tests/gate.sh`, `bash tests/meta-agent-gate.sh`,
`bash tests/conversation-gate.sh`.
Jespa benchmarks: 3 reproduced (agents-contract-discrimination,
zig-runtime-claimed-safety-tasks, energy-router-discrimination).

## Settled 2026-07-30 — derivation-graph observability (§28.1–28.4)

`src/observability.zig` was 46 lines of counters called only from
`meta_agent.zig` and the tests; `mcp.zig` and `node serve` emitted nothing.
Commit records carried no timing and, more importantly, no evidence — so
`produced_by` gave `artifact → firing` but `firing → sources` was
unrecoverable, and the derivation graph could not be reconstructed at all.

Commit records now carry `evidence[]`, `now_ms`, and `committed_at_ms`, all
additive under `ignore_unknown_fields` so journals replay in both directions.
Two projections read the raw log without taking the substrate's exclusive
lock, so a live node can be inspected while it runs: `neuron telemetry trace`
(per firing — when it settled, what it cited, what it wrote) and
`neuron telemetry stale` (artifacts derived from a source that has since been
rewritten, ordered by journal position alone so the projection needs no clock).

Two invariants were discovered by getting them wrong first, and are now
normative:

- **Timing MUST live outside the firing identity (§28.1).** `now_ms` is hashed
  into the decision digest by `cborRuntimeStimulus`, so a wall clock in the
  stimulus gives every redelivery a new identity and turns idempotent replay
  into `FiringMismatch`. The `now_ms = 0` throughout `agent_ops.zig` is
  load-bearing. Duration comes from `committed_at_ms`, on the record.
- **The re-derivation gate is `outbox/`, not "sent anything" (§28.3).** Every
  message in an ordinary agent run goes to `event/…` — internal settlement
  events. Gating on `messages.len == 0` marked every agent firing undrivable.
  What disqualifies a firing is crossing an *external* boundary.

Detection stays separate from action: both projections mark nothing and re-fire
nothing.

Witnesses: `zig build test` PASS; `agent-entrypoint`, `universal-interface`,
`runtime`, `multi-machine-agent`, `interface-morphogenesis`, `conversation`,
and `remote-interface-chain` gates PASS; `check_agents.py` and
`check_super_meta_patterns.py` PASS with §28.1–28.4 registered in the catalog.

## Settled 2026-07-30 — derivation-graph retention across compaction (§28.4)

The limitation recorded above is closed. `compact` had folded away evidence and
timing, so both projections went blind on any compacted node — which would have
made the re-derivation loop stop invalidating silently rather than fail closed.

Evidence and a commit ordinal now cross the fold; a wall clock does not. The
ordinal turned out to be the load-bearing half and was not in the original
plan: canonical form sorts firings by id (§19), destroying the log order that
staleness is *defined* on, so carrying citations without carrying `seq` yields
comparisons that cannot be made. `FiringRecord` gained both, which also ended
its life as plain-old-data — `Substrate.deinit` now frees values, and the
runtime duplicates citations *above* the commit path's infallible section,
where allocation is forbidden.

Three defects surfaced only under a mixed journal — a snapshot with fresh
commits on top, which is what every compacted node becomes: one cited source
retained per firing instead of all; superseded artifact versions reported as
stale when they are merely gone; and ordinals restarting at zero after a fold,
colliding with folded firings. The second was a pre-existing defect in the
un-compacted path, invisible until the snapshot path — which structurally
cannot report superseded versions — disagreed with it.

What is deliberately not retained is reported, never fabricated: `redrivable`
is `false` after compaction because per-firing messages are gone and a wrong
`true` repeats a real external effect; `trace` reports `timing: "unavailable"`
rather than `0`, which already means "no caller set a clock".

Witness: `tests/observability-retention-gate.sh`, proven to fail closed by
removing the feature and confirming it caught the removal on the assertion it
was written for. Stale answers are identical across all four shapes a live node
takes. `zig build test` PASS; **all 17 gates** in `tests/` PASS; both doc gates
PASS.

Measured cost, because the first measurement answered the wrong question. An
early estimate put evidence at 0.0–10.8% of *commit* bytes, which says nothing
about what a snapshot carries. Measured against the snapshot on an eight-goal
agent node: evidence is 11.6% and the ordinal 0.8%, so retention costs **12.4%
of the snapshot**, and compaction saves 13% where it would otherwise have saved
roughly 23%. Retention therefore consumes about half the benefit of compacting
this workload. The tradeoff is deliberate — the alternative is a projection
that goes blind — but it is workload-dependent: evidence is a prose claim per
firing, so it dominates where artifacts are small and vanishes where they are
large (0.0% on a limb node holding 33KB artifacts). Deployments that compact
for space rather than for replay speed should measure their own ratio.

## Remaining (not started)

### R10. Invalidation-driven re-derivation

Steps 1–2 and the retention gap are shipped above. Remaining:

1. **Act on `redrivable: true`** — re-fire under a *new* firing id with a
   generation bound. Safe only where the boundary is deterministic: a
   non-deterministic producer re-derives a different answer, invalidates its
   own dependents, and never reaches a fixpoint. Determinism is the
   termination proof, not merely a safety preference.
2. **Escalate `redrivable: false` to an agent** — an agent is three writes
   (`initAgentCore`: manifest, snapshot 0000, active pointer), so any neuron
   with the right write prefix can create one. No new machinery required.

The shape: *not every neuron is a task; every neuron that cannot settle
mechanically is.* The neuron is the unit of commitment, the agent the unit of
resolution when commitment cannot be computed. `AcceptancePredicateRequired`
already draws that line.

### R11. Multimodal grounding at the LLM edge

The substrate is already binary-safe — a real PNG (NUL, `0xFF`, newline bytes)
round-trips byte-identical through a process boundary, the determinism battery,
the worker stage, and the journal, and the image's sha256 *is* the agent's
`result_digest`. The gap is entirely presentation:

1. **`read_prefix` on the MCP ceiling** — currently `{allow_write, allow_send,
   allow_spawn, write_prefix}` with no read scoping. Must land *before* a read
   tool, or the stdio edge exposes the whole substrate.
2. **A read tool + typed content blocks** — `tools/list` exposes only
   `neuron.info` and `neuron.fire`, so an LLM cannot read an artifact back at
   all. `toolResult` hardcodes `{"type":"text"}`; MCP already specifies
   `{"type":"image","data":"<base64>","mimeType":…}`.
3. **`--media-type` on the interface manifest** — declared before any bytes
   exist and folded into the manifest digest, so a boundary that changes output
   type changes identity. Not on the write: a neuron must not assert its own
   output type, for the same reason provenance is interpreter-owned.
4. **Perceptual acceptance predicates** — the only part needing real design.
   Screenshots are not deterministic (timestamps, antialiasing, animation), so
   they fail the determinism battery and require a predicate. `Acceptance.holds()`
   takes bytes; perceptual comparison is the substantive work.

The payoff composes with §28.2 for free: an LLM claiming "the button is red"
must cite the screenshot artifact, and `groundedRead` checks the digest still
matches. Visual claims become falsifiable against pinned pixels.

### R12. Typed precedent for pattern neurons

`patternSuccesses()` already reads prior verified results for one gap and
refuses to inherit a ranking earned by a different interface. Generalizing it
is sound because grounding makes precedent *checkable* — a cited record must be
a grounded read at a matching digest, so "I did X before" is evidence rather
than recall, and `telemetry stale` flags it automatically when it moves.

The constraint that must govern the design: **every context read enlarges the
read-set, and the read-set is the staleness surface.** A neuron reading fifty
prior records is stale whenever any of the fifty moves; done broadly, the
system invalidates constantly and converges never — the same fixpoint failure
as a non-deterministic producer, reached from the other direction.

So relevance MUST be typed (records *for this gap*), never similarity-ranked.
A similarity judgement inside the read-set is exactly the unpinnable authority
the admission model refuses everywhere else.

The following gaps are known and queued for infrastructure work:

- **Cross-machine artifact sync** (§22). A1 is single-node by design;
  mesh partitions don't converge. Needs a partition-aware mesh transport
  layer before the eventual-visibility story can be built.
- **Distributed cache dedupe** (§25). Content-addressed firing cache is
  per-process; mesh-wide reuse requires a network-level cache protocol
  and cross-node identity agreement.
- **Contract-native automatic mesh formation** (§26.1). The current mesh is
  address-directed transport. It does not yet exchange signed `NodeClaim`
  artifacts, maintain expiring `PresenceLease` records, mutually admit
  `EdgeContract` digests, converge `TopologyManifest` versions, or route from
  eligibility-filtered relative awareness. This must be an admitted
  `mesh-topology` limb, not new kernel policy, and requires a two-machine
  claim → lease → edge → route → expire → reconcile → retire witness.
- **Automatic Pattern Registry Neuron** (SMP-29). `AGENTS.md` and
  `reference/SUPER_META_PATTERNS.md` provide the governed document registry,
  but no admitted runtime Neuron yet consumes a typed six-interrogative work
  root, matches compatible pattern records, rejects ineligible records, reuses
  an admitted pattern, or emits `PatternGap` on a miss. Its witness must prove
  both match and gap paths without authority gain.
- **Universal interface membrane** (§17.3, plan Phases 3–7).
  `reference/AGENT_ENTRYPOINT_UNIVERSAL_INTERFACE_PLAN.md` defines the full
  `neuron interface ...` lifecycle for anything with a callable or observable
  boundary: code, libraries, binaries, stores, APIs, protocols, models,
  devices, humans, remote Neurons, and optional paid resources.

  Phase 1 settled 2026-07-29: `neuron agent init|run|inspect|cancel|retire`
  initializes and runs a logical agent without Aiko through the composed stage
  network with settlement-event grounding, witnessed by
  `bash tests/agent-entrypoint-gate.sh`.

  Phase 2 settled 2026-07-29: `neuron.interface-manifest/v1` plus
  `discover|describe|test|admit|attach|detach|revoke|call|dispatch|list` in
  `src/membrane.zig` and `src/membrane_ops.zig`, with pure-function, process,
  and filesystem adapters, structural read/command classification, derived
  least-authority attachment grants, outbox-committed commands settled by
  independent read-back, and an agent whose work slot routes through a real
  attached boundary. Witnessed by `bash tests/universal-interface-gate.sh`.

  Still open: library/WASM and database adapters; process *commands*, which
  fail closed as `UnverifiableCommand` until a phase brings independent
  sensors; multi-hop chaining of several boundaries inside one goal (the agent
  has one `worker` and one `effector` slot); and unifying the existing
  script/limb package path under `InterfaceManifest` — both membranes admit by
  digest through the same valve, but a limb is still described by
  `typed-neuron.limb-manifest/v1`. The next witness must chain local code →
  process → HTTP → MCP → verifier in one goal without bypassing Caps,
  admission, outbox, evidence, or settlement.
- **Agentic Organism behavioral benchmark runner** (§31–§32).
  `bench/agentic-organism/benchmark.json` now defines 48 real-world prompts
  across twelve domains, three paired trials, twelve adversarial stressor
  families, six score dimensions, independent judging, evidence minimums, and
  catastrophic hard failures. Four cases (AO-01, AO-09, AO-12, and AO-31) now
  have deterministic red fixtures and execute through Aiko's installed public
  CLI with post-exit hidden evaluators, immutable run reports, an append-only
  run/correction ledger, and a durable opened/resolved improvement stream.
  This is pilot evidence only: the other 44 fixtures, all 144 scheduled trials,
  paired baselines, independent judge invocations, aggregate uncertainty, and
  complete honest reporting remain unsettled.

## R6. Standalone durability and isolation

Status: intentionally outside the reference runtime (Contract/Aiko is the
current production profile). Do not build a second durable adapter without
a specific deployment need. If one is built, it must import the same
canonical module, pass the production drift guard, and publish its own
atomicity/crash/reconciliation witnesses.
