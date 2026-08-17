# CLAUDE.md — aiko

Session context for this repository. `README.md` is the human-facing document;
this file is what an agent needs on turn one. The published-tree inventory is
[`docs/SOURCE-OF-TRUTH.md`](docs/SOURCE-OF-TRUTH.md) — do not invent sibling
checkouts or unpublished paths. Public remote: `github.com/lekt9/aiko`.
License: Apache-2.0 (`LICENSE`).

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
zig build gate            # the distinct shell witnesses scheduled by root build.zig
                          # exact inventory below; THIS is the acceptance criterion
./zig-out/bin/aiko-doctor # prove both layers are linked in one process
```

The block below is generated from `build.zig` by
`scripts/gen-gate-inventory.py` — never hand-edit it.

<!-- root-gate-inventory:start -->
- `tests/aiko-self-check-gate.sh`
- `tests/graph-harness-main-path-gate.sh`
- `neuron/tests/published-interface-gate.sh`
- `neuron/tests/redrive-gate.sh`
- `neuron/tests/authored-gap-gate.sh`
- `neuron/tests/skill-doc-gate.sh`
- `tests/zig-doctrine-gate.sh`
- `neuron/tests/escalation-ladder-gate.sh`
- `neuron/tests/staffing-engine-gate.sh`
- `neuron/tests/claim-deadline-gate.sh`
- `tests/bridge-gate.sh`
- `tests/dispatch-gate.sh`
- `neuron/tests/interface-morphogenesis-gate.sh`
- `neuron/tests/meta-agent-gate.sh`
- `neuron/tests/self-constructing-agent-gate.sh`
- `tests/tick-gate.sh`
- `tests/graph-engineering-gate.sh`
- `tests/cross-journal-retention-gate.sh`
- `tests/no-duplicate-fde-primitives-gate.sh`
- `neuron/tests/product-forge-gate.sh`
- `tests/contract-library-pin-gate.sh`
- `tests/aiko-embedded-contract-gate.sh`
- `tests/contract-slim-ledger-gate.sh`
- `tests/layer-lock-gate.sh`
- `tests/docs-oss-ready-gate.sh`
- `tests/docs-quality-gate.sh`
- `tests/conformance-gate.sh`
<!-- root-gate-inventory:end -->

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
| `SKILL.md` (`neuron/src/limb_ops.zig`) | a package that cannot say what it is for, or whose declaration sits outside its own digest and is therefore free to drift |
| `redrive` case 3 | re-crossing a boundary already crossed |

This is why it can reduce setup: not by magic self-configuration, but by making
"done" mechanically checkable, so re-checking stops being rational.

## Layer lock

Cell computes. Smithers starts/pauses the Cell. A Worker projects the product.
Contract is the ledger. **Never** `POST /api/smithers/run` that does the math,
and **never** label that handler `aiko-flow-local`. Witness: `tests/layer-lock-gate.sh`.

## Reactive: the invalidation loop

The system is event-driven in one specific sense — a node re-fires when the
thing it was derived from moves.

```
contract   a new occurrence INVALIDATES the resolved contract, and its dependants
              ↓
neuron     `telemetry stale` reconstructs the derivation graph from `produced_by`
           plus each firing's cited `evidence[].sources`
              ↓
`neuron redrive <state_dir>` classifies every stale row into exactly three cases:

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

Both exist, both are gated, and they are now joined.

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

- **Authoring** — the join. `resolveGap` reports a third route, `authored`: when
  nothing can be discovered, a handler is written inert and earns admission by
  the identical path. Witness: `authored-gap-gate.sh`.

  **The bound matters more than the feature.** A gap declares its acceptance as
  `expect_contains`, so a handler synthesised to satisfy it could print that
  string and pass — closing the gap while doing nothing. Authoring is therefore
  a bounded search over transforms written ahead of time, none of which reads
  the gap, exactly as `channelVariants` is a bounded search over real input
  shapes. A gap no transform fits is refused. If you extend the catalogue, do
  not add an entry that reads the gap — that is the one change that would break
  this.

