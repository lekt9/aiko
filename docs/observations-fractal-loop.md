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

---

## 2. Gaps in the current code vs. this model

Audited 2026-05-26. Listed in order of severity (1 = most load-bearing).

### Gap 1 — SDK still exposes pre-trio verbs

Python + TS SDK ship `declare` / `mark_satisfied` (Python) and
`declare` / `markSatisfied` (TS) **alongside** the canonical `build`
/ `run` / `eval`. Two names per concept = drift surface; LLM-shaped
callers see both and pick inconsistently.

Substrate has collapsed to the trio (binary verbs `build`/`run`/`eval`).
SDK should mirror.

**Fix**: remove `declare` / `mark_satisfied` from SDK __all__ /
exports. Keep build/run/eval only.

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

`contract-openai-api/src/translator.ts` exports
`shaperBypassed()` and `walker.ts` has a `BYPASS_LLM_SHAPER=1`
branch that falls back to hardcoded R1–R8 action mappings.

Per Lewis's "no escape hatches" rule, this is exactly the kind of
dev-only flag that becomes production foot-gun.

**Fix**: delete the bypass branch and the legacy*Shape helpers.
LLM-shaper is the only path; if it fails, the request fails.

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
