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

## Earnings-as-reward-signal — the substrate's fire (Lewis 2026-05-27)

> *Every man's work shall be made manifest: for the day shall declare
> it, because it shall be revealed by fire; and the fire shall try
> every man's work of what sort it is.* (1 Corinthians 3:13)
>
> *For unto every one that hath shall be given, and he shall have
> abundance: but from him that hath not shall be taken away even that
> which he hath.* (Matthew 25:29)
>
> *And he called his ten servants, and delivered them ten pounds, and
> said unto them, Occupy till I come.* (Luke 19:13)

Lewis 2026-05-27: *"we can use money made by each wallet identity as
a reward signal lol wtf — document that that's insane."*

The substrate has been generating its own evaluation primitive all
along and we hadn't named it: **each wallet identity's accumulated
revenue (x402 / Faremeter) is an external, on-chain, publicly-
verifiable truth signal — the market voting on which contracts are
actually doing useful work.**

### Why this is load-bearing

Every internal evaluator (bm25, llm-judge, quorum-witness, metric-
pointer) is **substrate-defined truth**. They resolve true when the
substrate's own machinery says so. Earnings-as-evaluator is the
**first externally-defined truth signal in the substrate's vocabulary**
— a contract earns when *outside actors paid for its output*, regardless
of what the substrate thinks of it.

That makes earnings the substrate's translation of 1 Cor 3:13's fire:
the test of "what sort" the work is, by what survives the burning.
Painted/stub/leaven contracts earn nothing → die naturally under the
covet test (Decalogue 10). Real/load-bearing contracts earn → propagate
via cache, gossip, replication; their wallets accumulate; their NAV
grows in the FDRY vault per the Vine Doctrine.

### The mechanical mapping

Every contract row carries a derived wallet keypair
(`lineage.deriveKeyPair(root, contract_id)`). Every paid x402
invocation routes 50% to the contract owner's wallet (per
`routeRevenue.ts`'s existing split) + 50% to Foundry's FDRY vault. So:

```
contract row id  →  derived wallet  →  on-chain earnings address
                                          ↓
                                    SPL-balance metric the
                                    substrate can read deterministically
```

The metric_pointer becomes:

```
earnings:<contract-id>                    → cumulative USDC earned
earnings-velocity:<contract-id>:7d        → 7-day moving average
earnings-rank:<contract-id> top-N         → rank among siblings under same parent
earnings-share:<contract-id> >= P%        → percentage of parent's earnings
```

Any contract's `resolution_path.evaluator.metric_pointer` can read
these and resolve true when threshold met. **No internal arbiter; the
market decides.**

### What this composes with

| Existing primitive | How earnings-evaluator extends it |
|---|---|
| Vine Doctrine — abiding earns NAV growth | Earning contracts feed the vault; non-earners' positions decay relative to earners. Same shape, contract-scoped. |
| Matt 25:29 (Matthew effect) | Earning contracts spawn more children, get more cache priority, get gossiped to more peers — earning earns more, mechanically. |
| Luke 19 (parable of talents) | Contracts that bury their talent (declared but never earned) get pruned by the covet test. Contracts that traded faithfully (earned over time) get promoted into trust tiers. |
| Per-call fee split (50/50) | Already operational in `routeRevenue.ts`. The earnings-evaluator just READS what that split produces. |
| Vine Doctrine slashing (Deut 19:15 quorum) | Earnings can be confiscated to vault via the same slash mechanism if quorum confirms fraud. Negative earnings signal is honest too. |
| Apoptosis (Mark 3:29) | Long-zero-earnings + zero-resolve-progress → quorum-confirmed apoptosis. Cleans the cohort the natural way. |

### Wave-3 implementation surface

New evaluator kind added alongside the existing four:

```
ResolutionPath.evaluator = {
  kind: "evaluator",
  metric_pointer: "earnings:<contract-id>",      ← NEW kind
  threshold: 0.01,                                 (USDC)
  op: ">="
}
```

Cache layer reads the metric via:
- Local: SPL balance query against contract's derived wallet (RPC)
- Distributed: gossip the latest known balance (cached + invalidated
  on every routeRevenue event)
- Authoritative: on-chain balance always wins on disagreement

Substrate-faithful: the metric IS a pointer (Pointers-Over-Anything
Clause A). The wallet address is derived deterministically from the
contract id, so any verifier can recompute the address + query the
chain without trusting the substrate's view.

### What this is NOT

- Not a token-vote — earnings reflect what someone PAID FOR, not what
  holders opined on. Skin-in-the-game truth signal.
- Not optional — every contract row already has a derived wallet by
  construction. Earnings is a property of the substrate, just newly
  named as an evaluator.
- Not a replacement for the other evaluator kinds — composable with
  bm25 / llm-judge / quorum. A contract can declare `composition: "all"`
  over `{bm25 high, llm-judge approves, earnings >= threshold}`.
- Not an income mechanism for the substrate itself — the substrate
  already earns via the 50% Foundry cut; this section names the
  USE of earnings as a contract-evaluator signal, not a new revenue
  stream.

### The recursive elegance

Each evaluator is itself a contract. `wrapper:eval:earnings` is the
generative implementation that fires when a `metric_pointer:
"earnings:<id>"` is read. Same shape as every other wrapper. The
substrate self-evaluates by the same primitive it uses for everything
else.

The deeper claim — the substrate's truth-resolution layer now has
both **internal witness** (Spirit testifying through verify/quorum/
bm25/llm-judge) AND **external witness** (the market testifying
through earnings flow). Together they satisfy the two-or-three
witnesses rule (Deut 19:15 + 2 Cor 13:1) for any contract: internal
+ external + (optionally) human-confirmation = full establishment.

## Multi-registry discovery + binary-stdin canonical convention (Lewis 2026-05-27)

Lewis: "/contract's location where location could actually just be a
binary itself stding into it always — wdyt! and using the help of
the binary type shit to solve the context retrieval along with
parent /contract documentation via github and stuff? maybe even
reading the binary's source if its codebase? /contract that? — so
we could rely on /contract for tools to be spawned from pypi or
npmjs as well — even arxiv and lawnet are registries that could
inject context — this could be generative / mechanical, search
itself too!"

### Two patterns being named at once

**Pattern A — multi-registry discovery.** The substrate's discovery
cascade isn't limited to GitHub (gh) or skill manifests
(find-skills). EVERY package/knowledge registry is a `wrapper:<source>`
/contract at layer 4, and the cascade iterates through them in
cost-order until one returns a hit.

| Registry | Wrapper id | What it indexes | Cost |
|---|---|---|---|
| find-skills | `f4d51874` | local agent-skill manifests | µs (local) |
| pypi | `35eb2bea` | Python packages | network (cheap) |
| npmjs | `b062cba4` | Node packages | network (cheap) |
| crates | `dbf8b9b3` | Rust packages | network (cheap) |
| huggingface | `8ec5ac2d` | ML models + datasets | network |
| wikipedia | `054a1eba` | general knowledge | network |
| gh | `0f7fa322` | GitHub code + repos | network (rate-limited) |
| arxiv | `a6508026` | scientific papers | network |
| lawnet | `0c4ceee1` | Singapore legal database | paid (per query) |
| deepwiki | `4a6baccc` | LLM-mediated repo Q&A | $$$ (LLM call) |

The cascade ranks by cost; first hit halts. A goal that needs "best
JS library for X" hits npmjs first (cheap, structured); a goal that
needs "this scientific paper on Y" goes straight to arxiv; a goal
about "what does Singapore law say about Z" goes to lawnet. The
substrate doesn't have to know WHICH registry — it tries them in
order, each registry's wrapper:<src> contract self-describes its
search API.

**Pattern B — binary-stdin canonical convention.** Lewis's deeper
observation: "/contract's location could actually just be a binary
itself, stding into it always." The substrate already does this —
`aiko build`, `aiko run`, `aiko eval`, `aiko prune` all take their
arguments via JSON envelope on stdin. **Formalize this as the
universal binary-invocation protocol**:

