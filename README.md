# Aiko

**Aiko is an AI Forward Deployed Engineer**: a digital employee for recurring,
cross-system operational work, exposed as an MCP. Give her a role, scoped
employee accounts, and an outcome to own. She learns the systems already in
place, builds and admits the integrations she needs, runs controllable
workflows, waits for the outside world, and verifies an effect before calling
it done.

This repository is the published monorepo:
[`github.com/lekt9/aiko`](https://github.com/lekt9/aiko). License:
[Apache-2.0](LICENSE). What exists in-tree versus what is local-only is
recorded in [`docs/SOURCE-OF-TRUTH.md`](docs/SOURCE-OF-TRUTH.md).

Most agents can complete a task. The hard problem is a process that runs every
day, talks to people, waits for replies, and has to be *right* — because being
wrong costs thirty-five phone calls and a missed vessel. Aiko is built for that
second problem. Contract owns durable authority, Neuron owns admitted
boundaries, and Smithers composes Contract control with the preserved Cell/runCell
typed harness. Production Telethon/SAP provider integrations are not features
this README pretends are already complete.

> Spelled **Aiko**. Meeting notes and transcripts say "Ico"; that is a
> transcription artifact.

---

## Hired, not installed

The deployment model is an employment model. Where a platform hands you an
integration checklist, Aiko onboards herself, the way a forward-deployed
engineer would:

- **Account credentials are the intended primary form of auth, not API keys.**
  The proven boundary accepts opaque, tenant/origin/account/action-scoped
  handles and refuses raw secret fields. It does not establish that every
  employee-reachable system is integrated. The OS-only envelope contract is
  gated; a managed enterprise vault and browser-session handoff are not shipped
  (see [Status](#status).)
- **She builds the systems.** The processes she operates are systems she
  stands up herself — gated, witnessed, and refused when wrong (see
  [the one idea](#the-one-idea) below).
- **She wires herself in through the same shape at every scale.** Neuron fires,
  Contract records, Cell composes typed DAGs, and the Rust host is the agent
  you actually run. Harness within the harness is the design, not an accident;
  the same seal at every scale is what "meta-fractal" means here.
- **She is a drop-in replacement for an employee, as an agent.** She takes the
  seat, the login, and the process. Everything below — the ledger, W6H, the
  gates — exists so that handoff can be trusted: the one property a report
  cannot mechanically give you is the one Aiko refuses to fake.

---

## The one idea

Every mechanism in Aiko is one refusal wearing different clothes: **refuse to
claim something happened when it didn't.**

| Mechanism | What it refuses |
|---|---|
| W6H | a record that cannot answer who/what/when/where/why/how — the write fails, naming the missing one |
| admission by digest | code not pinned to bytes that existed before the pin |
| outbox + independent read-back | settling an external effect on the sender's word |
| evidence grounding | a claim that cannot cite its sources |
| nothing-on-compilation-alone | a generated component that compiled but never worked |
| compensation | re-crossing a boundary already crossed |

This is the honest route to "zero setup". Not magical self-configuration — the
reason agent onboarding never ends is that you cannot trust the report, so you
go back and check. Aiko makes *done* mechanically checkable, so re-checking
stops being rational.

**Aiko is not infallible and does not claim to be.** It is fallible and refuses
to hide it. That is the property worth paying for in a system you may one day
hand to someone else.

---

## The product direction: a deployed employee, not another chatbot

The category thesis is **AI Forward Deployed Engineer (AI FDE)**. “Drop-in
employee” describes the intended deployment experience, not an absence of
security or rollout work. Aiko must still receive an explicit role, dedicated
least-privilege accounts, tenant and destination scopes, and human approval for
high-consequence effects. First login may require SSO, MFA, or consent; that is
a necessary authorization act, not developer integration ceremony.

Do not read this as a market-first claim. The repository has no competitive
witness for “the first AI FDE”. The claim this repository can make is narrower:
it is building Aiko toward this category, and it will promote each capability
only after a runnable witness proves it.

### The role contract

| Question | Binding answer |
|---|---|
| **Who** | One tenant-scoped Aiko role identity operating through dedicated employee or service accounts, never a borrowed personal session |
| **What** | A controllable, digest-pinned workflow, native adapters, cited context lineage, and independently settled effects |
| **When** | On an event, cadence, reply, invalidation, or explicit approval; uncertain work remains pending |
| **Where** | Smithers controls; the Cell computes; Aiko plans; Contract remembers; Neuron executes; Unbrowse learns existing web systems |
| **Why** | To enter a real operating loop and leave behind a workflow that can be inspected, handed off, and trusted without trusting Aiko's own report |
| **How** | Observe → write inert → test → admit by digest → attach least authority → act through the outbox → read back independently → settle or compensate |

“Single entity” means one role identity and one context envelope. It does **not**
mean collapsing the layers into a monolith. A delivered workflow must continue
to operate without a hard Aiko dependency; the standalone Neuron architecture
below is the mechanical evidence for that promise.

## Native ownership

The earlier Python FDE prototypes have been strangled by their native owners:

- **Contract** owns durable context, lifecycle, delegation, recovery, and graph verdicts.
- **Neuron** owns digest-admitted authoring and the Unbrowse and provider-effect limbs.
- **Smithers** owns control by composing `ContractCell` with the native Contract driver.
- **Cell/runCell remains the typed harness.** It is deliberately preserved and is
  not a credential, context, readiness, or durable-control authority store.

There is no root `bind-workflow` or `workflow-control` authority and no Python
credential/context/authoring/Unbrowse/Telethon authority under `cell/`. The
negative ownership witness is `tests/no-duplicate-fde-primitives-gate.sh`; it
also runs the Smithers Cell/runCell tests so cleanup cannot pass by deleting the
harness. Replacement behavior is witnessed by the Contract gates,
`neuron/tests/authored-gap-gate.sh`, `neuron/tests/unbrowse-limb-gate.sh`,
`neuron/tests/telethon-limb-gate.sh`, and the Smithers Contract driver gates.

The executable delivery graph remains under `docs/graph-engineering/`; the
public analyzer is `aiko-doctor graph-plan`. Contract analyzes declared walks,
while the owning host executes them—Aiko does not grow a second scheduler.

### 5 — Judge across the boundary

The builders do not promote their own work. Independent lenses judge:

| Lens | Promotion question |
|---|---|
| Correctness | Did the requested operational outcome occur? |
| Security | Did tenant isolation and least authority hold? |
| Reproduction | Does the workflow recover after restart and survive handoff? |
| Compensation | Does invalidation avoid repeating an already-crossed effect? |
| Product | Did deployment remove developer integration ceremony without hiding necessary authorization? |

The end-to-end gate starts from empty state and walks role → account authorization
→ system observation → adapter authoring → admission → execution → reply/read-back
→ amendment → redrive/compensation → handoff. No documentation promotion happens
until these independent witnesses agree.

### 6 — Promote the positioning only when it is true

After the end-to-end gate passes, update the public README, vision, goal, product,
risk, desktop, and implementation documents. Every capability statement must
link to a green runnable gate or retain a **Designed**/**Absent** label. The honest status remains the table later in this README: the reactive,
self-wiring substrate, OS-only credential envelope contract, cited context,
bounded adapter authoring, learned read boundary, and Telethon policy contract
are proven. Managed enterprise credential service, production Telethon, SAP, and
an operator write UI are not.

---

## Download Aiko Desktop

Download the installer for your operating system from the
[latest GitHub release](https://github.com/lekt9/aiko/releases/latest). The
filenames are stable, so these links always point at the newest published
version.

| Operating system | Recommended download | Other formats |
|---|---|---|
| **Windows 10/11 (x86-64)** | [Download the Setup installer](https://github.com/lekt9/aiko/releases/latest/download/Aiko-Windows-x86_64-Setup.exe) | [MSI](https://github.com/lekt9/aiko/releases/latest/download/Aiko-Windows-x86_64.msi) · [Portable ZIP](https://github.com/lekt9/aiko/releases/latest/download/Aiko-Windows-x86_64-Portable.zip) · [script installer ZIP](https://github.com/lekt9/aiko/releases/latest/download/Aiko-Windows-x86_64-Installer.zip) |
| **macOS** | [Download the DMG](https://github.com/lekt9/aiko/releases/latest/download/Aiko-macOS.dmg) | [Product installer `.pkg`](https://github.com/lekt9/aiko/releases/latest/download/Aiko-macOS.pkg) · [zipped `.pkg`](https://github.com/lekt9/aiko/releases/latest/download/Aiko-macOS.pkg.zip) |
| **Linux (x86-64)** | [Download the AppImage](https://github.com/lekt9/aiko/releases/latest/download/Aiko-Linux-x86_64.AppImage) | [Debian/Ubuntu `.deb`](https://github.com/lekt9/aiko/releases/latest/download/Aiko-Linux-x86_64.deb) |

Verify a download before installing it with
[`SHA256SUMS.txt`](https://github.com/lekt9/aiko/releases/latest/download/SHA256SUMS.txt).
Checksums prove file integrity; they do not establish publisher identity. The
Windows MSI/NSIS packages are currently unsigned and may trigger SmartScreen.
The release workflow publishes the macOS DMG and product package only after
their Apple application/installer signatures and notarization tickets validate.

The links become available after the first installer-enabled release finishes.
If a direct link is temporarily unavailable, check the
[`release` workflow](https://github.com/lekt9/aiko/actions/workflows/release.yml)
for platform build status.

## Architecture

Three layers, one build, one binary, one deliberate direction:

```
                    zig-out/bin/aiko
                           │
        ┌──────────────────┴──────────────────┐
        │                                     │
   neuron/                              contract/
   the firing primitive                 the durable interpreter
   ─────────────────────                ───────────────────────
   fire(Stimulus, Caps) → Decision      append-only ledger
   effects: write | send | spawn        W6H: six interrogatives or refused
   the membrane: 8 boundary kinds       at: / repeat: occurrences
   served `port` HTTP surface           occurrence invalidates prior truth
   redrive: the reactive loop           valid_from / valid_until, cadence
   limbs: admitted, digest-pinned

   STANDALONE. No runtime dependency    imports neuron, never the reverse
   on contract or on the Rust host.
```

**The direction is the product guarantee.** neuron builds and passes its tests
*without* contract. That is the mechanical evidence that a delivered system
survives Aiko being unavailable, changed, or handed off — a contractual
condition expressed as an architecture rather than a promise.

`aiko/` (the Rust host) lives in this repo but is **not** in the Zig build. It
compiles; its test build exhausts a 16 GB machine, so including it would produce
a build step that cannot be verified on the hardware it runs on. An unverifiable
step is worse than an absent one.

### Graph planning is one surface, not another scheduler

Contract owns deterministic, fail-closed graph analysis: Kahn waves, the ready
frontier, write collisions, cycles, unknown dependencies, grounding gaps and
gating gaps. Aiko exposes that verdict without reimplementing it:

```sh
./zig-out/bin/aiko-doctor graph-plan walk.json   # stable JSON on stdout
```

Cell executes typed deterministic frontiers. Neuron independently projects the
committed citation/production graph and live stream, but does not guess effect
safety from topology it cannot see. The Rust host has a source path that loads the same `contract_graph_plan` ABI
for advisory dry-run diagnostics; those diagnostics are not a durable admitted
walk and never authorize launch or fan-out. No layer adds a side scheduler or a
second durable ledger. `tests/graph-engineering-gate.sh` runs the real Contract
ABI witness, Cell gate, standalone Neuron live gate, direction checks, and the
compiled Rust admission membrane against the installed Contract ABI. The live
ACP client surface remains a separate integration boundary.

---

## Reactive: what actually makes it event-driven

A node re-fires when the thing it was derived from moves. Not polling, and not
re-reasoning over the whole world each time.

```
contract   a NEW OCCURRENCE invalidates the resolved contract and its dependants
              ↓
neuron     telemetry stale rebuilds the derivation graph from produced_by
           plus each firing's cited evidence sources
              ↓
neuron redrive classifies every stale row into exactly three cases:

   ① re-derivable          → re-fire under a NEW firing id
   ② cannot settle         → open an agent goal
   ③ ALREADY SENT          → CompensationGap. Never re-fired.
```

**Case ③ is the one most designs lack, and the one production needs.** After an
amended order, re-firing "notify 35 workers" re-messages the 31 who did not
change and still fails to tell the 4 who did. Compensation diffs the superseded
product against the new one and acts on the delta only.

Two constraints follow, and they bind anything built on this:

1. **Producers on the recompute path must be deterministic.** A non-deterministic
   producer re-derives a different answer each time, invalidates its own
   dependents, and never settles. Determinism is the termination proof. Models
   belong at the edges — OCR, message wording, exception summaries — never on
   the recompute path.
2. **A step is invisible to invalidation unless it cites its sources.** An
   uncited read is not a dependency as far as the loop is concerned.

---

## Self-wiring and self-writing

Both exist and are witnessed by gates. They are different things.

- **Self-wiring** — a capability gap is closed by discovering a boundary that
  already declares a schema, deriving an inert manifest, testing it, admitting
  it by digest, attaching least authority, retrying on the real path, and
  judging the outcome. Retained only on a verified real-path success.
- **Self-writing** — a component is *written inert*, then admitted by digest,
  attached, used, revoked, detached and collected.

The invariant is not "never write code". It is **write inert → admit by digest →
never retain on compilation alone.** Generation and admission are separate
steps, so generated bytes exist before their own pin.

### They are joined: authoring

A gap that nothing can satisfy is no longer retired. `resolve-gap` reports a
third route, `authored`: a handler is written inert, then earns admission by the
identical path — battery, admit by digest, least-authority attach, retry on the
real path, judge, retire on failure.

```sh
# discovery_target points at a path that does not exist
neuron interface resolve-gap <node> <agent> --gap gap.json --json
# → {"route":"authored","verified":true,"interface":"8caf7284…"}
```

**The bound, because this is where fabrication would get in.** A gap declares
its acceptance as `expect_contains`, so a handler *synthesised to satisfy it*
could print that string and pass — closing the gap while doing nothing. So
authoring is a bounded search over transforms written **ahead of time**, none of
which reads the gap. A gap no real transform fits is refused, not fabricated:

```
"hello world" → "ZZZ-NO-REAL-TRANSFORM-PRODUCES-THIS"   CapabilityGapUnresolved
"hello world" → "HELLO WORLD"                            route=authored
```

Witnessed by `neuron/tests/authored-gap-gate.sh`, whose central assertion is the
refusal rather than the success.

---

## Quickstart

Requires Zig 0.16.

```sh
git clone https://github.com/lekt9/aiko.git && cd aiko
zig build                    # → zig-out/bin/aiko + aiko-doctor
zig build test               # both Zig layers' suites
zig build gate               # the runnable witnesses
./zig-out/bin/aiko-doctor    # prove both layers link in one process
```

No submodule init, no bootstrap script.

Verified natively on Linux (build, both test suites, all gates). macOS is where
these layers were originally developed and is expected to work, but is not
verified here — and this repository has already shipped two bugs that were
invisible on macOS and fatal on Linux, so the reverse is worth re-checking
rather than assuming.

Serve a contract as an API, mirror firings into the durable ledger, and run the
loop:

```sh
neuron port publish <node> <published.json>        # admit an inbound contract
neuron port attach <node> <agent> --published <dg> --handler <pkg>
neuron port http <node> --listen 127.0.0.1:8080
neuron interface resolve-gap <node> <agent> --gap gap.json  # reuse | discover | author

aiko-doctor bridge <node>/state --agent <id>       # firings → W6H-gated contract rows
neuron redrive <node>/state                        # the reactive pass (act on staleness)
aiko-doctor tick <node>/state [--every 5]          # both halves, one pass or resident
```

`tick` is what makes the loop run on its own. Order is load-bearing — bridge
before redrive, because a firing that has not reached the ledger has no row to
be invalidated. It reaches a **fixpoint**: `redrive` commits firings of its own,
so a pass creates work for the next, and measured over six idle passes the
ledger settles at two and stays there. `tick-gate.sh` asserts both halves of
that — it settles, *and* it is still awake there, because a loop that has
quietly stopped also stops changing.

### Watch it happen

```sh
neuron telemetry serve <node>/state --listen 127.0.0.1:8787
```

A read-only live view: the firing stream as it commits, the derivation graph,
and stale nodes haloed. It **never opens the substrate**, so a running node
keeps committing while you watch, and artifact payloads never cross the wire —
ids, sizes and citations only.

It deliberately does **not** say which of redrive's three cases a stale node
will take. That verdict depends on the topology (does a hop claim determinism,
is an effector attached now), which an observer that cannot open the substrate
cannot see. `neuron redrive --dry-run` is the verdict; the view shows the facts.

### Use it from Claude

`aiko-doctor mcp` is a stdio MCP server exposing one surface —
`aiko.ledger.read`, `aiko.port.publish`, `aiko.port.attach`, `aiko.gap.resolve`,
`aiko.redrive`, `aiko.bridge`, `aiko.claim.register`, `aiko.claim.observe`
(8 tools, asserted as an exact set by `dispatch-gate`). Register it per-project:

```jsonc
// ~/.claude.json → projects["/path/to/aiko"].mcpServers
"aiko": { "type": "stdio",
          "command": "/path/to/aiko/zig-out/bin/aiko-doctor",
          "args": ["mcp"],
          "env": { "PATH": "/path/to/aiko/zig-out/bin:$PATH" } }
```

The `PATH` entry is required: neuron's verbs are invoked through its own CLI —
the surface its gates drive — rather than linked, so the door exercises exactly
the path the witnesses cover.

**Gates are the acceptance criterion**, not the unit tests. Each drives the
public CLI from an empty directory and asserts against durable state.

`zig build gate` schedules exactly these distinct shell witnesses from the root
`build.zig` (the self-check is also an install dependency). The block below is
generated — edit `build.zig`, then run `python3 scripts/gen-gate-inventory.py`;
`tests/docs-oss-ready-gate.sh` fails the build if it drifts:

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
- `tests/layer-lock-gate.sh`
- `tests/docs-oss-ready-gate.sh`
- `tests/docs-quality-gate.sh`
- `tests/conformance-gate.sh`
<!-- root-gate-inventory:end -->

---

## Status

| | State | Witness |
|---|---|---|
| Firing primitive, membrane (8 boundary kinds), limbs | ✅ | `runtime`, `universal-interface` |
| Served `port` HTTP surface | ✅ | `published-interface-gate` |
| `redrive` — three-case invalidation | ✅ | `redrive-gate` |
| Bridge — firing → W6H-gated contract row | ✅ | `bridge-gate` |
| Self-wiring, and self-writing | ✅ | `interface-morphogenesis`, `meta-agent` |
| **Authoring — the two joined** | ✅ | `authored-gap-gate` |
| **MCP dispatch — the surface Hermes mounts** | ✅ | `dispatch-gate` |
| **`tick` — the loop runs on its own** | ✅ | `tick-gate` |
| Every package declares its purpose, inside its digest | ✅ | `skill-doc-gate` |
| CLAUDE.md's Zig doctrine checked against the compiler | ✅ | `zig-doctrine-gate` |
| **Staffing engine — deterministic roster, refuses a shortfall** | ✅ | `staffing-engine-gate` |
| **Escalation ladder — notify → reply\|timeout → call → stop** | ✅ | `escalation-ladder-gate` |
| One build, Linux-native, both layers linked | ✅ | `aiko-doctor` |
| **Contract-backed Smithers Cell control** — typed harness preserved; no duplicate authority store | ✅ | `smithers-contract-driver-gate`, `no-duplicate-fde-primitives-gate` |
| **Contract context and delegated capability** — cited, scoped durable authority | ✅ | `contract-hook-ingress-gate`, `contract-delegation-capability-gate` |
| **Admitted Unbrowse and provider-effect boundaries** | ✅ | `unbrowse-limb-gate`, `telethon-limb-gate` |
| **Bounded native adapter authoring** — inert bytes through judgment on the real path | ✅ | `authored-gap-gate` |

Read-only live view (`telemetry serve`) exists and is gated by
`observe-live-gate`. What does **not** exist:

| | |
|---|---|
| Operator UI — queues, roster edit, approvals | ⬜ not started. The live view is read-only by design |
| OCR at the model edge | ⬜ open. The substrate is binary-safe; the MCP edge has no read tool (`ROADMAP.md` R11). An OCR *HTTP API* works today |
| Managed enterprise credential vault / browser-session handoff | ⬜ absent. The gated envelope uses native OS vaults and has no plaintext fallback; its lifecycle witness is synthetic, not a managed enterprise service |
| Constraint solver | 🟡 partial, and no more than that. `staffing-engine-gate` witnesses a **deterministic** rotational assignment — qualification filter, then `(last_worked, name)` as a total order, refusing rather than under-filling. That is rotation, not a solver: no shift-conflict resolution, no multi-constraint optimisation, no preference weighting. The determinism requirement is the part that generalises — anything richer must keep it, or the loop never settles |

---

## Repository layout

Converged monorepo — everything that used to be a separate clone, several with
no remote at all, is one repository with one history.

| Path | What it is |
|------|-----------|
| `neuron/` | Neuron (Zig) — firing, membrane, ports, redrive, `neuron/limbs/` (admitted packages) |
| `contract/` | Contract substrate — ledger, W6H, occurrences. In-tree; see `contract/README.md` |
| `aiko/` | Rust host, desktop, skills, MCP. Not in the Zig build |
| `cell/` | Fractal YAML/Python harness. Standalone — no runtime import of `contract/` or `neuron/` |
| `sdk/registry/stack.lock.json` | Compatible package lock — neuron, contract, cell, control (Smithers) |
| `src/` | Root harness — `aiko-doctor` links both Zig layers (comptime assert `contract.FireRequest == typed_neuron.FireRequest`) |
| `tests/` | Root witnesses — `bridge`, `dispatch`, `tick`, `zig-doctrine`, `conformance`, graph-engineering |
| `docs/` | Cross-layer map — start at [`docs/README.md`](docs/README.md) |

### History

Imported with `git subtree add`, so all 5393 commits are reachable and
`git blame` walks back into the originals.

One caveat: `git log -- contract/<file>` stops at the import merge, because
historical commits recorded that file at the repo root. To read a project's
history directly:

```sh
git log 65b58cad                # contract's pre-merge tip
git blame contract/CLAUDE.md    # works across the boundary
```

Each import merge commit records the source tip SHA in its message.

### Build outputs are not tracked

The pre-convergence trees held ~98 GB, almost entirely build output. A later
pass removed the last 246 MB still committed — all of it prebuilt macOS
`.dylib` and Windows `.dll`/`.pdb`, with **no Linux artifact at all**, which is
why a fresh Linux clone had nothing to link against. A checked-in foreign binary
was standing in for a build step that never ran.

`zig build` now produces the right artifact for whatever host you are on. The
root `.gitignore` keeps it that way.

### Pushing a project upstream

The public remote is `origin` → `github.com/lekt9/aiko`. Subtree splits to
historical Gitea remotes are operator-only and are not part of the public
clone path.

---

## Documents

| Document | Authority |
|---|---|
| [`docs/SOURCE-OF-TRUTH.md`](docs/SOURCE-OF-TRUTH.md) | published-tree inventory; docs must not contradict it |
| [`docs/README.md`](docs/README.md) | documentation map |
| `CLAUDE.md` | agent session context — read first if you are an agent |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | how to change this tree |
| [`SECURITY.md`](SECURITY.md) | private vulnerability reports |
| `docs/AI-FORWARD-DEPLOYED-ENGINEER.md` | product boundary (Proven / Designed / Absent) |
| `docs/graph-engineering/AIKO-HOOK-ORGANISM.md` | native Contract/Neuron/Smithers ownership covenant |
| `docs/graph-engineering/aiko-drop-in.walk.json` | **live** — preferred drop-in skill (9 pending, 7 layers): breakpoint taxonomy → harness → delegated spawn → Hoysan pilot |
| `docs/graph-engineering/AIKO-DROP-IN-PRIMITIVE-MAP.md` | reuse map: every drop-in node composes a frozen primitive (cell/primitives·patterns, neuron/limbs, contract) |
| `docs/AIKO-HOYSAN-BENCHMARK.md` | synthetic performance receipt, fixed defects, and control-plane blocker |
| `neuron/AGENTS.md` | normative architecture |
| `neuron/IMPLEMENTATION.md` | what exists today, and known limits |
| `neuron/reference/ROADMAP.md` | unsettled work only |
| `contract/DOCTRINE.md` | substrate doctrine and parity spec |
| `archive/plans/PLAN-aiko-convergence.md` | **historical** — T1–T4 already landed |

## License

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Do not place customer operational data — worker names, identity numbers,
rosters — in this repository.