## Every package is a skill

Each limb package carries a `SKILL.md`: YAML frontmatter a machine reads
(`name`, `description`, `probe_input`, `expect_contains`), prose beneath it a
reader does. Three properties make it more than documentation, and all three
are asserted by `neuron/tests/skill-doc-gate.sh`:

1. **It is inside the digest.** `computePackageDigest` hashes it alongside
   `neuron.json` and `schemas/`. Edit the prose and you have a different
   package that must earn admission again. A description outside the pin can
   be edited to claim anything while the pin never moves — that is how docs
   and code drift, and it is what this closes.
2. **An acceptance-free declaration is refused.** `expect_contains` is the
   package's falsifiable claim. `morphogenesis.CapabilityGap.parse` already
   refuses an acceptance-free *gap* ("anything returning bytes would satisfy
   it"); admission now applies the same rule to the durable *package*.
3. **The declaration reaches the ledger.** The admission row carries the
   `skill` block, so a reader can ask what a package claimed at the moment it
   was pinned without trusting a file that may have been edited since.

**The bound, and it is the same one authoring has.** The prose body is
**cited by digest, never re-interpreted on the recompute path.** A producer
that re-reads prose and decides afresh each pass is non-deterministic, and
`redrive.zig:234` refuses exactly that for having no termination proof. Prose
as input identity: yes. Prose as decision procedure: never.

This is also what "self-upgrading" may safely mean here — the *acceptance* is
held fixed and the *implementation* is what varies, exactly as a skill is
iterated against its evals. "Rewrite until the acceptance passes" terminates.
"Rewrite to whatever seems better" does not.

Writing an `expect_contains` that a do-nothing handler could print re-opens
the hole: it would certify an implementation that does nothing. Pick a value
only correct behaviour yields.

## The staffing pipeline, as far as it is witnessed

Two nodes of the brief's workflow now exist as admitted limbs with gates. They
are fixtures — synthetic workers, no customer data — but the *properties* are
the deliverable, not the fixtures.

```
order + worker db  ──►  staffing-engine  ──►  roster  ──►  escalation-ladder
                        (Step 2)                            (Step 3)
```

| Node | Gate | The assertion that must never regress |
|---|---|---|
| `staffing-engine` | `staffing-engine-gate.sh` | a shortfall **refuses and writes nothing** — a short roster that looks complete gets notified |
| `escalation-ladder` | `escalation-ladder-gate.sh` | the ladder **terminates**; and a confirmed worker is never messaged again |

**The engine is on the recompute path, so determinism is not negotiable.** Its
assignment is a pure function of pinned reads: qualification filter, then sort
by `(last_worked, name)` for a *total* order. The realistic way to break this is
not exotic — a `set`, or sorting by `hash()`. CPython randomises string hashing
per process, so either is stable inside one firing and different across two:
invisible in a single run, fatal in a loop. The gate fires twice and compares
bytes for exactly this reason.

**The ladder crosses a real boundary, so termination is not negotiable.** Each
rung is an outbound message and the last rung is a phone call. Advancing a rung
is a compare-and-swap, not a blind overwrite — `error.Conflict` is the substrate
declining to let two due events both advance one worker, which would be two
calls for one silence.

Both gates assert per worker, never in aggregate: a total of six messages is
also what a ladder that messaged the wrong people six times produces.

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

  These claims are **checked against the compiler**, not asserted. The block
  below is the source of truth and `tests/zig-doctrine-gate.sh` parses it,
  generates a `@hasDecl` probe from it, and compiles it. Edit a line to
  something false and the gate goes red; the doctrine cannot rot quietly when
  a toolchain moves under it. This is the same refusal `SKILL.md` applies to a
  package, pointed at prose about the language.

  ```zig-doctrine
  # <decl-path> <absent|present>   — one claim per line
  std.process.argsAlloc    absent
  std.process.Args         present
  std.time.milliTimestamp  absent
  std.time.ns_per_ms       present
  std.Io.Timestamp         present
  std.Io.Dir               present
  ```

  Why an external Zig skill was NOT bound here instead: the best-installed one
  on the registry targets **0.15.2** while this repo pins `0.16.0` in all three
  manifests. Importing it would be adopting a claim nothing checks — the exact
  drift this block exists to prevent.
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
- **An observer must not classify what it cannot see.** `redrive`'s `classify`
  consults the TOPOLOGY — does a hop claim determinism, is an effector attached
  now. `telemetry serve` never opens the substrate (that refusal is what lets a
  live node keep committing while watched), so it cannot compute that verdict
  and must not imply one. A version that derived a route from `redrivable` and
  `crossed` alone agreed with `redrive` on a bare substrate and disagreed the
  moment an interface was attached. If you add a field to `/stale`, ask whether
  the journal alone can answer it.
- **`basename(state_dir)` is not a node id.** `agent init <node> <agent>` puts
  the substrate at `<node>/state`, so every node was recorded as "state" — a
  field naming nothing while claiming to be `who`. Use `nodeIdFor`.
- **Test with an interface ATTACHED.** Both defects above passed on a fresh
  substrate and failed on a real one. A gate over an empty node does not
  exercise the topology, which is where classification lives.

## Adding a native limb (the recipe)

To turn a business capability into a gated, admitted, deterministic limb —
see `docs/ADDING-A-LIMB.md` for the full checklist and `neuron/limbs/product-forge`
as the worked example. In short:

1. **Create the package** — `neuron/limbs/<name>/` with `neuron.json` (Caps,
   `write_prefix`, `budget`), `SKILL.md` (inside the digest — `expect_contains`
   must be falsifiable, not a string a do-nothing handler could echo), `schemas/`,
   and `neurons/<neuron>.py` (pure: stdin `Stimulus` → stdout `Decision`/`Rejection`).
   Import via `sys.path.insert(..., "../../shared")` from `_neuron` — `..` (one dot)
   is wrong; two levels up from `neurons/` is `limbs/shared`. Checked by admission,
   invisible on macOS if you only test the gate with the interface attached.
2. **Make it bounded, gap-blind, deterministic** — the classifier/catalogue never
   reads `expect_contains` (authored-gap bound) or a wall clock (`now_ms` is
   inside the firing identity → `FiringMismatch` on replay; use `0`). Same pinned
   read bytes → byte-identical effects (`sort_keys=True`, no `set`/`hash()` —
   CPython hash randomisation is the realistic break). Cite `sources: [<read id>]`
   or staleness is blind to the dependency (`redrive` needs `produced_by` +
   `evidence[].sources`).
3. **Wire the gate** — `neuron/tests/<name>-gate.sh` driving the public CLI
   from an empty dir, asserting against durable state, never stdout resemblance.
   Prove falsifiability: removing the feature must make the gate go red. Add it
   to `build.zig`'s `gate` step list (the inventory above is auto-checked).
4. **Evidence over stdout** — gates read `substrate.log` artifacts by id, not
   aggregated counts — six messages is also what messaging the wrong people six
   times produces.

Reference: `docs/ADDING-A-LIMB.md`. Prior art borrowed-and-rebuilt:
`nextlevelbuilder/ui-ux-pro-max (318K)`, `mattpocock/to-prd (364K)`,
`anthropics/frontend-design (783K)` — heuristics copied into bounded code, not
installed as deps.

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
| `archive/plans/PLAN-aiko-convergence.md` | the T1–T4 convergence plan. **All four are landed**; kept for the reasoning, not as a worklist |
| `docs/SOURCE-OF-TRUTH.md` | published-tree inventory (clone URL, layers, unpublished paths) |
| `CONTRIBUTING.md` / `SECURITY.md` | public contribution and vulnerability process |

`contract/NEVER-PUBLISH.md` applies: Contract is published in this monorepo, but
the subtree is not a standalone npm package and must not contain customer
operational data, wallet root keys, or private operator hosts.