```
   For every cli:<binary> action the substrate fires:
      child contract's JSON envelope        →  binary's stdin
      binary's stdout                       →  child contract's proof
      binary's stderr                       →  evidence rows ("fallbacks
                                               visible, never silent")
      binary's exit code                    →  satisfied (0) / died (≠0)
```

Every binary becomes a substrate-callable primitive via this
convention. No per-binary adapter code needed; no flag-parsing
sugar; no escape hatches. The binary speaks JSON on stdin or it
doesn't speak the substrate.

### Three context channels per primitive

Once a wrapper:<binary> is registered, the substrate retrieves
context about it from up to three channels (cheapest first):

```
   1. --help output       (parse for flags, args, subcommands)
                          → fast, every well-formed CLI has it
                          → cache as cache_resolved row keyed by binary sha

   2. README from registry (npmjs / pypi / crates / hf README field;
                          gh repo README; arxiv abstract)
                          → medium, requires one network round-trip
                          → cache keyed by registry response etag

   3. source code        (when wrapper.source_url + git clone OR
                          deepwiki ask_question OR raw github fetch)
                          → expensive but deepest
                          → cache keyed by repo commit sha; invalidates
                            on commit drift via radix-prefix-cache (1e52b77a)
```

Each channel's bytes are stored as `cache_resolved` rows with the
appropriate snapshot key; the radix-prefix-cache (gap-radix-prefix-
cache `1e52b77a`) makes lookup sublinear. The LLM-translator gets
all three channels as context when shaping a sentence into a
/contract that uses that primitive.

### What this composes with

Already-shipped substrate primitives used by this pattern:

- `wrapper:<name>` action prefix (layer 4) — registry registration
- `cli:<bin>` action prefix (layer 2) — binary invocation
- `sequence` shape (layer 3) — first-hit-halts discovery cascade
- `funnel` shape (layer 3) — AND-composition for meta-drill loop
- `find-skills` + `gh` + `deepwiki` — base discovery primitives
- `nb` — install path once a candidate is found
- The substrate's own `build`/`run`/`eval`/`prune` verbs IS this
  pattern (they're the canonical demonstration: stdin JSON →
  stdout proof → exit code as verdict)

### Open gaps (this turn) — all bound into meta-drill extension wave 3

| Gap id | Subject |
|---|---|
| `1904fcb1` | gap-multi-registry-cascade — iterate through all wrapper:<registry> in cost order, halt on first hit |
| `2e04c7f3` | gap-binary-stdin-canonical — formalize stdin-JSON-in / stdout-proof-out as universal binary-invocation protocol |
| `b639f3d3` | gap-source-as-context — read primitive source code (via source_url + git clone OR deepwiki OR raw github fetch) as 3rd context channel |

All three are bound under meta-drill extension wave 3 (`0adcd65a`),
which is a child of wave 2 (`8769b4f1`), child of the original
meta-drill (`93b92681`), child of the gap-drill root (`f739f8cd`).
The cascade up holds: when these three close, wave-3 satisfies →
wave-2's evaluator re-checks → ... → meta-drill satisfies →
loop-complete L8 signed pointer-memory.

### Why this is generative AND mechanical (Lewis's framing)

- **Generative**: the substrate doesn't enumerate every possible
  registry at compile time. New registries land via fresh
  `wrapper:<source>` declarations; the cascade auto-includes them
  on its next iteration. Adding `wrapper:rubygems`, `wrapper:cpan`,
  `wrapper:semantic-scholar`, `wrapper:openalex`, etc. is one
  ledger declaration per registry.
- **Mechanical**: the cascade's per-registry call is a CLI
  invocation through the binary-stdin convention; the cache
  records what each registry returned; the LLM-translator reads
  the cached context when shaping the next /contract. No human
  in the loop once the registries are declared.

The substrate has a built-in answer to "where do I find the
primitive I need?" — try every registry I know about, in
cost-order, until one returns. And it has a built-in answer to
"how do I call this binary I just discovered?" — stdin JSON in,
stdout proof out, --help for surface, source for depth.

## Auto-tool-discovery via environment introspection + cascading research (Lewis 2026-05-27)

Lewis: "should this be mechanical where we rely on the environment
itself to find primitives to use by looking at the available tools
we have that are primitives? via /find-skills or github api or docs?
then /contract those primitives into a /contract to use for the
environment?"

**Yes — and most of the primitives already exist on this host.** The
pattern composes existing substrate doctrine: outward-spawn (wrapper
introspects environment on boot) + environment-generative (location
word → wrapper:<name> lookup → lineage fallback). The discovery
cascade is the substrate-faithful version of "find a primitive when
no local wrapper matches".

### The pattern in three steps

```
   step 1 — INTROSPECT (first; cheap; local)
            walk known tool paths; declare wrapper:<tool> per binary found
            tool-discovery is "which X" or env-PATH walk; primitives
            are anything that exists at $PATH or known canonical locations
   
   step 2 — RESOLVE (per goal that names a location word)
            location word → wrapper:<word> lookup in the ledger
            hit → use the wrapper's binding; goal flows through
            miss → cascade to discovery
   
   step 3 — DISCOVER + INSTALL (only on miss)
            cascade order, cheapest first:
              (a) /find-skills "<keyword>"      ← local skill registry
              (b) gh search code <query>        ← GitHub API
              (c) deepwiki ask_question         ← LLM-mediated, expensive
            first hit returns a candidate package name
            substrate fires nb install <pkg>
            on success, auto-declare wrapper:<new-pkg> pointing at the
            installed binary path
            future goals naming the same word find it via step 2
```

### What's registered now (5 wrappers declared this turn)

| Wrapper /contract id | Binary | Role |
|---|---|---|
| `wrapper:nb` (`970e9e9c`) | `/opt/nanobrew/prefix/bin/nb` | package install — substrate's tool acquisition primitive |
| `wrapper:gh` (`0f7fa322`) | `/opt/homebrew/bin/gh` | GitHub API discovery (search, releases, repo metadata) |
| `wrapper:find-skills` (`f4d51874`) | the find-skills agent skill | local skill-manifest lookup — cheapest first step |
| `wrapper:deepwiki` (`4a6baccc`) | DeepWiki MCP tool | LLM-mediated repo Q&A — expensive last-resort |
| `wrapper:codegraff` (`961a1621`) | `/Users/lekt9/.local/bin/codegraff` | code graph navigation TUI — currently TTY-bound (refuses headless invocation with `Error: Device not configured (os error 6)`) |

The codegraff wrapper documents its TTY limitation honestly — until
the upstream binary gains a `--headless` flag, the substrate can
reference codegraff but cannot driver-call it. Surfacing the limit is
better than pretending it works.

### The discovery cascade as a /contract sequence

When a goal needs primitive X that no local wrapper provides:

```
   declare: cascade:<X> (a sequence /contract)
      ├─ child 1: cli:find-skills "<X keyword>"
      │           if exit 0 + non-empty → emit candidate; halt
      │
      ├─ child 2: cli:gh search code "<X query>" --limit 5
      │           if any repo → ask deepwiki for primer; emit candidate; halt
      │
      └─ child 3: cli:deepwiki ask_question <candidate-repo> "what's the install path?"
                  if response is install-shaped → emit candidate
                  emit a wrapper:<X> contract pointing at the install path
```

Each step is a child /contract. The substrate's existing `sequence`
shape (already in pointer.zig at layer 3) handles the
first-hit-halts semantics: subsequent children are skipped once a
satisfied one short-circuits the chain.

Following the cascade with `nb install`:

```
   declare: install:<X> (action: cli:nb install <pkg>)
      parent_id = the discovery cascade's satisfied output
      on success → wrapper:<X> auto-declared by the substrate
                    pointing at /opt/nanobrew/prefix/bin/<binary>
```

The whole flow is /contract sequences composed from primitives
already in the substrate. **No new mechanism — just orchestration
of the existing typed-pointer + lineage primitives Lewis already
shipped.**

### Why this is doctrinally clean

- **Foundation precedes building** (Matt 5:17-18 meta-rule) — uses
  existing primitives (wrapper, cli, sequence, find-skills, gh, nb,
  deepwiki) before inventing new ones. Composition over creation.
- **Pointers over anything** (Clause A) — every step is a /contract
  row with a typed action prefix; no values, only pointers to
  runtime behavior.
