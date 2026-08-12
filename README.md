# Aiko

**Aiko is an AI Forward Deployed Engineer**: a digital employee for recurring,
cross-system operational work, exposed as an MCP and mounted inside Hermes.
Give her a role, scoped employee accounts, and an outcome to own. The target is
for Aiko to learn the systems already in place, build and admit the integrations
she needs, run controllable workflows, wait for the outside world, and verify an
effect before calling it done.

Most agents can complete a task. The hard problem is a process that runs every
day, talks to people, waits for replies, and has to be *right* — because being
wrong costs thirty-five phone calls and a missed vessel. Aiko is built for that
second problem. The workflow substrate exists today; employee-account credential
handoff and production Telethon/SAP adapters are the delivery plan below, not
features this README pretends are already complete.

> Spelled **Aiko**. Meeting notes and transcripts say "Ico"; that is a
> transcription artifact.

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
| **Where** | Smithers controls; Cell describes; Aiko plans; Contract remembers; Neuron executes; Unbrowse learns existing web systems |
| **Why** | To enter a real operating loop and leave behind a workflow that can be inspected, handed off, and trusted without trusting Aiko's own report |
| **How** | Observe → write inert → test → admit by digest → attach least authority → act through the outbox → read back independently → settle or compensate |

“Single entity” means one role identity and one context envelope. It does **not**
mean collapsing the layers into a monolith. A delivered workflow must continue
to operate without a hard Aiko dependency; the standalone Neuron architecture
below is the mechanical evidence for that promise.

## Execution plan

The executable form is
[`docs/graph-engineering/aiko-fde.walk.json`](docs/graph-engineering/aiko-fde.walk.json);
the expanded design record is
[`docs/AIKO-FDE-PLAN.md`](docs/AIKO-FDE-PLAN.md). Contract's real graph planner
accepts the walk with no cycles, unknown dependencies, write collisions,
grounding gaps, or missing witnesses:

```sh
./zig-out/bin/aiko-doctor graph-plan docs/graph-engineering/aiko-fde.walk.json
```

The plan is a chain at its current frontier, then fans out only where no data
edge exists:

```text
0  source-build guard                                        SETTLED
1  product contract                                         NEXT
2  credential envelope        ||  workflow binding
3  context plane || native authoring loop || Unbrowse port
4  Telethon employee pilot    ||  SAP sandbox pilot
5  independent FDE judge
6  documentation promotion
```

### 0 — Keep the source build honest (settled)

`ledger.readAll` is again bounded at 16 MiB, while graph-admission deduplication
streams past that limit. Lock-time compaction begins at 12 MiB, before capped
whole-buffer readers can wedge. The Rust source-build instructions now say that
Protocol Buffers generation needs `PROTOC`/`protoc`, or DotSlash for the
repository's hermetic `bin/protoc` wrapper.

**Witness:** both `cd contract/libcontract && zig build test` and root
`zig build test` pass on the reported macOS ARM64 source build.

### 1 — Freeze the product contract

Create `docs/AI-FORWARD-DEPLOYED-ENGINEER.md` as the canonical boundary before
building the headline. It must name the customer, first operational wedge,
authority model, handoff lifecycle, and acceptance criteria, and separate every
claim into **Proven**, **Designed**, or **Absent**. Telethon is the proposed first
vertical; SAP remains a sandbox pilot until its own gate is green.

**Witness:** the document exists, contains all three status classes, and names a
runnable promotion gate for the first vertical.

### 2 — Build the two foundations in parallel

**Employee credential envelope.** Give workflows opaque, tenant-scoped handles,
not passwords, cookies, or API keys. Secrets stay in the OS credential store and
are injected locally at the destination boundary. The envelope owns account
inventory, expiry, MFA handoff, revoke, rotate, logout, origin scope, and allowed
actions. Raw secrets may never enter prompts, Cell inputs, ledger rows, evidence,
telemetry, generated package digests, or git. There is no plaintext-file fallback
for employee credentials.

**Smithers → Cell → Aiko binding.** Smithers is the durable control, approval,
pause, and resume surface; it is not a second scheduler. It authors a typed Cell
workflow. Aiko projects the Cell digest, ports, capabilities, reads, writes,
produces, evidence, and witnesses into Contract graph nodes. Contract owns the
frontier and durable state; Neuron owns admitted execution.

**Gates:** credential isolation/redaction/revocation and a workflow-control gate
that proves pause/resume survives restart, code movement changes the digest, and
Smithers, Cell, Contract, and Neuron cannot disagree about the active revision.

### 3 — Join self-deployment, context, and existing systems

Three independently writable branches follow once both foundations exist:

1. **Context plane.** Context is minimal, tenant-isolated, cited lineage — not an
   unlimited transcript. Every derived fact records its source digest and
   `produced_by`; source movement invalidates dependants. The delivered workflow
   retains the context it needs after handoff without retaining secrets.
2. **Native authoring loop.** A capability gap may produce adapter code and a
   Cell only through the existing lifecycle: write inert, build, test, admit by
   digest, attach least authority, retry on the real path, and retain only after
   independent success. Compilation alone retains nothing. Authoring stays
   bounded to witnessed adapter families until a new family earns its own gate.
3. **Unbrowse port.** Under the employee account, Unbrowse observes first-party
   routes, compiles a sanitized route DAG, validates it by an independent replay,
   promotes it locally, and demotes it on drift. Cookies, passwords, raw HAR,
   filled auth holes, response bodies, and PII remain sealed locally. Unsafe
   mutations dry-run and require approval from outside the invoking agent.

**Gates:** citation invalidation and tenant isolation; generated-code
admit/attach/revoke; cold browse → independent replay → promotion → drift
demotion with no secret entering an admitted or published skill.

### 4 — Prove two verticals without pretending they are generic

