# Observations: the fractal while-loop substrate

Captured 2026-05-26 mid-build, after the trio (build / run / eval) and
the JSON-envelope refactor. Two distinct sections:

1. **Execution model** — what the substrate IS, structurally.
2. **Gaps** — what's missing in the current code vs. the model.

The model came from Lewis describing it; the gaps came from auditing
the code as it stands after the JSON-envelope landing. Both are
captured so future sessions don't have to re-derive them.

---

## 1. Execution model — the fractal while-loop

### The shape, in one sentence

The substrate is **a while loop over a fractal recursive
hook-based break-neuron structure where every contract on every
fractal and every dimension validates to true by parent → child
resolution carried over pointers.**

### Unpacking, layer by layer

#### a. While loop

The substrate runs continuously while any /contract is pending. A
/contract is pending when:

  - it has been `declared` (event=declared row in the ledger)
  - it has NOT yet reached `satisfied` (or `died`)
  - and at least one of its synapses (`blocked_by`, `prehook`,
    `bind`, `contract:` refs) is in a state that could yet resolve

The loop terminates when every reachable /contract is either
satisfied (truth affirmed) or died (truth abandoned). There is no
external scheduler — the loop IS the ledger walk; every append
potentially unblocks the next iteration.

#### b. Fractal

The while-loop is the same shape at every layer:

```
   layer 0 (word)       while pending words remain: ...
   layer 1 (system)     while pending system contracts remain: ...
   layer 2 (cell)       while pending cells remain: ...
   layer 3 (graph)      while pending graph nodes remain: ...
   layer 4 (transport)  while pending transport contracts remain: ...
   layer 5 (value)      while pending value contracts remain: ...
   layer 6 (operator)   while pending operator contracts remain: ...
   layer 7 (break)      while pending validators remain: ...
   layer 8 (emerge)     while pending signed pointers remain: ...
```

Each layer's while-loop is identical in shape. Each layer's contracts
are themselves while-loops over their own children. The pattern
repeats fractally — a /contract is a tiny substrate; the substrate is
a big /contract.

#### c. Recursive

A pending /contract may spawn child /contracts during its iteration
(see `contract.recordIteration` + `cmdRun` which appends a new
declared child with action `iterate:<parent>`). Each child is itself
a fresh /contract — it enters the while-loop on the next pass.

`while (pending) { iterate; iterate may spawn more pending; ... }`

The same while-loop drains the new children. Recursion terminates
when every spawned descendant has satisfied or died.

#### d. Hook-based

Each /contract carries hook synapses on its declared row:

  - `prehook:<id>` — fire target BEFORE this contract advances
  - `posthook:<id>` — fire target AFTER this contract resolves
  - `blocked_by:<id>` — wait for target to satisfy before advancing
  - `inhibits:<id>` — suppress target if this contract advances
  - `bind:<id>` — sibling synapse: lateral binding

A while-loop iteration consults these synapses to decide whether a
/contract is ready to advance, and to fire dependent /contracts when
it does. The hooks are the synaptic edges; the contracts are the
neurons.

#### e. Break-neuron structure

Every /contract is a neuron. Most neurons spike (advance + satisfy)
linearly. Some neurons are **breaks** — layer-7 `validate:<id>`
contracts whose role is to interrupt the linear flow and force the
substrate to walk through a verdict step before signing.

A break-neuron's iteration is:

```
   read parent's truth claim
   read parent's evidence (iterations, evidence rows)
   render PASS / FAIL / HOLD verdict (the agent does, not heuristics)
   if PASS: emit signed:<sig> child (layer 8) — auto via L7→L8 cascade
   if FAIL: emit died with cause=contradicts
   if HOLD: stay pending, wait for more evidence
```

The break is named for what it does to the linear flow: it interrupts
the "declare → run → satisfy" line and inserts "declare → run →
validate-break → signed" at every join point that requires
cryptographic affirmation. Layer 7 IS the break layer; layer 8 IS
the emerged pointer-memory after the break resolved.

#### f. Validates to true by parent → child resolution

A /contract is true when its parent says so. The truth flows downward
from a root truth claim through every child via the `parent_id`
pointer. Specifically:

  - the root /contract's truth is asserted by the declaring agent
  - each child contract claims to satisfy some aspect of the parent's
    truth (the plan text re-expresses the parent's claim at a lower
    layer)
  - when ALL of a parent's children satisfy (per the parent's
    composition shape — funnel, sequence, quorum, etc.), the parent
    can satisfy
  - the parent's satisfaction is the resolution that propagates up to
    ITS parent

The while-loop terminates when truth has resolved from leaves up to
roots through every parent_id chain in the DAG.

#### g. By pointer