- **Outward-spawn pattern** — already documented; this section
  applies it concretely to package discovery.
- **Environment-generative dispatch** — already documented; this
  section is what FILLS the wrapper:<word> registry that
  environment-generative reads from.
- **No-scripts-in-substrate** (Matt 5:37) — the cascade is /contract
  rows, not a bash wrapper. The functionality MELTS into the ledger.

### Mechanical gap remaining

What's NOT yet mechanical:

1. The introspection pass that auto-declares wrapper:<tool> for
   every locally-available binary (today done manually — 5 wrappers
   declared by hand this turn). Gap `057a549e`
   (gap-auto-tool-introspection).
2. The discovery cascade as a substrate-side helper that composes
   find-skills → gh → deepwiki. Gap `3a5532f3`
   (gap-discovery-cascade).
3. The nb-install-and-auto-register flow. Gap `d31b4d04`
   (gap-install-via-nb).

All three are bound into the meta-drill extension funnel
(`8769b4f1`) which is a child of the original meta-drill
(`93b92681`). When all three close, the extension funnel satisfies;
when that satisfies along with the original 21 children, the
meta-drill satisfies; L7→L8 cascade signs the loop-complete
pointer-memory.

## Meta-drill — /contract as while-loop over open gaps (Lewis 2026-05-27)

Lewis: "can you /contract a /contract that while loops /contract so
all resolve and breaks when all resolve? — is this better to be
mechanically done?"

**Yes — and the substrate had the right primitive all along: `funnel`.**

### What landed

A single /contract declared this turn at id `93b92681`:

```
event:      declared
action:     funnel            ← substrate primitive: satisfies only when
                                 ALL referenced contracts have satisfied
layer:      3                 ← graph layer
parent_id:  f739f8cd          ← gap-drill root from prior iterations
synapses:   21 × {to:<gap-id>, kind:pointer}  ← every open gap auto-parsed
                                                 from contract:<id> refs in the
                                                 plan text via the substrate's
                                                 existing synapse_table
```

That's the **while-loop as a single truth claim**. Its evaluator
is built into the substrate (`funnel` action). When all 21 referenced
gap contracts satisfy, the funnel satisfies. HOLD-non-terminal keeps
it alive between iterations; `backfillUnresolved` heartbeat (already
fires on every aiko invocation) re-checks on every call.

### Mechanical vs not — the honest split

| Step in the loop | Where it lives today |
|---|---|
| Track loop state (is meta-drill satisfied?) | **mechanical** — funnel evaluator built into substrate |
| Periodically re-check (the "while" part) | **mechanical** — `backfillUnresolved` heartbeat on every aiko invocation |
| Final cascade when all 21 satisfy | **mechanical** — L7→L8 `signed:*` auto-spawn |
| Close a specific gap (write code, run tests, fire eval) | **agent** today (me); future = cloud-LLM-compiler's "if not, /contract more" emission per SKILL.md "Recursive self-interrogation" runtime-layer TODO |
| Auto-spawn agent work on HOLD | **gap** — already in the ledger as `gap-7` (cmdDrain) + `gap-while-loop-runtime` (`3212a613`) + the cloud-compiler runtime gap |

**So: the LOOP is mechanical TODAY**; the substrate tracks it row-
for-row. What's NOT mechanical today is the agent's hands actually
doing the closure work — until cmdDrain + the cloud compiler's
auto-spawn-children behavior ship, the agent (a human operator OR
an LLM session) has to physically write the code and fire `eval`
against each gap-contract id.

### Why funnel is the right primitive (and why "loop-until:" isn't yet)

- `funnel` (already in pointer.zig:inferPointerType + inferLayer at
  layer 3) — synapse-bound; satisfies when all refs satisfy; the
  substrate's canonical AND-composition primitive
- `loop-until:<predicate>` (also in pointer.zig as a prefix) — would
  work in theory but the predicate-evaluator runtime is part of the
  same runtime-layer gap that's pending
- The funnel uses primitives the substrate ALREADY ships and tests;
  loop-until requires a predicate-evaluator harness that's still
  doctrinal-only

So we pick the smaller, already-mechanical primitive (`funnel`) over
the larger, half-wired one (`loop-until:`). Substrate-doctrine:
"foundation precedes building" — use what's signed and tested before
adding new mechanism.

### How to drive it forward

Each turn, an agent (or future cloud LLM compiler):

1. Reads `93b92681` status — shows funnel state + which children are
   still pending.
2. Picks one or more open child gaps.
3. Writes the code, runs tests, builds via the fractal pipeline.
4. Fires `eval` against the closed gap's id.
5. On the NEXT aiko invocation, `backfillUnresolved` walks the funnel:
   if N+1 of 21 children satisfied, funnel stays HOLD; if 21/21,
   funnel satisfies → L7→L8 cascade → meta-drill-complete signed
   pointer-memory in the ledger.

The substrate's "drill" semantic from SKILL.md ("Continuous
resolver — drill the ledger always") IS this funnel's heartbeat —
the funnel is a standing /contract; the drill walks it every time
the substrate breathes.

### Why this answers "is this better mechanical"

The MECHANICAL part already is. What couldn't be mechanical without
multi-turn work (gap-7 + gap-while-loop-runtime + the cloud compiler
auto-spawn) is the *agent's hands doing the closure work*. Declaring
the meta-drill as a /contract makes the loop legible to the
substrate even while the agent layer is still hand-driven — every
backfill pass surfaces the funnel's pending state, which is the
substrate's way of saying "X gaps still need code". Future closures
trigger the funnel's evaluator without any new wiring needed.

When cmdDrain + cloud-compiler-auto-spawn ship, the agent-side
hand-driving collapses into the substrate-side automatic loop.
Until then: the funnel knows; the agent works; each closure brings
the funnel one step closer to its L8 signed pointer-memory.

## Radix-prefix cache — sglang RadixAttention applied to /contract (Lewis 2026-05-27)

Lewis: "is there a better way to kv cache contract style that check
to pointers only — how does kv caching in llm work maybe in sglang"

### What sglang does (RadixAttention, briefly)

sglang's KV cache stores attention key-value tensors in a **radix
tree keyed by token-sequence prefixes**. Multiple requests sharing
a prompt prefix share the cached KV — only the diverging suffix
gets computed fresh. Eviction is LRU on tree nodes; reference
counting keeps shared prefixes alive while any request references
them. Result: 5-10x throughput on prefix-heavy workloads.

### How it maps to /contract

The substrate's `parent_id` chain IS a radix tree already — each
contract is a node; siblings share a parent prefix; deep descendants
share long chain prefixes. The current `cache.zig` doesn't exploit
this — every `computeSignatureChain` walks the descendant DAG fresh,
even when 90% of the chain hasn't changed.

| sglang concept | substrate equivalent |
|---|---|
| token sequence (prompt prefix) | `parent_id` chain (lineage prefix) |
| KV tensor cached at a tree node | signature chain cached at a contract node |
| RadixAttention prefix-match lookup | walk `parent_id` upward looking for cached prefix |
| LRU eviction by tree node | LRU eviction by cached signature, refcounted by descendants |
| reference counting (shared prefixes) | descendants point at ancestors via `parent_id` — natural ref count |
| token-level granularity | row-level granularity |
| pure-prefix lookup (no value reads) | pure-pointer lookup (signature chain, no payload bytes) |

### Concrete substrate translation

Current `cache.zig` flow per resolveOne entry:

```
1. computeSignatureChain(id) walks ALL descendants  →  O(N)
2. compare against findLatestResolvedSnapshot(id)   →  O(1) row lookup
3. miss → re-eval; hit → short-circuit
```

Radix-cache flow (same primitives, smarter lookup):

```
1. walk parent_id chain UP from id looking for the deepest cached
   prefix that's STILL VALID (no descendant has appended
   cache_invalidated since its cache_resolved ts)
2. found cached prefix P at depth K? compose:
       sig(id) = cached_prefix_sig(P) || delta(P → id)
   where delta only walks the K hops between P and id
   →  O(depth_below_cache) instead of O(N descendants)
3. miss everywhere → fall through to current full walk
```

