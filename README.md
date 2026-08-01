# Aiko

A meta-fractal harness for agent-operated business processes, exposed as an MCP
and mounted inside Hermes.

Most agents can complete a task. The hard problem is a process that runs every
day, talks to people, waits for replies, and has to be *right* — because being
wrong costs thirty-five phone calls and a missed vessel. Aiko is built for that
second problem.

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
aiko redrive   classifies every stale row into exactly three cases:

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
aiko interface resolve-gap <node> <agent> --gap gap.json --json
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
aiko port publish <node> <published.json>      # admit an inbound contract
aiko port attach  <node> <agent> --published <digest> --handler <pkg>
aiko port http    <node> --listen 127.0.0.1:8080
aiko interface resolve-gap <node> <agent> --gap gap.json   # reuse | discover | author

aiko-doctor bridge <node>/state --agent <id>   # firings → W6H-gated rows
aiko redrive       <node>/state                # the reactive pass
aiko-doctor tick   <node>/state [--every 5]    # both halves, one pass or resident
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
aiko telemetry serve <node>/state --listen 127.0.0.1:8787
```

A read-only live view: the firing stream as it commits, the derivation graph,
and stale nodes haloed. It **never opens the substrate**, so a running node
keeps committing while you watch, and artifact payloads never cross the wire —
ids, sizes and citations only.

It deliberately does **not** say which of redrive's three cases a stale node
will take. That verdict depends on the topology (does a hop claim determinism,
is an effector attached now), which an observer that cannot open the substrate
cannot see. `aiko redrive --dry-run` is the verdict; the view shows the facts.

### Use it from Claude

`aiko-doctor mcp` is a stdio MCP server exposing one surface —
`aiko.ledger.read`, `aiko.port.publish`, `aiko.port.attach`, `aiko.gap.resolve`,
`aiko.redrive`, `aiko.bridge`. Register it per-project:

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
zig build gate     published-interface · redrive · authored-gap
                   skill-doc · zig-doctrine · escalation-ladder
                   staffing-engine · bridge · dispatch · tick
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
| Credential vault / browser access | ⬜ none, in any layer |
| Constraint solver | 🟡 partial, and no more than that. `staffing-engine-gate` witnesses a **deterministic** rotational assignment — qualification filter, then `(last_worked, name)` as a total order, refusing rather than under-filling. That is rotation, not a solver: no shift-conflict resolution, no multi-constraint optimisation, no preference weighting. The determinism requirement is the part that generalises — anything richer must keep it, or the loop never settles |

---

## Repository layout

Converged monorepo — everything that used to be a separate clone, several with
no remote at all, is one repository with one history.

| Path | What it is |
|------|-----------|
| `neuron/` | Neuron (Zig) — firing, membrane, ports, redrive, limbs |
| `contract/` | Contract substrate — ledger, W6H, occurrences. **Closed source**, see `contract/NEVER-PUBLISH.md` |
| `aiko/` | Rust host, skills, desktop app. Not in the Zig build |
| `unbrowse/` | Unbrowse core |
| `unbrowse-dev/` | Unbrowse dev snapshot |

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
git subtree push --prefix=unbrowse git@github.com:unbrowse-ai/unbrowse.git main
git subtree push --prefix=neuron   git@gitea:Unbrowse/neuron.git             main
```

---

## Documents

| Document | Authority |
|---|---|
| `CLAUDE.md` | agent session context — read first if you are an agent |
| `PLAN-aiko-convergence.md` | risk-ordered remaining work |
| `neuron/AGENTS.md` | normative architecture |
| `neuron/IMPLEMENTATION.md` | what exists today, and known limits |
| `neuron/reference/ROADMAP.md` | unsettled work only |
| `contract/DOCTRINE.md` | substrate doctrine and parity spec |

Do not place customer operational data — worker names, identity numbers,
rosters — in this repository.