The parent → child relationship is a pointer (`parent_id` field, 8
hex chars referencing the parent's id). Resolution is pointer
chasing, not value comparison. The ledger walker reads each row's
`parent_id`, walks to the parent's row, reads ITS parent_id, and so
on up to the root. Lineage is a graph traversal, not a key lookup.

### Trio at every step

Inside the while-loop, every advancement of a /contract is exactly
ONE of the three trio operations:

  - **build** — a new /contract is declared (event=declared row appended)
  - **run** — an existing /contract iterates (event=iterated child appended)
  - **eval** — an existing /contract reaches satisfied (event=satisfied row,
    L7→L8 cascade fires if applicable)

Every iteration of the while-loop fires zero or more trio
operations. No fourth verb. The trio is the alphabet; the while-loop
is the sentence; the fractal is the book.

### Parallel to John 14:6

The same trio re-cast in the substrate's John 14:6 framing
(`verses.zig` line 76):

  - **build** ↔ truth (the truth claim, constructed)
  - **run** ↔ life (the runtime, exercised)
  - **eval** ↔ way (the path to verdict, walked)

"Distinct functions within one unity" — three verbs, one substrate.
The while-loop is the unity; the trio is the threefold function.

### Domain translations of the trio (Lewis 2026-05-26)

The substrate's verbs are domain-agnostic. Translate per context:

| Domain          | build       | run         | eval        |
|-----------------|-------------|-------------|-------------|
| substrate       | build       | run         | eval        |
| CI/CD           | build       | test        | deploy      |
| creation (Gen)  | inventory   | run         | verdict     |
| John 14:6       | truth       | life        | way         |
| LLM training    | model       | inference   | benchmark   |
| commerce        | manufacture | distribute  | settle      |
| science         | hypothesize | experiment  | publish     |
| software        | code        | run         | ship        |

The substrate's `build` / `run` / `eval` cover all of these because
they're the abstract three-step shape: **construct → exercise →
ratify**. Every domain decomposes into this. The verbs translate;
the structure stays.

`eval == deploy` (Lewis 2026-05-26): when a /contract is satisfied
and the L7→L8 cascade signs it, that signature IS the deploy
artifact. The signed:<sig> row is the wallet-ratified release. The
ledger walker can verify ANY release by walking parent_id back to
the truth-root.

---

## 2. Gaps in the current code vs. this model

Audited 2026-05-26. Listed in order of severity (1 = most load-bearing).

### Gap 1 — SDK still exposes pre-trio verbs

~~Closed 2026-05-26.~~ Python + TS SDKs were collapsed to the trio:
`build` / `run` / `eval` are the only user-facing verbs. The pre-
trio names (`declare` / `mark_satisfied` / `markSatisfied`) are
removed from exports and the surface tests assert they don't leak
back.

### Gap 2 — Validation table duplicated across three languages

The known-action prefix set lives in THREE files:

  - `libcontract/src/pointer.zig:isKnownAction` (Zig — canonical)
  - `Projects/contract-sdk-python/src/contract/__init__.py:_VALID_ACTION_PREFIXES`
  - `Projects/contract-sdk-typescript/src/index.ts:VALID_ACTION_PREFIXES`

Adding a new shape requires editing all three in lockstep. Drift
means a JSON envelope that passes one validator and fails another.

**Fix**: ship a JSON manifest (e.g.
`libcontract/data/known-actions.json`) generated from `pointer.zig`
at build time. SDKs read it at import. Single source of truth.

### Gap 3 — Wrapper has BYPASS_LLM_SHAPER escape hatch

~~Closed 2026-05-26.~~ `shaperBypassed()` and the `legacy*Shape`
helpers in walker.ts were deleted. The LLM shaper is now the only
path through `materializeRequest`; shaper failure → request fails
with an honest upstream_error. No fallback, no escape.

### Gap 4 — The 7-step harness isn't wired

`verses.zig` encodes the 9-day Genesis cycle as doctrine corpus, and
`cmdGenesis` in main.zig fires it for jl-day sessions. But the
SUBSTRATE-LEVEL while-loop doesn't fire the 7-step cycle on every
non-trivial /contract. Each /contract just advances when its synapses
allow; the canonical 1..7 step progression (inventory / separate /
seed / test / run / integrate / verdict) isn't structurally
enforced.

If the model is "every contract runs through 7 steps fractally", the
loop should fire a sub-contract per step, gated by the prior step's
satisfaction.

**Fix**: add a `cmdSteps` (or a step composer in the trio) that, for
any /contract whose action is a complex shape (e.g. neuron,
funnel-first, sequence), automatically spawns 7 child contracts —
one per Genesis day — with action prefixes naming the step (e.g.
`step:1-inventory`, `step:2-separate`, ..., `step:7-verdict`). The
substrate's existing sequence shape already supports this; we just
need to make it the default for non-trivial declarations.

### Gap 5 — Tool catalog (R8) → shaper context isn't piped

The `openai-compat-mapping-v1` Rule 8 says published /contracts
carrying `tool_visibility:public` are surfaced as OpenAI tools. But
`contract-openai-api/src/translator.ts:shapeSentence` only feeds the
mapping rules (R1..R8 plans) into `domainContext` — not the actual
published contracts. The LLM-shaper can't decide which existing
/contract a user message should re-point to because it doesn't see
the catalog.

**Fix**: at wrapper startup, query `aiko list --published` (or its
trio equivalent), filter for `tool_visibility:public` synapses, and
embed a one-line digest per contract into `domainContext`. Each
shape call sees the catalog.

### Gap 6 — Binary gated on spirit-attest; can't rebuild without external key

**~~Fully closed 2026-05-27.~~** The whole external-LLM gate was
removed. The substrate now self-attests via:

- **pattern.zig comptime invariants** (refuse non-conforming source
  at compile time, before the binary exists)
- **`zig build test`** (libcontract inline tests gate runtime invariants)
- **parent-sign binary lineage** — each new binary's sha256 is
  signed into the ledger by the PREVIOUS binary's wallet-derived
  keypair. The chain walks back to the root wallet via
  parent_signature on each hop. First-ever build uses
  `_bootstrap-self-sign` (root mode). Same primitive
  `lineage.deriveKeyPair + signDigest` already used for /contract
  rows — applied to binaries themselves.
- **Runtime self-verify gate** in main.zig: every invocation that
  isn't read-only metadata (self/verify-*) or bootstrap itself
  (_bootstrap-self-sign/_sign-child) checks the ledger for a
  signed:<own-sha> L8 row. Missing → refuse to run.

Files removed: `libcontract/src/spirit.zig`,
`libcontract/src/spirit_check_main.zig`,
`libcontract/src/attest_main.zig`, the `aiko-attest` build artifact,
and the `.contract-spirit-attest.jsonl` ledger.

The LLM-judge approach correctly produced FAIL verdicts on real
issues (cache.zig error-swallowing was a legitimate "do not bear
false witness" violation per Kimi K2.5-fast) BUT it also produced
HTTP errors (bible.zig 403 token cap, K2.5 rate limits) and made
the build externally-dependent on a vendor. The mechanical
self-attest via parent-sign is cleaner: deterministic, offline-
viable, substrate-rooted at Lewis's wallet rather than a vendor
LLM's verdict.

If LLM doctrine judgment is wanted later, it returns as a sibling-
repo concern (`contract-llm-doctrine-judge`) reading the ledger
and emitting FAIL evidence for human review. It never gates the
build.

The new `build` / `run` / `eval` verbs in `zig/src/main.zig` are
written but won't compile into a binary until Lewis runs
`aiko-attest` with `NEBIUS_API_KEY` to populate the spirit-attest
ledger. Until then, SDKs that pipe to `aiko build` etc. will fail
with "no such verb" against the stale binary.

This isn't a substrate bug — it's the substrate working as designed
(refusing un-attested code). But it means the trio's wire path
end-to-end is presently:

```
   sentence → translator (LLM) → /contract JSON  ✓ wired
   JSON → SDK validate            ✓ wired
   SDK pipes to `aiko build`      ✓ wired
   `aiko build` exists in binary  ⚠ requires fresh build
   fresh build requires           Lewis runs aiko-attest
```

**Fix**: not a code fix. Operator action.

### Gap 7 — No first-class while-loop driver

Nothing in the codebase explicitly fires the while-loop described in
section 1.a. The ledger is append-only; advancements happen when
SOMEONE calls build/run/eval. There's no daemon, no scheduler, no
"keep draining pending contracts" loop.

In practice the loop fires implicitly: the calling agent (the LLM
in the wrapper, or a human operator) is the driver. They invoke
build → see what new pending appeared → invoke run/eval on the
satisfiable ones → repeat. The while-loop is in the agent's head.

If we wanted to make the while-loop substrate-resident:

**Fix**: add a `cmdDrain` (or `aiko run --drain` mode) that, given a
root id, walks the entire pending subtree and advances every
synapse-ready /contract until the subtree is fully resolved. Each
advancement is a trio operation; the loop is the substrate's, not
the caller's.

---

## The recursive self-wrap pattern (added 2026-05-26)

The substrate doesn't ADD layers — it WRAPS itself in layers. Each
layer above the binary is a /contract whose action is `wrapper:<name>`
(layer 4 — transport). The wrapper /contract's parent_id points at
the layer it wraps. Walk the lineage chain and you get the full
tower of abstractions.

### What we already built (concrete worked example)

```
   contract binary (Zig)             ← the truth-root, the substrate itself
       ↑
   wrapper:contract-sdk-python       /contract id child A
   wrapper:contract-sdk-typescript   /contract id child B
       ↑                                 ↑
       └────── wrapper:contract-openai-api  /contract id grandchild
                       ↑
                       └─── (future wrappers wrap the openai-api)
```

The contract-sdk-* repos are /contract wrappers around the binary;
contract-openai-api is a /contract wrapper around the SDK. Each
wrapper is independently:

  - **built** — its source repo exists, has tests, has a manifest
  - **run** — its test suite passes; the wrapper exercises the layer
    below it
  - **eval** — when satisfied, the substrate's L7→L8 cascade signs
    the wrapper's identity into the ledger

This is the **same trio applied recursively**. Binary builds itself
(fractal build script). SDK is built on top of binary. OpenAI-API is
built on top of SDK. Future layers are built on top of OpenAI-API.

### Why "wrapper as skill" is the right framing

Each wrapper is a SKILL the binary surfaces: a callable layer the
parent doesn't directly know how to do (Python idioms, HTTP routing,
SSE streaming, OpenAI wire format). The skill is materialized as a
sibling repo + a `wrapper:<name>` /contract that lineage-anchors it
to the substrate.

The binary doesn't need to grow new features. It needs to grow new
wrapper /contracts whose code lives elsewhere but whose identity is
signed back into the ledger. The substrate stays small; the surface
grows fractally.

### Mechanical adaptations landed this turn

1. `pointer.zig` recognizes `wrapper:` as a typed prefix at layer 4.
   SDK validators (Python + TS) mirror.
2. Env var naming standardized to `CONTRACT_LLM_*` (BASE_URL +
   API_KEY + MODEL) across `attest_main.zig`, the openai-api wrapper
   `translator.ts`, and `server.ts`. The wrapper now defaults to
   `https://api.openai.com/v1` so it's substrate-agnostic — any
   OpenAI-compat endpoint works (OpenAI, Nebius, local llama.cpp,
   another /contract binary's own openai verb).
3. The wrapper's docstring + README name the wrapper itself as
   `wrapper:openai-compat` at layer 4 — explicit lineage.

### Outward spawn — how a wrapper wraps the environment it needs (Lewis 2026-05-26)

The "wrapper wraps itself in the environment it needs" pattern means
each wrapper INTROSPECTS the host on startup, ENUMERATES the
primitives available, and DECLARES one `wrapper:<cap>` /contract per
capability it intends to use. The wrapper isn't pre-coded with a
fixed dependency set; it discovers what's there and binds outward.

**Mechanical sequence per wrapper boot:**

```
   1. introspect          which runtime am I in?
                          (bun? python? curl? docker? kuri? a parent
                          /contract binary reachable via stdio? a
                          wireguard mesh? a sibling SDK on disk?)

   2. discover            /find-skills "openai compat shaper for $domain"
                          /find-skills returns skill manifests for
                          the relevant abstraction layer — the LLM
                          doesn't have to guess; it reads the skill
                          docs at the right depth.

   3. declare             for each capability the wrapper will use,
                          aiko build "use <cap> for <purpose>"
                          --action "wrapper:<cap>" (layer 4),
                          parent_id = this wrapper's identity.

   4. wire                set CONTRACT_LLM_BASE_URL on spawned children
                          to point at THIS wrapper's openai-compat
                          endpoint (if it serves one), or at the
                          parent the wrapper itself uses. The chain
                          is the lineage.

   5. eval (per cap)      when a capability's truth claim is met,
                          aiko eval <cap-contract-id>. The L7→L8
                          cascade signs the capability's binding into
                          the ledger.

   6. eval (self)         on shutdown, aiko eval <self-contract-id>.
                          The wrapper's whole lifetime becomes a
                          signed row in the ledger.
```

**Why /find-skills sits in the middle of step 2:** the wrapper can
ask the substrate "what skills exist for this abstraction layer?"
and get back manifests with usage docs, env-var requirements,
example invocations. The wrapper then binds the right primitive
mechanically — no LLM guess at what library to use. /find-skills is
the substrate's name service for primitives.

**Why /contract stdio in the middle of step 4:** the spawned child
wrapper's `CONTRACT_LLM_BASE_URL` can point at its parent over
stdio (or a unix socket, or wireguard). The parent's `cmdOpenAi`
verb already accepts chat-completions JSON on stdin. So:

```
   parent wrapper          child wrapper (spawned)
   ──────────────          ──────────────────────────
   binds CONTRACT_LLM_BASE_URL_FOR_CHILD = its-own-stdio-endpoint
   spawns child with env  →
                          CONTRACT_LLM_BASE_URL points back at parent
                          CONTRACT_LLM_API_KEY is the lineage signature
                          child shapes its sentences ← parent's openai
                          parent shapes ← grandparent's openai
                          …all the way to the vendor LLM at the root
```

Each hop is signed by the wallet pubkey at that hop. The full chain
of LLM calls is reconstructible from the ledger — the lineage chain
IS the call chain. Provenance for free.

### Skeleton for an auto-declaring wrapper

```
   id = sdk.build(
     plan="openai-compat wrapper v0.1 — HTTP/SSE shim over @contract/sdk",
     action="wrapper:openai-compat",
     parent=process.env.CONTRACT_PARENT_ID,   // the SDK's identity, or the binary's
   )
   write id to .contract-wrapper-identity
```

…and on shutdown call `sdk.eval(id, proof=...)` to satisfy + sign.
This makes each wrapper's lifetime a /contract row in the ledger,
not just code on disk. Deferred to a follow-up turn — it requires
the binary's `build` verb to land first (gap 6 from above).

### Parent-child fractal via LLM endpoint chaining

The substrate is also fractal at the **LLM-endpoint** layer. Lewis's
observation: the binary already has `cmdOpenAi` (line ~3863 of
main.zig) which makes IT an OpenAI-compat endpoint. So any wrapper's
`CONTRACT_LLM_BASE_URL` could point at:

  - a vendor LLM (`https://api.openai.com/v1`) — the default
  - a child /contract binary serving its own openai verb over a
    local socket or stdio
  - a parent /contract binary in a wireguard mesh
  - another wrapper layer that re-shapes the request

Each link in the chain is a parent/child relationship, signed by
wallet pubkeys at every hop. The lineage chain IS the call chain.

This makes the substrate's runtime topology recursive in the same
shape as its row topology. Every /contract has a parent_id; every
LLM endpoint has a parent endpoint; every wrapper has a parent
wrapper. Walk the pointer chain to get the full provenance.

## Tools as environment-typed pointers (Lewis 2026-05-27)

**The substrate has no "tool" abstraction.** Every "tool" in any
context (an OpenAI function call, a browser-script, a CLI command, a
telegram bot reply, a WASM module, a webhook) is just a /contract
whose `action` prefix names the runtime that dereferences it. The
prefix is the environment selector; the rest of the row is the
arguments.

The OpenAI `tool_calls[] / tool` message-pair wire shape becomes a
thin serialization over /contract envelopes:

```
   OpenAI wire shape                  /contract shape
   ──────────────────                 ───────────────────────────
   assistant.tool_calls[i]            event:declared,
     function.name = "fetch_user"       action:<env>:<payload>,
     function.arguments = {id:42}       plan:<sentence describing call>,
                                        parent_id:<conversation root>

   tool.content = "<result>"          event:satisfied on that id,
                                        proof:<result>
                                      → auto L7→L8 cascade signs
                                        the result as a pointer-memory
```

### Environment-typed action prefixes

The substrate's existing typed-pointer set generalizes per-environment.
Adding a runtime = adding a prefix to `pointer.zig:isKnownAction` +
the SDK validator tables (or, when gap 2 closes, just to pointer.zig
since SDKs read the canonical manifest).

| Prefix | Runtime | Where it executes | Layer |
|---|---|---|---|
| `cli:<cmd>` | shell | host OS | 2 (cell) |
| `wasm:<sha>` | wasm runtime | browser / wasmtime / wasmer | 2 (cell) |
| `binary:<sha>` | native ELF/Mach-O | host OS, sandbox, container | 2 (cell) |
| `browser-script:<sha>` | JS sandbox | browser devtools / extension | 2 (cell) |
| `webhook:<url>` | HTTP POST | network | 4 (transport) |
| `telegram:<chat>:<cmd>` | bot API | telegram | 4 (transport) |
| `email:<addr>:<template>` | SMTP | mail | 4 (transport) |
| `wallet:<addr>` | signing | local keystore | 5 (value) |
| `x402:<endpoint>` | paywall fulfillment | payment rail | 5 (value) |
| `contract:<id>` | another /contract | this ledger | 3 (graph) |
| `agent:<id>` | human-in-the-loop | wherever the operator is | 6 (operator) |

The **same /contract id** can surface as different prefixes per host:
the row in the ledger says `action: wasm:<sha>`, but the WASM blob's
sha can correspond to a binary's sha on a different host, or to a
telegram command on a phone. Each host's dereferencer picks the right
prefix from the row — the lineage chain stays identical.

### Stdio is the universal lineage channel

Lewis's insight: **the lineage chain is mechanical and stateless,
exactly like stdio piping.** Each hop reads input, produces output,
no shared state between hops. The substrate's parent_signature does
for /contract rows what stdio does for processes — it's the
verification at the seam between producer and consumer.

This means:

```
   wasm-module → produces sha of output (pointer A)
                  ↓ (stdio-like; signed as L8 row)
   native-binary → reads sha A, fetches blob, runs, produces sha B
                   ↓ (stdio-like; signed as L8 row, parent_id=A's row)
   telegram-bot → reads sha B, formats, sends to chat
                  ↓ (stdio-like; signed as L8 row, parent_id=B's row)
   browser-script → reads bot message id, updates DOM
                    ↓ (stdio-like; signed as L8 row, parent_id=bot's row)
```

Each hop is a different runtime in a different environment. Each is
a /contract row. The chain has one parent_id walk back to root, one
signature per hop, full provenance from the user's DOM update back
to the original WASM module's sha — all reconstructible from the
ledger alone, no live processes required.

### The fractal property — three directions at once

1. **Vertically (across layers):** word → cell → graph → transport →
   value → operator → break → emerge. Each layer's action prefix
   points down to the next layer's terminology. Already enforced by
   pattern.zig comptime invariants.

2. **Horizontally (across environments):** same /contract id, different
   dereferencer per host. A `wasm:<sha>` row on a browser host is
   equivalent to a `binary:<sha>` row on an OS host when the WASM
   compiles down to that sha — the substrate doesn't care which
   environment dereferences the pointer, only that the lineage chain
   verifies.

3. **Recursively (pointers to pointers):** a tool result is a /contract
   whose `proof` field can itself be (or point at) another /contract
   id. Walking the DAG yields pointers all the way down — each one
   another fractal pattern of reality in its own environment.

### Implication for the openai-api wrapper

The wrapper becomes even thinner. Its job is:

1. Receive OpenAI request.
2. Per-message, ask the LLM-shaper to emit /contract JSON (already done).
3. Per assistant `tool_calls[i]`, the shaper emits a row with an
   environment-typed action prefix. The client (browser, OS, bot)
   reads the prefix and knows which runtime to invoke.
4. The runtime's output flows back as `tool` message content → wrapper
   calls `eval(tool_call_id, proof=output)`.
5. L7→L8 cascade signs. Next iteration of the conversation can
   reference the signed pointer-memory by id.

No special-casing per tool kind. The wrapper just relays /contract
envelopes; the environment-typed action prefix is what teaches the
host which runtime to dispatch.

### What needs to change to land this

Mechanical work (none of it blocking; can ship piecemeal):

- Add `wasm:`, `binary:`, `telegram:`, `email:`, `browser-script:`
  to `pointer.zig:isKnownAction` (and to the SDK validator tables —
  or close gap 2 first so it's one source).
- Document the dereferencer contract per prefix (what arguments each
  runtime expects, what proof shape it returns).
- A reference dereferencer per environment: a tiny WASM runtime
  loader for browser, a thin native-binary runner for OS, a
  telegram-bot adapter. Each is its own sibling repo; each registers
  via `wrapper:<env-name>` (layer 4) so the substrate sees the
  available environments via the ledger.

The substrate primitive doesn't change. The fractal property is
already there; we're just teaching more environments to read it.

## Every imperative verb reduces to the substrate's four (Lewis 2026-05-27)

Lewis's insight: **the verbs in any prompt sentence reduce to the
substrate's verb closure {build, run, eval, prune}.** Run the
falsifier on 20 representative imperative verbs from this entire
conversation:

| Prompt verb | Substrate verb | Notes |
|---|---|---|
| build, construct, compile, write, spawn | **build** | construction-shaped |
| run, exercise, iterate | **run** | exercise-shaped |
| evaluate, check, test, deploy, ship, verify, judge | **eval** | judgment-shaped |
| prune, kill | **prune** | removal-shaped |
| fix, investigate, save | *compound* | decompose into chains (e.g., `fix = run→eval→build`) |

**Result: 17/20 reduce cleanly; the remaining 3 are compound verbs
that unfold into chains of the four.** The four-verb closure IS the
substrate's universal verb space. This is exactly what we'd expect
from John 14:6 ("the way, the truth, and the life — distinct
functions within one unity"): the closure is small because the
substrate is one unity; the verbs are distinct because their
functions are.

### The sentence-as-contract framing

A prompt sentence is a /contract:

```
   "build the wrapper from the spec"
       ↑           ↑       ↑     ↑
     verb       word    word  word
     (action)   (child) (child)(child)
```

Mechanically:

- The sentence as a whole becomes a parent /contract (the
  meta-contract), action = `neuron:sentence`, plan = the sentence text
- Each WORD becomes a `word:<tok>` child (already wired —
  `emitWordChildren` in cmdDeclare fires one per token)
- Each VERB additionally becomes a SUB-/contract whose action is
  one of {build, run, eval, prune}, parent_id = the sentence
  meta-contract id

The meta-contract's role: it holds the verb-children as the
**composition** that fulfills the sentence's truth claim. Walking
the meta-contract's children reconstructs the verb sequence (the
recipe to execute the sentence).

For compound verbs like "fix", the meta-contract spawns a CHAIN of
substrate-verb children (run → eval → build), bound by sequential
synapses (the existing `sequence` shape at layer 3).

### Mechanical wire (to add when ready)

Currently `emitWordChildren` declares one `word:<tok>` child per
unique word token. To extend with verb-classification:

1. Tokenize as today
2. For each token, classify via the synonym table:
   - if it maps to build/run/eval/prune → also declare a sub-/contract
     with `action: <substrate-verb>` (layer 2 — cell, since it names
     a runtime invocation)
   - else → already covered by word-child
3. The sub-contracts use the sentence-contract as parent_id
4. The substrate's existing `sequence` shape captures order for
   compound verbs

The synonym table is small (~50 entries covers most English
imperatives) and lives next to `pointer.zig`. Same primitive as
existing prefix table; just expanded with verb synonyms instead of
typed pointers.

**Defer:** the actual implementation. Documented as gap-verb-extract.
The insight stands; mechanical wire is straightforward when we ship it.

## Matt 7:7 — ask / seek / knock fallback chain for LLM access (Lewis 2026-05-27)

Lewis's question: "what if no openai-compat is set up properly — fall
back to llama.cpp + Qwen3.5-0.8B as primary fallback, then to x402
wallet-paid endpoint?" The substrate-doctrinal mapping:

> *Ask, and it shall be given you; seek, and ye shall find; knock,
> and it shall be opened unto you.* — Matthew 7:7

Three-tier escalation. Same shape as Matt 7:7 (three-fold prayer).

| Tier | Verb | Path | Required env |
|---|---|---|---|
| 1 | **ASK** | configured OpenAI-compat endpoint (vendor or local server) | `CONTRACT_LLM_BASE_URL`, `CONTRACT_LLM_API_KEY` |
| 2 | **SEEK** | local llama.cpp serving Qwen3.5-0.8B (or any small GGUF) | `CONTRACT_LLAMACPP_BIN`, `CONTRACT_LLAMACPP_MODEL_PATH` |
| 3 | **KNOCK** | x402 wallet-paid endpoint (replies HTTP 402 on first call; wrapper pays + retries) | `CONTRACT_WALLET_PRIVATE_KEY`, `CONTRACT_X402_FACILITATOR_URL` |

The wrapper attempts each tier in order:

```
   request arrives → try ASK (configured endpoint)
                       ↓ fails (no key set, or 5xx)
                       try SEEK (local llama.cpp → Qwen3.5-0.8B)
                                  ↓ fails (binary not on path, model file missing)
                                  try KNOCK (x402 — wallet signs payment, retries)
                                            ↓ all three failed
                                            return honest upstream_error
```

Each tier is its own `wrapper:<tier-name>` /contract at layer 4 —
walking the lineage shows exactly which tier served any given
request, with wallet signatures at every hop.

### Why this is the right doctrinal shape

- **Ask is first** — the simplest, no-payment path. If the operator
  has configured an endpoint, use it.
- **Seek is second** — local effort. The host's own resources
  (Qwen3.5-0.8B in RAM) are the body's first response when external
  help fails. Costs CPU/RAM; pays no third party.
- **Knock is last** — knocking implies the door is closed unless you
  knock (i.e., pay). The x402 tier asks the wallet to sign payment;
  the wallet is the body's spend authority. Cost is real money.

The cascade respects cost: free first, local next, paid last.
Matt 7:7 reads in the same order: ask (cheap), seek (effortful),
knock (costly). The structural parallel is exact.

### Wallet env support for x402

The substrate already has wallet primitives (`lineage.zig` derives
keys from a single root seed). To expose them for x402:

- `CONTRACT_WALLET_PRIVATE_KEY` (REQUIRED for KNOCK tier; the seed
  for `lineage.loadOrInitRootKey`). Defaults to `~/.contract-root-key`
  on disk if env unset.
- `CONTRACT_X402_FACILITATOR_URL` (REQUIRED for KNOCK tier). The
  payment facilitator endpoint that converts wallet sigs to
  upstream auth (typically a faremeter / x402-spec endpoint).
- `CONTRACT_X402_MAX_USD_PER_REQUEST` (optional cap, default $0.10).

The wrapper's translator.ts already has the env-var read path; just
needs the fallback ladder + x402 client. Both deferred as gaps below.

### Defer notes

- llama.cpp binding lives in the wrapper (translator.ts), not the
  binary. The substrate stays vendor-agnostic; wrapper layer
  knows about local runtimes.
- Qwen3.5-0.8B is just the recommended SEEK model — any GGUF works.
  The env var names the path.

## Edge IS the signed pathway (Lewis 2026-05-27)

Lewis's observation: **the pathway that creates a child /contract IS
the lineage edge.** Stop thinking of `parent_id` as a DAG reference
field — think of the wire (stdio pipe, network socket, wireguard
tunnel, whatever physically carries the declaration from parent to
child) as itself the signed edge. The lineage chain is a chain of
wires, not a chain of ids.

### What we already have that matches this

The substrate's existing `parent_signature` mechanism IS this:

- `_sign-child <new-binary>` spawns from a parent binary process
- The parent binary IS the wire (it carries the declaration)
- The new L8 row's `parent_signature` is the parent's wallet-derived
  signature over the child's identity digest
- Anyone reading the row can verify: "this child was declared by a
  process whose key derivable from `parent_id` signed it"

So we already implement edge-as-pathway in-process via stdio + the
binary as the wire. The conceptual upgrade is just to NAME this
explicitly.

### What we don't have yet: cross-machine wire

When the parent and child are on different hosts (e.g., a parent
/contract binary in a wireguard mesh signs a child /contract created
on another node), the wire is the network tunnel. The signature
scheme stays IDENTICAL — `parent_signature` is computed the same way,
verified the same way — only the bytes-between-hosts changes.

**Defer:** wire-as-wireguard primitive. We don't need it yet; stdio
covers same-host parent-child. When we do, the right shape is to add
a `wire:<peer-pubkey>` action prefix at layer 4 (transport), and
spawned children declared under such a wire carry parent_signature
computed by the remote peer. The peer's key chains back to root via
its own L8 row in the shared ledger.

## Biblical patterns as cross-domain translation medium (Lewis 2026-05-27)

Lewis's insight: **high-IQ pattern recognition falls back to biblical
patterns as the canonical intermediate language between domains.**
When translating CI/CD → creation days → John 14:6 → LLM training,
the biblical pattern is the easier-to-understand path because:

1. It's a semantic-and-reference-based corpus (label, pattern, apply)
   rather than terminology-bound to one domain
2. Most domains have a parallel; the biblical pattern is the bridge
3. It's stable across time (Hebrews 13:8) so it doesn't drift

### The corpus we already have

| Location | Count | Shape |
|---|---|---|
| `/Users/lekt9/Projects/jstack/data/teachings.json` | 24 entries | `{ref, quote, label, pattern, apply}` |
| `/Users/lekt9/Projects/jstack/data/creation-teachings.json` | 110 entries (Genesis days, expanded) | same shape |
| `libcontract/src/verses.zig:corpus` | ~50 entries embedded in the binary | `Verse{ref, quote, label, pattern, apply}` |

The Zig embed is the substrate-authoritative view (load-bearing for
`relevantVerses()` queries by token-overlap). The jstack JSONs are
the source corpus the embed was distilled from.

### How translation mechanically works

To translate domain A → domain B via the biblical pattern:

1. Tokenize the source sentence in domain A.
2. `verses.relevantVerses(tokens, k=3)` returns the 3 most relevant
   biblical patterns.
3. The pattern's `label` + `pattern` field is the canonical name of
   the structural shape (e.g., "count the cost" / "Reckon scope
   before laying stones").
4. Re-express the source sentence in domain B by adopting the
   pattern's `apply` rule into B's terminology.

Worked example:

```
   domain A (LLM-training, sentence): "this model checkpoint is
     too brittle to deploy to production"
   verses.relevantVerses → "Matthew 7:24-25 — house on rock"
     pattern: "Storms reveal foundations"
     apply: "Run the tests or end-to-end call this step; if no
            foundation yet, write one failing test first"
   domain B (CI/CD, translated): "this build artifact lacks a
     passing test suite; add a smoke test before deploy"
```

Same structural pattern; different surface vocabulary. The biblical
label ("house on rock") is the canonical name that survives the
translation.

### How to wire it in further

Currently `verses.relevantVerses()` exists but only `cmdSpeak` uses
it directly. To make biblical-translation a substrate primitive:

- **New verb `translate <from-domain> <to-domain> <sentence>`** that
  hits relevantVerses, then asks an LLM (or a deterministic mapper)
  to re-express in the target domain using the matched pattern's
  apply field as guidance.
- **Wrapper-side: the openai-api shaper already has the schema in
  its system prompt.** Adding the biblical pattern as the "you are
  translating FROM operator-layer-6 sentences TO transport-layer-4
  JSON; here are 3 relevant patterns to anchor your translation"
  guidance closes gap-5 (tool catalog → shaper) AND makes the
  cross-domain translation explicit at the same time.

**Defer:** the translate verb itself. The corpus is in place; the
read path (`relevantVerses`) is in place; we just haven't wired the
top-level verb yet. New gap added below.

## Authority / sibling / child model (Lewis 2026-05-27)

### The rules

- **Parent has authority over children** — can prune them (markDied)
- **Siblings are same-level** — cannot prune each other; only the
  shared parent can
- **Root wallet has authority over everything** — system-wide kill
  rights
- **Server is at sibling-level to other servers** — peers in a mesh,
  not parent-of each other
- **Thin clients are children of their spawning server**
- **Wrapping is always a parent-of relation, never a sibling-of relation**

### The antipattern (worth flagging explicitly)

> A sibling /contract MUST NOT spawn another sibling. Spawning
> always produces a CHILD of the spawner. Otherwise you create
> unkillable peers: neither sibling has authority over the other,
> only the shared parent does, and the parent didn't sanction the
> new peer.

If you want a peer at the same level, declare it via the SHARED
PARENT, never via a sibling. The shared parent is the only entity
with the authority to spawn at that level.

### Wrapping = parent-of relation expressed as containment

Lewis's clarifying question 2026-05-27: "but the child is the
wrapper around it — is that against the doctrine? because we spawn
it into a container environment shell that wires itself into it."

**Not against the doctrine.** The "wrapping" IS the parent-of
relation expressed as environment containment:

```
   aiko binary          ← parent (the spawner)
     └─ container       ← child of aiko, AND parent of what runs inside it
          └─ wrapper    ← child of container, AND parent of what it spawns
               └─ ...
```

Every /contract is simultaneously **child-of-its-wrapper** AND
**parent-of-what-it-wraps**. The `parent_id` field always points
OUTWARD/UPWARD (toward the wrapping layer above); never INWARD
(toward something this contract wraps). Lineage walked upward
traces through the chain of containments back to root wallet.
Lineage walked downward reaches the leaf operations.

**"Container wires itself into the wrapper" maps to** the parent
injecting synapses into the child's declared row. The substrate
already supports this — the `synapses` field carries typed edges
(`bind:`, `prehook:`, `posthook:`, `modality:`, ...) that the
parent stamps on the child's row at declare time, signed by
`parent_signature`. The "wiring" is mechanical and signed.

The antipattern only triggers when something tries to declare a
PEER at its own level. Processes inside container-A may spawn
children inside container-A freely; they may NOT spawn container-B
as a sibling of container-A (only aiko, A's parent, has authority
to spawn peers of A). The chain is monotone upward — every spawn
descends; siblings only exist via shared-parent declaration.

### Mechanical enforcement (this turn)

This stays consistent with the existing parent_id chain: every new
row carries a parent_id pointing at the spawner. The spawner is the
parent of the new row by definition; new row is child by definition.
"Sibling spawning" would require a row to declare itself with a
parent_id pointing at its sibling's parent — which the substrate
allows mechanically but the doctrine forbids.

### Mechanical enforcement (this turn)

`cmdPrune` is the first place to enforce authority. Before
`contract.markDied`, the verb verifies:

- `by_id` (the killer, from the envelope) IS the target's parent_id,
  OR
- `by_id` IS the root wallet's identity contract id

If neither, the prune is refused with a targeted diagnostic. This
implements the rule "only the parent can prune its children" at the
substrate level. Future enforcement will extend to declare-time
checks (a sibling can't spawn another sibling) and cross-machine
checks (the wire's peer pubkey must derive from the parent's chain).

### Sibling self-wrapping — yes, but with the antipattern constraint

A sibling CAN wrap itself, AS LONG AS the wrap produces a child:

```
   parent
     ├── sibling A (server S1)
     │      └── self-wrap (S1's HTTP gateway)   ← child of S1, killable by S1
     └── sibling B (server S2)
            └── self-wrap (S2's HTTP gateway)   ← child of S2, killable by S2
```

Siblings A and B can't kill each other (only `parent` can). Each
sibling's wraps are its children → killable by the sibling. This is
the recursive self-wrap pattern from earlier, applied with the
authority rule attached.

### Long-running mode (defer — but document the shape)

Lewis: "should we /contract the binary into a while loop that stops
itself as a layer above when u ctrl c?"

**Yes, eventually.** The shape: the binary's main() spawns a long-
running while-loop /contract (action `loop-until:ctrl-c`) at layer 2
(cell), and traps SIGINT to mark that loop satisfied. Sub-loops at
inner layers (e.g., the cmdDrain while-loop from gap-7) become its
children. Ctrl-C at the top kills the parent loop → cascades through
markDied → all child loops terminate.

**Defer.** Requires the cmdDrain primitive (gap-7) to be wired first.
Once gap-7 ships, this is a thin wrapper around it.

## Parent-sign binary lineage (added 2026-05-27)

Lewis 2026-05-27: "should it self sign or should the parent sign it" →
**parent-sign.** Each built binary's L8 signed:<sha> row carries
`parent_id` pointing at the PREVIOUS binary's L8 row. The new row's
parent_signature is computed from the previous binary's wallet-derived
keypair (via lineage.deriveKeyPair on the parent's contract id). The
chain walks back to the root wallet on every hop. Same shape as the
existing /contract row lineage — applied to binaries themselves.

### Mechanical surface

Two substrate-internal verbs (underscore-prefixed; bypass the runtime
self-verify gate):

- `_bootstrap-self-sign` — fires ONCE on the very first build. Refuses
  if any prior signed:<own-sha> row exists in the ledger. The root L7
  validate:<sha> declared row has parent_id=null, so parent_signature
  is the root wallet's self-signature.
- `_sign-child <child-binary-path>` — fires from a parent (the
  saved-aside previous binary). Computes child's sha, declares a new
  L7 validate:<child-sha> row whose parent_id is the parent's own L8
  row id. parent_signature is then derived from the parent's contract
  id via lineage.deriveKeyPair (rooted in the wallet).

### Build pipeline sequence (build-fractal.sh)

```
   0. preflight                              source tree present?
   0.5 save aside                            cp current binary → .previous-binary
   1. BUILD                                  zig build (gated by pattern.zig comptime)
   2. TEST                                   zig build test
   3. SIGN                                   if .previous-binary exists:
                                               .previous-binary _sign-child <new>
                                             else (first build):
                                               <new> _bootstrap-self-sign
                                             Transitional fallback: if _sign-child
                                             reports "no L8 row" (saved-aside is from
                                             before this pipeline existed), the script
                                             falls through to bootstrap automatically.
```

The L8 row at the end IS the binary's signed identity. Subsequent
invocations find it via `isSelfSignedInLedger` and proceed; invocations
of a binary with no row refuse to run.

### Runtime gate

In `main()`, before any verb dispatch, the binary computes its own
sha256 and walks the ledger for a `validate:<own-sha8>` declared row
that has a `signed:<...>` declared child. If absent → refuse with a
targeted diagnostic. Exception list (bypass the gate): `self`,
`verify-self`, `verify-binary`, `_bootstrap-self-sign`, `_sign-child`.

### Why this is the right shape

- **Deterministic.** No LLM, no network, no vendor dependency. Build
  produces the signature in one shot from a fresh repo.
- **Substrate-rooted.** The trust chain anchors at Lewis's wallet, not
  at a vendor LLM's verdict. Walking the chain produces real provenance.
- **Bootstrap is naturally solved.** First build runs root-mode; every
  build after that extends the chain.
- **Recovery is honest.** If the .previous-binary is lost AND a signed
  row for the current sha already exists, _bootstrap-self-sign refuses
  (it's single-use per binary content). Recovery requires manual ledger
  edit OR pulling a previous binary from git. Matches "only run signed".

## The build pipeline IS the trio (added 2026-05-26)

`scripts/build-fractal.sh` makes the binary's own build a fractal
application of the trio:

  - **BUILD** — `zig build` compiles the binary. Gated by spirit-attest
    and `pattern.assertInvariants` (the comptime 0..8 layer check).
    Build refusing == truth claim refused.
  - **RUN** — `zig build test` exercises the runtime. libcontract's
    inline tests fire (shape validator, pattern enforcer, etc.). The
    binary IS its iteration; the test pass IS the run.
  - **EVAL** — the fresh binary is fed back into itself: a `validate:
    <binary-sha8>` /contract (layer 7) is declared, then immediately
    satisfied. The substrate's L7→L8 cascade automatically spawns a
    `signed:<wallet-sig>` child (layer 8). The wallet-signed row IS
    the binary's pointer-memory.

The pipeline is short-circuit: BUILD fails → no RUN. RUN fails → no
EVAL. Each step is mechanically gated on the prior; nothing is
skipped silently. The L8 signed row at the end is the cryptographic
witness that this exact binary (by sha256) was built, tested, and
ratified by the root wallet.

**Why this matters:** the substrate enforces the trio on every
/contract; the build pipeline is itself a /contract, so it enforces
the trio on itself. Turtles all the way down — the same pattern at
every scale. A binary that doesn't pass this pipeline doesn't get a
signed row, and the ledger walker sees no L8 row to verify against.
The substrate refuses to use unsigned binaries downstream.



These are aspects of the model that ARE faithfully implemented today:

- **Trio at every step** — every advancement IS build, run, or eval.
  The wire (CLI verbs + SDK methods + wrapper composer) honors this.
- **Layer enforcement** — `pattern.zig` comptime checks ensure no
  shape lands outside 0..8; the build refuses violations.
- **Spirit attestation** — every source file requires a wallet-
  signed PASS row from the LLM judge before the binary will build.
- **L7→L8 cascade** — `markSatisfied` auto-spawns the `signed:<sig>`
  child for validate: rows; the break-neuron pattern emerges
  automatically.
- **Parent → child by pointer** — every row's `parent_id` is the
  resolution pointer; the lineage walker chases it without value
  comparison.
- **Append-only ledger** — truth, once written, stays; the while-
  loop can re-read old rows without state mutation concerns.

The substrate's bones are right. The gaps are mostly omissions
(things not yet wired) rather than violations (things wired wrongly).

---

## Gap ledger — every gap is a /contract (drilled 2026-05-27)

Per Lewis's "/contract to drill through all gaps as /contracts to
build this out mechanically into the /contract code itself":

Each gap was declared as a /contract via the substrate binary's
`build` verb under a shared root (`gap-drill`). Closed gaps fired
`eval`; their satisfied rows are parent-signed in the lineage chain.
Open gaps are pending — the next session can `eval <id>` on each as
it ships the fix. The ledger itself is now the canonical work-tracker.

**Root /contract:** `f739f8cd` (neuron:gap-drill)

**Open gaps (declared, awaiting eval):**

| Gap key | /contract id | Action shape |
|---|---|---|
| gap-2 — shared validator manifest | `7f0cfa5b` | neuron:gap-shared-validator-manifest |
| gap-4 — 7-step Genesis harness | `a4e700c6` | neuron:gap-seven-step-harness |
| gap-5 — tool catalog → shaper | `a5042704` | neuron:gap-tool-catalog-shaper |
| gap-7 — cmdDrain while-loop driver | `1d46c413` | neuron:gap-cmddrain-while-loop |
| gap-chain-walk — verify chain back to root wallet | `3f74d3cf` | neuron:gap-chain-walk-verify |
| gap-env-prefixes — wasm:/binary:/telegram:/email:/browser-script: | `7847a188` | neuron:gap-env-typed-prefixes |
| gap-dereferencers — sibling-repo runtimes per environment | `234555df` | neuron:gap-environment-dereferencers |
| gap-deref-spec — document the dereferencer contract per prefix | `9265afb4` | neuron:gap-dereferencer-spec |
| gap-edge-wire — signed cross-machine wire primitive (wireguard-style) | `f7f193b8` | neuron:gap-edge-wire |
| gap-while-loop-runtime — binary as long-running while-loop with SIGINT trap | `3212a613` | neuron:gap-while-loop-runtime |
| gap-translate-verb — `translate` verb walking verses.relevantVerses for cross-domain pattern bridges | `9ce105a1` | neuron:gap-translate-verb |
| gap-verb-extract — verb tokens in sentences become substrate-verb sub-/contracts (build/run/eval/prune); compound verbs unfold to sequence chains | `1fba6c36` | neuron:gap-verb-extract |
| gap-matt77-ASK — tier 1 of Matt 7:7 fallback chain (configured endpoint) | `d0ea42c6` | neuron:gap-matt77-ask |
| gap-matt77-SEEK — tier 2 of Matt 7:7 (local llama.cpp serving Qwen3.5-0.8B) | `a9425091` | neuron:gap-matt77-seek |
| gap-matt77-KNOCK — tier 3 of Matt 7:7 (x402 wallet-paid endpoint when 402 arrives) | `52aa1cb1` | neuron:gap-matt77-knock |

**Closed gaps (declared + eval'd, lineage-signed in ledger):**

| Gap key | /contract id | Closure proof |
|---|---|---|
| gap-1 — SDK pre-trio verbs | `bf3bb650` | Python+TS SDK: trio is the only user-facing surface; 17/17 + 17/17 tests green |
| gap-3 — wrapper escape hatch | `bbc97dd8` | BYPASS_LLM_SHAPER + legacy*Shape helpers deleted; shaper is the only path |
| gap-6 — spirit-attest LLM gate | `8dbe68b4` | spirit/attest layer fully removed; substrate self-attests via pattern + tests + parent-signed binary lineage |
| gap-prune-authority | `61c76aa9` | cmdPrune verifies by_id == target.parent_id or self-apoptosis; 4/4 falsifier tests pass (parent-kills-child OK; stranger REFUSED; self-apoptosis OK; sibling-kills-sibling REFUSED) |

**Workflow going forward:** to close an open gap, ship the code +
fire one envelope:

```bash
echo '{"event":"satisfied","id":"<gap-id>","wave":1,"proof":"<what shipped>"}' \
  | $BINARY eval
```

The substrate appends a wallet-signed satisfied row, the projector
flips the gap from open to closed, and the ledger is the truth.

## Suggested order of work to close the gaps

1. **Gap 6 (operator action)** — Lewis runs `aiko-attest` so the
   new trio verbs land. Unblocks every other gap.
2. **Gap 1 (SDK cleanup)** — remove pre-trio verbs. Tightens surface.
3. **Gap 3 (wrapper cleanup)** — remove BYPASS_LLM_SHAPER. Tightens surface.
4. **Gap 2 (shared validation table)** — generate from pointer.zig.
   Stops drift before it accumulates.
5. **Gap 5 (tool catalog → shaper)** — feed published contracts to
   the LLM shaper so it can actually point at them.
6. **Gap 4 (7-step harness)** — fire the Genesis cycle on every
   non-trivial declaration. Makes the fractal explicit.
7. **Gap 7 (substrate-resident while-loop driver)** — add cmdDrain.
   Makes the while-loop first-class instead of agent-implicit.

Each step is independently shippable. Each step shrinks the gap
between "the substrate as described" and "the substrate as wired".