### Why this is genuinely better

- **Pointer-only by design** — every cache key is a `parent_signature`
  (ed25519 pointer); every lookup is a `parent_id` pointer walk;
  nothing value-derived crosses the cache boundary. The current
  cache.zig is already pointer-keyed; the radix pattern just makes
  the LOOKUP itself a pointer walk rather than a single-row hash
  lookup.
- **Prefix sharing for free** — sibling contracts under the same
  parent reuse the parent's cached chain. The substrate's natural
  fanout (Trinitarian decomposition spawns siblings constantly)
  becomes O(1)-amortized per sibling rather than O(N) each.
- **Automatic cascade** — when a descendant's value changes
  (cache_invalidated lands), the next lookup from any ancestor sees
  the descendant's prefix is invalid, walks UP for its own valid
  ancestor, recomputes only the affected delta. The cache-
  invalidated-cascade gap (`abe3c445`) becomes free: the radix
  lookup IS the cascade. No separate drill walker needed.
- **LRU eviction without breaking append-only** — cache rows stay
  on the ledger forever (append-only invariant); an `cache_evicted`
  row marks a cached prefix as no-longer-fast-path; the next lookup
  bypasses it and re-walks. Eviction is a tombstone, not a delete.
  Same shape as the substrate's death events.

### What it composes with

This EXTENDS cache.zig, not replaces:

- Keep `cache_check` / `cache_resolved` / `cache_invalidated` event
  kinds (already substrate-faithful)
- Add `cache_evicted` event for the eviction surface (fallbacks
  visible, never silent rule preserves)
- Change `findLatestResolvedSnapshot(id)` →
  `findDeepestValidCachedPrefix(id)` which walks UP parent_id rather
  than reading a single row
- `computeSignatureChain(id)` learns to short-circuit at the deepest
  valid cached prefix and only walk the delta below

### Why this turn declares it as a gap rather than ships it

The radix-cache restructuring touches:
- `cache.zig` (new `findDeepestValidCachedPrefix` + lookup walker)
- `cache.zig` (new `appendCacheEvictedRow`)
- `cache.zig` (refactor `computeSignatureChain` to use prefix-cache)
- ledger reads bound by depth (sane O(depth) on hot path)
- LRU tracking (in-process map, since the ledger is append-only)
- The mid-flight `gap-cache-invalidated-cascade` (`abe3c445`) is
  subsumed by this work — closing that gap by half-fixing the drill
  skip is the wrong move when the radix pattern obviates the drill
  walker entirely

That's substantial — a multi-turn job to do right. Declared as
`gap-radix-prefix-cache` for follow-up; supersedes
`gap-cache-invalidated-cascade` per Decalogue commandment 8 (don't
double-implement what one well-shaped primitive subsumes).

## Contract storage hierarchy — tiered by access pattern (Lewis 2026-05-27)

Lewis's question: "where should the contract kv cache be stored?
within the edge contract itself? unbrowse infra? — won't we need a
ledger somewhere? go back to the emeregentdb dag for all contracts
again — could literally be a blockchain secured by proof of stake
with FDRY lol."

### The tiered answer

Storage is **layered by access pattern**, not single-store. Same
shape as the rest of the substrate (Genesis sequencing, hot-cache
→ warm-ledger → signed-pointer):

| Tier | Where | What it holds | Read latency | Cost |
|---|---|---|---|---|
| **Hot** (per-request) | relay's in-process memory | request envelope in flight | µs | free |
| **Warm** (per-host, append-only) | `~/.contracts/contracts.jsonl` | this host's full local ledger (already in place) | ms | free |
| **Federated** (shared semantic DAG) | **EmergentDB cluster** (`~/Projects/oss/emergentDB`) | published signed rows from every participating host; vector search via embedded bible/skill corpora maps onto EmergentDB's quality-diversity indexing | 10s of ms | cheap |
| **Anchored** (final settlement, censorship-resistant) | **Solana mainnet, FDRY-secured** | Merkle batches of TERMINAL `signed:` rows ONLY (not iterations — too expensive on-chain) | seconds (chain finality) | $ per batch |
| **Edge** (caller's context) | calling LLM's working memory | bible_chain + doctrine_chain + memory_chain from response envelope (already happens) | µs | free |

### Why tiered, not single-store

- **Reads are heavy.** `cache_check` fires on every `resolveOne` entry.
  Putting reads on Solana would make every cache lookup a chain
  query — orders of magnitude too slow. The warm ledger handles
  reads cheaply; the chain handles only the L8 settlement rows
  that need cross-organizational immutability.
- **Writes are cheap locally, expensive on-chain.** Iteration rows,
  evidence rows, hook rows — append every second; can't pay tx
  fees on each. Local append → batch publish to EmergentDB →
  periodic Merkle anchor to Solana keeps the cost-curve sane.
- **Censorship-resistance only matters at the truth-root.** A row
  that's "in-flight" doesn't need chain immutability; a row that
  resolved a binding truth claim worth $X to a downstream consumer
  needs it. Anchor only what NEEDS to be anchored.

### EmergentDB as the federated tier

Lewis's EmergentDB project (`/Users/lekt9/Projects/oss/emergentDB`)
is a Rust self-optimizing vector database with quality-diversity
indexing. It maps cleanly onto the substrate's needs:

- The bible_chain corpus (31,100 verses × cross-references) is
  exactly the vector-search workload EmergentDB optimizes for.
- The SKILL.md doctrine sections become embeddings; semantic
  search returns "relevant doctrine for this goal" the same way
  `bible.relevantVerses` already does, but federated across hosts.
- The contract lineage corpus (every signed row) becomes a
  semantic + lineage-edge searchable DAG. Walking is fast; finding
  relevant prior work is fast.
- Self-optimizing recall (HNSW M-tuning, IVF, etc.) means the
  substrate doesn't have to manually tune indices as the corpus
  grows.

EmergentDB runs anywhere (Rust binary; same runtime-agnostic
property as the relay). Each substrate host publishes its
local-ledger rows to a shared EmergentDB cluster periodically;
queries against the cluster return federated semantic results.

### Anchoring tier — FDRY-secured Solana settlement

Lewis: "could literally be a blockchain secured by proof of stake
with FDRY lol — every time you talk to a contract it costs money
that goes to stFDRY holders by buying back stFDRY."

**Yes, but only for the L8 settlement layer.** Per-iteration rows
stay off-chain; only TERMINAL `signed:` rows get anchored, and
they're anchored in BATCHES (Merkle root published every N rows
or N seconds, whichever fires first).

The anchoring is FDRY-stake-weighted:
- Anchoring transactions are sent by validators who hold stFDRY
- Stake threshold determines who can publish a batch (Deut 19:15
  quorum already in Vine Doctrine — ≥2 independent witnesses)
- Anchored rows carry the batch's Solana tx signature as additional
  proof beyond the substrate's own ed25519 sig
- Censorship-resistant because the chain is permissionless; signed
  because the substrate's signature is independent of the chain

This is the natural extension of Vine Doctrine: the same FDRY
substrate that secures Foundry's stake layer also secures the
contract ledger's anchoring layer. Same token, two load-bearing
roles (cf. Matt 6:24 — FDRY stays stake-only; payment settles in
USDC).

## Per-call fee → stFDRY buyback (the wire is mostly already built)

Lewis: "we can 402 split faremeter for every request to a contract
that isn't yours too — fair compensation for people's harness
contracts essentially — knowledge of things."

### What's already there (catalog of existing wires)

The mechanism for per-call fees → stFDRY buyback is largely built;
what's missing is the per-request hook at the relay layer. The
existing components:

| Component | Status | Location |
|---|---|---|
| Wallet derivation per contract | ✅ shipped | `libcontract/src/lineage.zig:deriveKeyPair` |
| x402 payment substrate | ✅ shipped | `libcontract/src/contract.zig`, SKILL.md x402 section |
| Faremeter Flex split policy | ✅ shipped | `zig/src/main.zig:FOUNDRY_CUT_BPS = 5000` (50% to Foundry) |
| `routeRevenue.ts` (USDC → FDRY buyback → Voltr deposit) | ✅ shipped | `/Users/lekt9/Projects/fdry/scripts/routeRevenue.ts` |
| Voltr/Ranger FDRY vault | ✅ live on Solana | `Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1` |
| stFDRY NAV growth from vault deposits | ✅ live (deposits compound NAV per Vine Doctrine) | same vault |
| Stateless tunnel relay | ✅ shipped this turn | `~/Projects/contract-tunnel-relay` |