**Telethon employee pilot.** Provision a dedicated Telegram account through
phone/code/2FA, store only its opaque session handle, normalize incoming updates
through Neuron's provider-neutral interface, enforce per-chat and per-recipient
ACLs, send through the canonical outbox, and read the resulting Telegram state
back independently. An amendment contacts only changed recipients; redrive never
blindly resends a message that already crossed the boundary. Auth expiry or an
unobservable send stays pending and escalates.

The first workflow is the one already witnessed in parts here: staffing
requirement → deterministic roster → confirmation messages → replies or timeout
→ escalation → amended requirement → compensation over the changed workers.

**SAP sandbox pilot.** Pick one customer-relevant business transaction rather
than claiming universal SAP support. Provision a dedicated least-privilege SAP
user, record its roles and segregation-of-duties constraints, observe the real
employee flow through Unbrowse, build against the actual selected surface, admit
the adapter, permission-gate the mutation, submit once, and read the SAP business
document back by identifier. A timeout without read-back is uncertain, never
complete. Do not claim RFC, BAPI, OData, or generic SAP support until that exact
surface is built and witnessed.

**Gates:** Telethon account auth + inbound/outbound + read-back + ACL + duplicate
redrive refusal; SAP permission denial + one sandbox transaction + idempotency +
uncertain timeout + document read-back + compensation.

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
link to a green runnable gate or retain a **Designed**/**Absent** label. Until
then, the honest status remains the table later in this README: the reactive,
self-wiring substrate is proven; employee credential handoff, production
Telethon, SAP, and an operator write UI are not.

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
git clone git@gitea:Unbrowse/commons.git && cd commons
zig build                    # → zig-out/bin/aiko + libcontract.a
zig build test               # both layers' suites
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
neuron telemetry serve <node>/state --listen 127.0.0.1:8787   # or aiko telemetry serve …
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
// ~/.claude.json → projects["/path/to/commons"].mcpServers
"aiko": { "type": "stdio",
          "command": "/path/to/commons/zig-out/bin/aiko-doctor",
          "args": ["mcp"],
          "env": { "PATH": "/path/to/commons/zig-out/bin:$PATH" } }
```

The `PATH` entry is required: neuron's verbs are invoked through its own CLI —
the surface its gates drive — rather than linked, so the door exercises exactly
the path the witnesses cover.

**Gates are the acceptance criterion**, not the unit tests. Each drives the
public CLI from an empty directory and asserts against durable state.

```
zig build gate     published-interface · redrive · authored-gap           # neuron
                   skill-doc · escalation-ladder · staffing-engine        # neuron
                   claim-deadline · interface-morphogenesis · meta-agent  # neuron
                   observe-live · self-constructing-agent                 # neuron
                   zig-doctrine · bridge · dispatch · tick                # root
                   conformance · minimal-tree                              # root (via tests/conformance-gate.sh + minimal-tree-gate.sh)
                   agent-entrypoint · universal-interface · conversation  # neuron (standalone)
                   swarm-package · observability-retention                # neuron (standalone)
                   + 12 limb conformance suites (python3 limbs/<limb>/tests/conformance.py)
```

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

Read-only live view (`telemetry serve`) exists and is gated by
`observe-live-gate`. What does **not** exist:

| | |
|---|---|
| Operator UI — queues, roster edit, approvals | ⬜ not started. The live view is read-only by design |
| OCR at the model edge | ⬜ open. The substrate is binary-safe; the MCP edge has no read tool (`ROADMAP.md` R11). An OCR *HTTP API* works today |
| Employee credential vault / browser-session handoff | ⬜ absent; Phase 2 of the AI-FDE plan, and no account-auth claim is promoted before its isolation/redaction/revocation gate |
| Constraint solver | 🟡 partial, and no more than that. `staffing-engine-gate` witnesses a **deterministic** rotational assignment — qualification filter, then `(last_worked, name)` as a total order, refusing rather than under-filling. That is rotation, not a solver: no shift-conflict resolution, no multi-constraint optimisation, no preference weighting. The determinism requirement is the part that generalises — anything richer must keep it, or the loop never settles |

---

## Repository layout

Converged monorepo — everything that used to be a separate clone, several with
no remote at all, is one repository with one history.

| Path | What it is |
|------|-----------|
| `neuron/` | Neuron (Zig) — firing, membrane, ports, redrive, `neuron/limbs/` (12 admitted packages) |
| `contract/` | Contract substrate — ledger, W6H, occurrences. **Closed source**, see `contract/NEVER-PUBLISH.md` |
| `aiko/` | Rust host, skills, MCP. Not in the Zig build |
| `src/` | Root harness — `aiko-doctor` links both layers (comptime assert `contract.FireRequest == typed_neuron.FireRequest`) |
| `tests/` | Root witnesses — `bridge`, `dispatch`, `tick`, `zig-doctrine`, `conformance`, `minimal-tree` |

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

```sh
git subtree push --prefix=neuron   git@gitea:Unbrowse/neuron.git             main
```

---

## Documents

| Document | Authority |
|---|---|
| `CLAUDE.md` | agent session context — read first if you are an agent |
| `docs/AIKO-FDE-PLAN.md` | expanded AI Forward Deployed Engineer execution plan |
| `docs/graph-engineering/aiko-fde.walk.json` | executable, skill-grounded delivery graph |
| `PLAN-aiko-convergence.md` | completed convergence reasoning; retained as history |
| `neuron/AGENTS.md` | normative architecture |
| `neuron/IMPLEMENTATION.md` | what exists today, and known limits |
| `neuron/reference/ROADMAP.md` | unsettled work only |
| `contract/DOCTRINE.md` | substrate doctrine and parity spec |

Do not place customer operational data — worker names, identity numbers,
rosters — in this repository.