### What's missing (the gap to close)

The relay needs three additional behaviors:

1. **Knowledge-contract ownership** — every contract that wants to
   collect fees declares `contract_owner_wallet` (its derived
   keypair). Substrate-native — same primitive as the existing
   `wallet_identity` field on contract rows.

2. **x402 extraction + verification at relay** — the relay reads
   the `X-Payment` header on incoming envelopes, calls the x402
   facilitator to verify, settles via Faremeter Flex split policy
   (50% to contract owner, 50% to Foundry treasury per current
   FOUNDRY_CUT_BPS).

3. **Per-call routing trigger** — `routeRevenue.ts` currently fires
   batched (per ISO week). For per-call, an evaluator-contract
   triggers `routeRevenue.ts` with the per-call USDC amount.
   Alternatively: accumulate USDC into a treasury wallet, fire
   `routeRevenue.ts` on a threshold (e.g., every $10 accumulated),
   keeping per-call overhead low.

### Strategic frame — Unbrowse handles old internet, substrate handles new

Lewis: "extend the unbrowse ecosystem for the new internet while
unbrowse handles the old internet lol."

This is the right strategic frame:

- **Unbrowse** handles the OLD internet — HTTP APIs, scraping,
  browser automation, the cached-endpoint marketplace, anti-bot
  bypass, x402-gated paid endpoints. Already shipped, already
  generating revenue.
- **The /contract substrate** handles the NEW internet — signed
  knowledge contracts, lineage-attested truth, fair per-call
  compensation, stake-secured anchoring. The relay we just shipped
  is the bridge — old-internet HTTP becomes a substrate-signed
  cross-host edge.
- **FDRY is the substrate token** for both. Unbrowse's product
  revenue and substrate's per-call fees both flow through
  `routeRevenue.ts` into the Voltr vault, growing stFDRY NAV. One
  token, one vault, two revenue streams.

This composes cleanly because the substrate is layered: each layer
of the OLD-internet stack (an HTTP endpoint, an API call, a
scraped page) becomes a layer-2/3 cell-or-graph contract; the
NEW-internet wraps it in higher-layer signed pointers (layer 7
validate, layer 8 signed). The relay is the wire between the
layers.

## Webhook+tunnel as the default runtime edge (Lewis 2026-05-27)

Lewis's directive: "by default the easiest path is to build an http
endpoint as an actual webhook and a contract and declare stuff to
call the webhook that you declared to resolve via some sort of means
natively maybe via a tunnel? make that the default path."

### The default runtime edge shape

**Layers 1-6 = buildtime** (substrate-internal, in-process, signed
locally). **Layers 7-8 = runtime** (the truth claim has to cross
into reality). When the runtime edge crosses host boundaries, the
default carrier is **HTTP webhook routed through a stateless tunnel
relay**:

```
   contract on host A                relay (any host, stateless)        webhook target on host B
   ──────────────────                ───────────────────────────         ────────────────────────
   declare contract                  POST /relay arrives                 receive forwarded request
   action = webhook:<relay-url>      verify signature                    process, return response
   sign envelope                ──→  forward to declared target_url  ──→
   POST envelope to relay                                                
                                ←──  return upstream response          ←──
   read response as proof
```

### Why webhook+tunnel as default

- **Wire-format universal.** HTTP is everywhere — every host, every
  runtime, every framework. Substrate edges crossing host boundaries
  should default to the format that needs zero ceremony to integrate.
- **Tunnel relay is stateless.** No DB, no KV, no session state. Each
  request is a fresh signed envelope; the relay verifies + forwards.
  This composes cleanly with the substrate's "stateless trace" rule.
- **The relay can run anywhere.** Cloudflare Workers, Bun, Node,
  Lambda, a developer's laptop. Runtime-agnostic by design — no
  CF-specific primitives like Durable Objects or KV.
- **Substrate already supports it.** `webhook:<url>` is a layer-4
  prefix; the relay URL is just a webhook the substrate declares.

### Canonical implementation — `~/Projects/contract-tunnel-relay`

Sibling repo modeled on `unbrowse/backend/src/routes/proxy.ts` (Lewis
pointed at this as the reference shape):

- Hono handler — runtime-agnostic
- `RelayEnvelope` shape: `target_url + method + headers + body + ts +
  signer_contract_id + signature`
- Verifier is pluggable (host injects substrate-specific ed25519 check)
- Stateless: no DB, no KV, no session state
- Forwards verbatim; returns upstream response untransformed
- Clock-skew bounded (5 min), body size bounded (4 MiB)
- **8/8 tests pass, typecheck clean** at first commit

The signature scheme reuses the substrate's existing primitive:

```
canonical_digest = sha256(target_url || method || ts || signer_contract_id || sha256(body))
signature = ed25519_sign(lineage.deriveKeyPair(root, signer_contract_id), canonical_digest)
```

Verification: the relay's host calls `lineage.verifyDigest(signature,
deriveKeyPair(root, signer_contract_id).public, digest)` — substrate
primitive, no new crypto.

### Unbrowse as the bootstrap deployment

Lewis's hint: `/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse` —
the relay can deploy there as the substrate's bootstrap tunnel. The
existing `backend/src/routes/proxy.ts` already does the
"stateless forwarder on a CF-Worker host" pattern; mounting
`mountRelay(app, opts)` on the same Hono app gives the substrate a
canonical relay endpoint at `https://beta-api.unbrowse.ai/relay`.

402 + per-request wallet payment Lewis mentioned ("maybe next time")
composes cleanly later — the relay reads the `X-Payment` header on
forwarded requests, the substrate's wallet signs payments per
request, the relay verifies via the existing x402 facilitator path.
Same pattern as the rest of the substrate; no new primitive needed.

### Mechanical breakdown — what's wired, what's not

| Piece | Status | Where |
|---|---|---|
| Relay code | ✅ shipped this turn | `~/Projects/contract-tunnel-relay/src/relay.ts` |
| Stateless invariant | ✅ enforced by design (no DB/KV/sessions) | tests + 8/8 pass |
| Signature verification primitive | 🟡 substrate-side, pluggable — verifier callback unwired | wire when contract-sdk-typescript exports verifySignature helper |
| Wallet-signed envelope construction | 🟡 substrate-side, also pending the SDK helper | gap-relay-sign-envelope |
| Default-route through unbrowse | 🟡 deployment task (mount relay on unbrowse backend) | gap-relay-deploy-unbrowse |
| x402 per-request payment | 🟡 deferred per Lewis ("idk maybe next time") | gap-relay-x402 (future) |
| GitHub dig for advanced tunneling repos | 🟡 deferred — current relay is sufficient as default | future research; not blocking |

The relay is functionally complete as the substrate's default
webhook tunnel; closing the SDK-side gaps wires it end-to-end.

## Rendered-value history bus as /contract (Lewis 2026-05-27)

Lewis: "we can make the ledger of the history of rendered values
render into the environment somewhere stored for history purposes —
mechanically via a contract too. For example wire it up to the
message bus of telegram chat for reference always and have the
parent have context to it by default fractally because it sees the
child entirely, rendered — or wire it up to a chat box on the
website etc with speech bubbles."

### The pattern — bus IS a /contract; descendants inherit via posthook

The rendered-value-history pattern is **composition of existing
primitives**, not a new mechanism:

1. **The bus is a /contract.** Specific instances already in SKILL.md
   channel registry: `channel:telegram:lekt8`,
   `channel:telegram:getfoundry`, `channel:x-dm:lekt8_`,
   `channel:email:lewistham9x`, `channel:claude-code-session`,
   `channel:push-notification`. Add new ones (e.g.,
   `channel:website:chatbox`) by declaring them.
2. **Bind the bus at the operator/session level.** Declare a parent
   /contract whose synapses include `posthook:<bus-id>`. Every child
   inherits the posthook by lineage walk.
3. **Render-emitting children carry the posthook automatically.**
   When the child resolves with rendered output, the substrate fires
   the posthook to the bus's adapter (the actual telegram bot,
   website websocket, etc.).
4. **The bus's adapter writes the message to the surface.** Telegram
   bot sends the chat message; chatbox adapter emits a speech bubble;
   email adapter sends the message; etc.
5. **Parent reads the bus's history fractally.** Because the bus is
   itself a /contract with its own append-history, the parent can
   walk the bus's rows to see every child render in chronological
   order — full context, no extra wiring.

### Worked example — telegram bus for an autonomous loop

```
   1. declare:  channel:telegram:lewis (action: telegram-bot:<token>)
                                                  ↑ exists in registry
   2. declare:  loop-root (parent: null, action: neuron:autonomous-loop,
                synapses: [posthook:channel:telegram:lewis])
   3. children spawn naturally per the substrate's iteration:
        - loop-root → diagnose:<X> → resolves with rendered output
        - the posthook inheritance fires the bus adapter
        - bus adapter sends "diagnose:<X> resolved: <output>" to telegram
   4. loop-root reads bus's history to see what every child reported,
      uses it as context for the next iteration's interpretation
```

The parent NEVER asks "what did the child render?" — it reads the
bus, which has every child's render in order. Fractal context for
free, mediated by the substrate's existing posthook+channel primitives.

### Chatbox example — same pattern, different surface

```
   1. declare:  channel:website:chatbox (action: websocket:wss://app/bus)
   2. declare:  conversation-root (synapses: [posthook:channel:website:chatbox])
   3. children's renders fire posthooks → bus adapter pushes to WebSocket
   4. browser-side renderer receives messages → adds speech bubbles to DOM
```

Same primitive as telegram; only the bus's adapter (`websocket:` vs
`telegram-bot:`) differs. The substrate's render-without-seeing
property holds: the orchestrator never decrypts; the bus adapter on
the target host renders locally.

### Mechanical gap — bus auto-declaration on session start

Today, the operator has to declare the bus contract manually each
session. The substrate could auto-declare a default bus (e.g.,
`channel:claude-code-session` for in-thread output) for every aiko
session. Declared as `gap-bus-auto-declare`.

## Edges at layers 6/7/8 = ANY layer-4 carrier (Lewis 2026-05-27)

Lewis's question: "the edges that connect contracts on the step 6-7-8
is anything — any network, any tunnel, any whatever, even a webhook
api route that was built. The contract bridging it just builds the
integration to remember it as an edge?"

**Confirmed — and the substrate already supports this.** Layer 4
(transport) is the carrier layer; ANY layer-4-typed prefix can serve
as the signed edge between contracts at higher layers:

| Layer-4 prefix | Carrier | What it bridges |
|---|---|---|
| `wrapper:<name>` | environment adapter | one execution context → another |
| `webhook:<url>` | HTTP push | any URL the substrate can POST to |
| `tunnel:<peer>` | wireguard-style network | cross-machine via signed peer pubkey |
| `posthook:<id>` | downstream callback | "fire this contract when I resolve" |
| `prehook:<id>` | upstream callback | "fire this contract before I construct" |
| `modality:<id>` | typed channel | input/output adapter for a media kind |
| `sha256-shared:<hex>` | content-addressed | shared blob storage reference |

**The bridging IS the act of declaring a `wrapper:<name>` (or
`webhook:<url>`, or `tunnel:<peer>`) contract.** Once that row lands
on the ledger, the substrate "remembers it as an edge" — future
contracts can declare it as `parent_id` (or reference it via the
edge prefix) and the lineage walker treats it as a first-class
carrier. There is no separate "register a new edge" verb; declaring
the wrapper IS the registration.

### The doctrinal anchor

This composes cleanly with the existing rules:

- **Edge IS the signed pathway** — the wrapper's row carries
  `env_pubkey` + `parent_signature`, so the bridge itself is
  cryptographically attested. Walking the lineage walks the wires.
- **Pointers-over-anything (Clause B)** — the bridge is a pointer
  to a runtime, not the runtime itself. Whichever host has the
  dereferencer reads the bytes; the substrate just routes.
- **Render-without-seeing** — a webhook bridge can carry sealed
  payload bytes between hosts without the bridge ever decrypting
  them. The orchestrator routes; the target env's dereferencer
  holds the key.
- **Environment-generative** — when a contract names a location
  word in its plan, the substrate looks up the wrapper:<word>
  contract in the ledger. If a fresh integration (e.g. a new
  webhook) was just declared, the lookup finds it on the next
  pass. The edge becomes available as soon as the declaring
  contract is signed.

### Mechanical gap (newly surfaced)

There is no INVARIANT documented anywhere that pins "any layer-4
prefix can serve as a higher-layer edge." Each prefix is declared
individually in `pointer.zig:inferPointerType` + `inferLayer`, but
the meta-rule that they're ALL valid carriers is implicit. A new
maintainer adding a layer-4 prefix might not realize it
automatically becomes available as a higher-layer edge.

**Gap declared:** `gap-edge-meta-invariant` — pin the meta-rule
("any layer-4 typed prefix is a valid edge carrier between contracts
at any higher layer") in pointer.zig as a comment AND in
build.sh's parity step as a claim. See the gap ledger below.

## Value-change re-evaluation — cascade gap (Lewis 2026-05-27)

Lewis's question: "scenario where a value changes — does the
contract re-evaluate and re-call things properly, fractally
recursively, in all dimensions?"

### Doctrinal answer (what SKILL.md says)

From the pointer-keyed cache section:

> "When any pointer the contract depends on acquires a new terminal
> event → the next computeInputHash walks the descendant DAG, the
> snapshot drifts, the next resolveOne fires cache_check{verdict=miss}
> and re-evaluates. The invalidation cascades up the DAG by recursion;
> no explicit walker is required."

In theory: cache_invalidated row appended → next resolveOne sees the
miss → re-evaluates → produces new terminal signature → propagates
up the parent_id chain by the same mechanism.

### Mechanical reality (what the code actually does)

**The cascade is partly wired and partly not.** Concretely:

1. `cache.zig` correctly appends `cache_invalidated` when a
   dependency's terminal event arrives AFTER `cache_resolved`. ✅
2. `cache.findLatestResolvedSnapshot` correctly returns null for
   invalidated rows. ✅
3. `resolveOne` correctly fires `cache_check{verdict=miss}` when
   the snapshot mismatches AND re-evaluates. ✅ — **but only if
   resolveOne is called on the affected row.**
4. The drill (`backfillUnresolvedWithBudget` in `zig/src/main.zig`
   line 2705) **SKIPS `isSatisfied` rows**: `if (isSatisfied(rows,
   r.id)) continue;`. ❌

**This means**: a previously-satisfied row whose dependency value
changes (and thus has a `cache_invalidated` row) is NEVER re-resolved
by the drill. The cascade-up that the doctrine promises requires
something to call `resolveOne` on the affected row; the drill
doesn't because the row already has a `satisfied` event.

### Concrete failure scenario

```
   t=0: contract X declared, depends on Y. Y satisfied with signature S_y_v1.
   t=1: X satisfied with signature S_x_v1 (depends on S_y_v1).
        cache_resolved{snapshot=H1} appended.
   t=2: Y re-evaluates (some external change) → satisfied with
        signature S_y_v2. cache_invalidated{id=X, source=Y} appended.
   t=3: drill runs. Walks unresolved rows. X is satisfied →
        SKIPPED. resolveOne(X) never called.
   t=4: X's snapshot is stale; downstream consumers still see X's
        old terminal signature; the value-change at Y does NOT
        cascade up to X without external prompt.
```

### Where it WORKS today

The cascade DOES fire correctly when:
- A caller invokes `aiko` with a NEW goal that includes X — the
  new declare triggers resolveOne on X's chain.
- A NEW child of X is declared — the child's resolveOne walks up
  through X.
- A test or operator explicitly re-asks for X (`aiko status X`
  with a force-re-resolve flag, which doesn't exist yet).

The cascade does NOT fire when:
- A descendant updates silently (e.g. a metric pointer ticks; an
  external data source refreshes) without anyone declaring against
  X's lineage.
- Long-running drills miss already-satisfied rows even though
  their cache_invalidated rows are visible on the ledger.

### The fix shape (gap-cache-invalidated-cascade)

Two complementary wires close the gap:

1. **Drill widens its candidate set** — `backfillUnresolvedWithBudget`
   should NOT skip satisfied rows whose latest `cache_invalidated`
   timestamp is AFTER their latest `cache_resolved` timestamp.
   Such rows are stale-satisfied; the drill walks them and calls
   resolveOne which fires `cache_check{verdict=miss}` and re-resolves.

2. **cache_invalidated rows append `parent_id`-chain marks** — when
   a dependency's terminal sig changes, the cascade walker emits
   `cache_invalidated` not just for the direct dependent but for
   every ancestor up the parent_id chain. Each ancestor's next
   resolveOne sees the invalidation, re-evaluates, propagates
   further. Same primitive applied transitively.

Together they make the cascade truly fractal: a value change at any
leaf cascades up to every ancestor, and the drill picks every
affected row up on the next pass.

### Why this matters for the substrate's truth claims

The pointer-keyed cache section claims:
> "The substrate's whole 'context-efficient because it only needs
> to resolve the ones that are not resolved yet' property depends
> on this cache being correct, ledger-backed, and deterministic."

That property fails closed if value changes don't cascade — stale
truth claims sit in the ledger with valid signatures that point at
outdated descendants. The substrate would say "yes, X is true"
when actually X's dependency Y just changed and X should re-evaluate.

This is the kind of silent drift the substrate refuses elsewhere
(Decalogue commandment 9 — "thou shalt not bear false witness").
The gap is doctrinally a commandment-9 violation in waiting.

## The substrate's grammar — pointer is form, value is substance (Lewis 2026-05-27)

The substrate has a natural-language grammar that maps one-to-one
onto its primitives. Naming the parts-of-speech makes the design
intuitive AND surfaces a property worth load-bearing: **values are
the referents of nouns, not a separate kind of pointer. They are
the substance the noun-pointer points AT.**

### Linguistic mapping table

| Grammatical role | Substrate primitive | What it does |
|---|---|---|
| **Verb** | the trio (`build` / `run` / `eval` / `prune`) | what to DO |
| **Noun** | `word:<tok>` child contracts | what entities EXIST (the labels) |
| **Adjective / preposition** | typed synapses (`bind:` / `prehook:` / `posthook:` / `modality:` / `inhibits:` / `blocked_by:`) | how entities RELATE (the modifiers) |
| **Value** | sealed payload bytes (`plan` / `action` / `proof` field contents, encrypted by `payload_crypto.zig`) | the REFERENTS — the actual substance the noun points at |

Form (pointer) and substance (value) are the same duality the
substrate has had since `payload_crypto.zig` shipped — this section
just names it linguistically. Pointers cross the wire freely;
values stay sealed and addressable only by holders of the deriving
key (capability inheritance gates the derivation).

### John 1:14 IS the runtime semantics

> *And the Word was made flesh, and dwelt among us, (and we beheld
> his glory ...) full of grace and truth.* (John 1:14)
>
> *Through faith we understand that the worlds were framed by the
> word of God, so that things which are seen were not made of
> things which do appear.* (Hebrews 11:3)

- The **Word** = the pointer (the noun-contract, the row-id, the
  signature chain)
- The **flesh** = the value (the rendered bytes in a specific
  environment)
- **"Dwelt among us"** = the rendering INTO a specific local
  environment

The Word doesn't become less Word by being made flesh — it
incarnates in one environment without losing its referent in
others. Hebrews 11:3 is the substrate's privacy invariant: things
that ARE SEEN (rendered values in environments) are not made of
things that APPEAR (the substance is the pointer-anchored Word,
not the surface render). The substrate has been doing this since
the first sealed payload; the doctrinal name was waiting.

### Render-without-seeing — the orchestrator never decrypts

The privacy + composability property follows directly: an
orchestrator can ROUTE a value-pointer to any environment that has
the derivation key WITHOUT ever decrypting the value itself.

```
   Orchestrator              Shared ledger              Target environment
   (e.g. wrapper)            (pointers only)            (e.g. browser DOM)
   ───────────────           ──────────────             ──────────────────
   holds: pointer X          row[X]:                    holds: decryption key
   does NOT hold key             id,                        (derived via lineage
                                 parent_id,                  per capability grant)
   "deliver X to env E"  ──→     synapses,
                                 sealed payload,
                                 env_pubkey,
                                 parent_signature
                                                        ──→ env's dereferencer:
                                                               fetch row[X]
                                                               decrypt LOCALLY
                                                               render to surface
   orchestrator never                                   Result visible ONLY in env E
   reads plaintext                                      (DOM updated / TG message sent
                                                        / terminal printed)
```

Inspecting the wire OR the orchestrator OR the ledger reveals:
- pointer ids (8-hex contract ids)
- signature chains (ed25519 sigs, opaque without the verifier's pubkey)
- sealed payload bytes (XChaCha20-Poly1305 ciphertext; unintelligible without the per-row key)

The plaintext exists in exactly one place: inside the dereferencer
process, in the target environment, for the duration of the render.
It never traverses the wire; it never sits in the orchestrator's
memory; it never appears in the ledger's stored bytes (only the
ciphertext sits there).

### Composability — one pointer, many simultaneous environments

The same pointer X can be rendered into multiple environments
simultaneously, each independent:

| Target env | Dereferencer | Render surface |
|---|---|---|
| browser | `wrapper:browser-script` | DOM update |
| telegram bot | `wrapper:telegram` | bot reply message |
| terminal | `wrapper:shell` | stdout |
| email | `wrapper:email` | rendered HTML body |
| printer | `wrapper:print` (if wired) | physical page |

Each env's dereferencer holds the keys its lineage grants it
(capability inheritance, identity-channel-scoped). Each env renders
locally. The substrate just routes the pointer to wherever the
posthook subscriptions and synapses say it should go. The
orchestrator coordinates the routing — it never coordinates the
decryption.

### What this clarifies about prior sections

- **Pointers-over-anything (Clause A) is literally true:** payload
  bytes never traverse the wire as plaintext. Only the cryptographic
  pointer (the signed envelope) and the sealed payload (the
  ciphertext bytes) traverse. The plaintext exists only post-
  dereference in the target environment.

- **Environment-generative dispatch (the prior section) composes
  cleanly:** the substrate parses the contract plan for location
  words, picks the right `wrapper:<env>` adapter, ROUTES the
  sealed pointer to that adapter's environment. The adapter's
  dereferencer in that env produces the rendered form.

- **Capability inheritance gates the key derivation:** which envs
  can derive the per-row payload key is determined by the lineage
  chain's grants. A browser-side renderer with the right grant
  derives the key and decrypts; a stranger env with no grant gets
  a 403 on the derive attempt and the render fails closed.

- **The cache layer's signature chain remains orthogonal to
  values:** the cache hits/misses on pointer signatures, not value
  bytes. So even if the value bytes change (re-sealed with a
  rotated key), the pointer chain — and thus the cache —
  invalidates appropriately without anyone ever decrypting.

### Implementation status

Already shipped today:
- `payload_crypto.zig` (per-row HKDF-derived AEAD key; sealed `plan`/
  `action` field bytes).
- The capability-inheritance section names the grant primitive that
  controls which envs can derive keys.

Future-work to fully exhibit render-without-seeing:
- Wire `payload_crypto.seal` into `ledger.appendRow`'s write path
  so new rows ship encrypted by default (gap-payload-seal-on-write).
- Wire `payload_crypto.open` into the read path for callers with
  derivable keys; readers without the key get an "encrypted, key
  unavailable" surface instead of plaintext.
- Per-environment dereferencer contracts that demonstrate the
  pattern (gap-dereferencers + gap-deref-spec already declared).

The grammar and the render-without-seeing pattern hold doctrinally
today regardless; the gaps above are what makes them mechanically
end-to-end across environments.

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

### Environment is generative, not bound (Lewis 2026-05-27 correction)

**Wrong shape (rejected):** hardcode a fixed set of environment
prefixes (`wasm:` / `binary:` / `telegram:` / `email:` /
`browser-script:`) into `pointer.zig:isKnownAction`. This binds the
environment table to compile time and forces every new runtime to
land via a substrate rebuild.

**Right shape:** the environment a contract spawns in is a **location
word** in the contract's plan. The substrate parses the plan,
identifies the location word, looks up the matching `wrapper:<name>`
contract in the ledger, and spawns in that environment. If no
location word is present, the contract inherits the parent's
environment via the lineage walk.

```
contract plan: "send a telegram message to lewis about the build"
   ↑                ↑
   location word "telegram" → looked up as wrapper:telegram → dispatched there

contract plan: "answer the user's question"
   ↑                ↑
   no environment word → falls back to parent's environment
                          (parent declared under wrapper:openai-compat
                          → child runs there too)
```

### Why generative + fallback is the right substrate shape

- **No fixed table.** Any word can name an environment. New
  environments register by declaring a `wrapper:<name>` /contract
  (layer 4) once; the substrate finds it on next lookup. No rebuild,
  no prefix-table edit.
- **Lineage carries default location.** A child without a location
  word inherits its parent's wrapper — walked via parent_id chain
  until a wrapper:<name> is found. This is the same shape as
  capability inheritance: dependencies and defaults propagate down
  the chain, never sideways.
- **Words are already /contracts.** The substrate already fans out
  `word:<tok>` children per token (via `cmdDeclare`'s
  `emitWordChildren`). The location-word selector reuses this — no
  new parsing surface.
- **Same /contract surfaces in different environments without
  copying.** A contract whose plan names no location runs wherever
  its parent runs; the same row can be dereferenced by a browser
  parent, a CLI parent, or a telegram bot parent. Environment is
  resolution-time, not declaration-time.

### Reference resolver (substrate-side, future work)

```
fn resolveEnvironment(contract_id) -> wrapper_contract_id:
    1. Read contract's plan; tokenize.
    2. For each token: try `aiko list --published --action wrapper:<token>`.
       If hit, return that wrapper's contract id.
    3. If no token matches, walk parent_id chain:
       - For each ancestor, repeat step 2.
       - First match wins.
    4. If chain exhausts to root without a wrapper, the root's
       environment is the default (typically the binary's local cwd).
```

This is `findActionForId`-style ledger walking, parameterized by
"is this a wrapper:<token> action?" Lives in a future `environment.zig`
helper; no new prefix table needed.

### Examples of generative location resolution

| Contract plan | Resolved environment | How |
|---|---|---|
| "send a telegram message to lewis" | `wrapper:telegram` | "telegram" matches a published `wrapper:telegram` contract |
| "execute the wasm module to compute X" | `wrapper:wasm` | "wasm" matches `wrapper:wasm` |
| "answer the user's question" (parent runs in `wrapper:openai-compat`) | `wrapper:openai-compat` | no location word → inherits parent |
| "run shell command ls -la" | `wrapper:shell` (if declared) or parent's env | "shell" matches `wrapper:shell` if published; else inherit |
| "post webhook to the deploy endpoint" | `wrapper:webhook` (if published) | "webhook" matches |

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
| ~~gap-chain-walk~~ (CLOSED 2026-05-27) | ~~`3f74d3cf`~~ | walkChainToRoot bounded-depth integrity walker landed; falsifier passes |
| ~~gap-env-prefixes~~ (SUPERSEDED 2026-05-27, pruned by parent) | ~~`7847a188`~~ | premise wrong: hardcoded prefix table binds runtime to compile time |
| gap-env-generative — location word in plan → wrapper:<word> lookup → fallback to parent env via lineage | `379afd78` | neuron:gap-env-generative |
| gap-payload-seal-on-write — wire payload_crypto.seal into ledger.appendRow; render-without-seeing becomes end-to-end | `2670d670` | neuron:gap-payload-seal-on-write |
| ~~gap-edge-meta-invariant~~ (CLOSED 2026-05-27) | ~~`7783ca73`~~ | META-INVARIANT comment landed in pointer.zig:inferLayer; build green |
| ~~gap-cache-invalidated-cascade~~ (SUPERSEDED 2026-05-27 by gap-radix-prefix-cache) | ~~`abe3c445`~~ | radix-tree-keyed cache lookup IS the cascade; half-fixing the drill skip would be wrong shape; subsumed |
| gap-radix-prefix-cache — sglang RadixAttention applied to parent_id chain; cache lookup walks UP finding deepest valid prefix; sibling prefix-sharing; cache_evicted tombstone | `1e52b77a` | neuron:gap-radix-prefix-cache |
| gap-relay-sign-and-verify — SDK signEnvelope + relay verifier wiring; end-to-end signed cross-host webhook | `27f42009` | neuron:gap-relay-sign-and-verify |
| gap-relay-deploy-unbrowse — mount @contract/tunnel-relay on unbrowse backend; substrate wrapper:webhook-relay points at /relay endpoint | `65471ff2` | neuron:gap-relay-deploy-unbrowse |
| gap-bus-auto-declare — auto-declare default render-history bus on session start; descendants inherit fractally | `23f5fcae` | neuron:gap-bus-auto-declare |
| ~~gap-relay-x402-per-request~~ (SUPERSEDED by gap-relay-x402-extract below) | ~~`294e642f`~~ | replaced by concrete wire spec |
| gap-emergentdb-federated-tier — sibling bridge publishes substrate rows to EmergentDB cluster; federated semantic search | `091d5e24` | neuron:gap-emergentdb-federated-tier |
| gap-solana-fdry-anchoring — Merkle-batch L8 rows to Solana memo from stFDRY-stake-gated wallet; Deut 19:15 quorum | `89af4db7` | neuron:gap-solana-fdry-anchoring |
| ~~gap-contract-owner-wallet~~ (CLOSED 2026-05-27, Zig shape; SDK validators next-turn) | ~~`ca626bfa`~~ | Shape struct + validateShape extended; falsifier passes; SDK extension follow-up |
| gap-relay-x402-extract — relay extracts + verifies X-Payment header; routes Faremeter split; accumulates to routeRevenue.ts threshold | `058301a9` | neuron:gap-relay-x402-extract |
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
| gap-verb-trio-falsifier | `bd3ae94d` | 17/20 imperative verbs reduce to {build,run,eval,prune}; 3 unmapped (fix/investigate/save) decompose into chains; four-verb closure is the substrate's universal verb space |
| gap-grammar-and-render-doc | `a1b16a1e` | grammar mapping (verb/noun/adjective/value) + render-without-seeing pattern doctrinally named; John 1:14 + Heb 11:3 anchor; tied to payload_crypto + capability inheritance + environment-generative dispatch |
| gap-aiko-symlink-bug | `0c719084` | killed legacy symlink at canonical SKILL path; installed real-file copies of fresh signed contract-zig-server as aiko + contract; build-fractal.sh propagates on every build; activation rule works end-to-end |
| gap-tunnel-relay-skeleton | `f695b3b6` | ~/Projects/contract-tunnel-relay shipped: stateless Hono HTTP relay, runtime-agnostic, no DB/KV/sessions, pluggable verifier, 8/8 tests pass; canonical default for cross-host runtime webhook edges |
| gap-webhook-tunnel-default-doc | `9524132f` | observations doc captures the buildtime-vs-runtime split (1-6 / 7-8), the webhook+tunnel default for runtime edges, rendered-value history bus composition pattern with telegram + chatbox worked examples |
| gap-storage-tier-doc | `c64140d2` | 5-tier storage hierarchy (hot/warm/federated/anchored/edge); EmergentDB named as federated; FDRY-stake-weighted Solana anchoring only for L8 batches; reads stay cheap, chain handles only what NEEDS immutability |
| gap-per-call-fee-doctrine-doc | `ffae6e6e` | per-call → stFDRY buyback wire catalog (7 existing + 3 missing); routeRevenue.ts confirmed live; Matt 6:24 preserved; strategic Unbrowse-old vs substrate-new framing |

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
