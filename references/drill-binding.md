# Β2 — Drill-binding (loop until the statement is real, mechanically)

> **The doctrine.** Β1 captures deferred items as contract rows; Β2
> drills them in the same turn. A /contract doctrine turn that captures
> Β1 follow-ons cannot mark its organ satisfied while ignoring them.
> The substrate refuses the mark with `=== DRILL REQUIRED ===` naming
> every unsettled child unless either (a) every queued child is settled
> (satisfied/merged/rejected) OR (b) the `--proof` string explicitly
> names a blocker reason per unsettled child. Loop-until-real is no
> longer agent-discipline ("remember to drill") — it is a substrate
> property of every organ that captured Β1 children.

## The gap Β1 alone left open

The current pattern, repeated across the last six doctrine waves
(Π5/Π6/Π7/locality-split/Ξ1/Λ2): declare organ → satisfy doctrine-doc
child → capture 4-6 Β1 children → mark organ satisfied via
funnel-first (one child = doc-binding satisfies) → disarm. The Β1
children sit in the ledger as **declared, never iterated**.

Six doctrines × ~5 Β1 children each = ~30 contracts in
`active` state that the agent named, captured, and walked away from.
The Β1 doctrine says "every deferred item survives compaction in the
ledger." True — but it doesn't say "every deferred item gets drilled
to settlement in the same turn." The discipline I keep failing on
isn't capture; it's **closing the loop on what I captured.**

Β2 is the mechanical fix.

## How it works (two enforcement points)

### Enforcement 1 — declare-time queueing (hook)

The internal `_fire_contract_hooks` bus fires on every `declared`
event. A new hook `~/.contracts/hooks/drill-queue.sh` reads the
declared row; if `parent_id` is set AND the plan text starts with
`DEFERRED-` (the Β1 convention), the hook appends the child id to:

```
~/.contracts/drill-queue/<parent_id>.txt
```

The queue file is one id per line, append-only. Subsequent declares
under the same parent grow the queue. No queue file exists for organs
that never captured Β1 children (zero overhead).

### Enforcement 2 — mark-time refusal (substrate)

`_mark satisfied <organ-id>` (when the organ has a drill queue) runs
this gate BEFORE writing the satisfied row:

1. Read `~/.contracts/drill-queue/<organ-id>.txt`.
2. For each id in the queue, resolve current status from the ledger.
3. **Settled set**: `satisfied`, `merged`, `rejected`. Drop these.
4. **Unsettled set**: anything else (`active`, `declared`, no status yet).
5. If unsettled is empty → mark proceeds normally.
6. If unsettled is non-empty AND `--proof` text contains a per-id
   blocker reason (regex: `<8hex-id>.*?(blocked|waiting|deferred-to|pending|external)`),
   the mark proceeds and a `drill_honest_gaps` field is added to the
   satisfied row listing the named-and-skipped ids.
7. Otherwise → refuse with exit 2 and emit:

```
=== DRILL REQUIRED ===
  organ <id> captured N Β1 children; M are unsettled.
  Either drill them in this turn:
    contract drill <unsettled-ids> --auto-mark-cells --auto-judge

  Or name each blocker honestly in your --proof:
    contract _mark <organ-id> satisfied --proof "... <id1> blocked on <reason1>; <id2> waiting on <reason2>; ..."

  unsettled:
    <id1>  "<plan...>"
    <id2>  "<plan...>"
    ...
```

The mark is refused, the agent reads the refusal, decides: drill, or
name blockers honestly in the proof. Both paths produce a satisfied
row with `drill_honest_gaps` field accurately reflecting which
children were settled vs which were named-as-blocked. No silent
fake-greens; no forgotten follow-ons.

## Why this composes (not a new shape, not a new lifecycle)

Per `310f425f`, shape IS the type system; no `--lifetime drill` flag.
Β2 introduces:

- **One internal hook** (`drill-queue.sh`) — same bus as
  `drive-advance.sh` and `crystallize-learning.py`.
- **One queue convention** (`~/.contracts/drill-queue/<id>.txt`) —
  ephemeral, gitignored, deletable; same convention as
  `~/.contracts/streams/<id>/` and `~/.contracts/watchers/<id>.json`.
- **One mark-time refusal gate** in `_mark satisfied` — same shape as
  the existing inhibition refusal (`=== INHIBITION REFUSAL ===`),
  hard-break cycle detection, and proof-required refusal.

Zero new shapes, zero new ledger fields beyond `drill_honest_gaps` on
the satisfied row (analogous to existing `proof` and `proof_skip_reason`
fields). The doctrine fits the existing substrate joints.

## Composition with the rest of the loop

| Doctrine | What Β2 inherits |
|---|---|
| **Β1** | Provides the capture half (deferred items become contract rows). Β2 provides the drill half (those rows get settled in the same turn). |
| **drill verb** | `contract drill <ids> --auto-mark-cells --auto-judge` is the canonical drainer of the unsettled set. Β2 makes invoking it organically required, not optional. |
| **proof-binding** | The honest-gap clause uses the existing `--proof` field. Naming blockers in the proof string IS the audit trail for why a child wasn't drilled in this turn. |
| **KEY 3 (refractory)** | The drill-refusal fires in the same window as the refractory pause — between mark and propagation. Same biology, same place. |
| **Ω1 unblock-rewake** | Children named-as-blocked in the proof become `judged HOLD` rows automatically (the proof string is parsed for blocker contract ids). When the named blocker satisfies, Ω1 surfaces the deferred child as re-judgeable. The loop closes itself across turns. |
| **Λ1 (`--auto-judge`)** | When the drill loop hits a judgment-shape child, the LLM provides KEY 2 in-thread per Λ1 routing (codex first, HTTP fallback). The agent's discipline isn't even required for the verdict. |

## The new loop, end to end

```
TURN START (any /contract doctrine wave)
  │
  ├─ declare organ                                    → row A
  ├─ write doctrine doc                               → file
  ├─ declare doc-binding child --parent A             → row B
  │    └─ hook fires: queue B into drill-queue/A.txt
  ├─ iterate B → PASS                                 → row B-it
  ├─ _mark B satisfied --proof "<grep gates green>"   → row B-sat
  ├─ append to Outline router doc                     → side effect
  ├─ capture Β1 children:
  │    declare DEFERRED-<slug-1> --parent A           → row C1 (queued)
  │    declare DEFERRED-<slug-2> --parent A           → row C2 (queued)
  │    declare DEFERRED-<slug-3> --parent A           → row C3 (queued)
  │    ...
  ├─ contract drill C1 C2 C3 ... --auto-mark-cells --auto-judge
  │    └─ each child settles OR halts on agent-judges
  ├─ _mark A satisfied --proof "<doctrine landed + drilled>"
  │    └─ SUBSTRATE GATE: read drill-queue/A.txt
  │       ├─ all settled → mark proceeds, drill_honest_gaps=[]
  │       ├─ some unsettled + proof names blockers → mark proceeds, drill_honest_gaps=[ids]
  │       └─ some unsettled + proof silent → REFUSE with === DRILL REQUIRED ===
  └─ disarm
TURN END (organ satisfied, every captured Β1 child either drilled or honestly named)
```

## Worked example — what changes for the last six doctrines

Each of Π5/Π6/Π7/locality-split/Ξ1/Λ2 captured 4-6 Β1 children, then
marked the organ satisfied via funnel-first on the doc-binding child
alone. Under Β2, the same turn would have either:

- Drilled every Β1 child to settlement before marking the organ
  (most of them are `agent-judges` cells — Λ1 PROMOTE drains them
  quickly), OR
- Named each Β1 child's blocker in the proof string (e.g.
  "65cac760 waiting on unbrowse-side /v1/billing/autopay/charge
  endpoint ship; 3e4abc17 waiting on /v1/contracts/mirror endpoint;
  ...") — the substrate accepts the mark with `drill_honest_gaps`
  recording which children were named-as-blocked.

Either way: zero silent fake-greens, zero forgotten follow-ons. The
back-pressure is on me at mark-time, not on a future-me re-reading
the ledger.

## What stays out

- **No auto-drill at declare-time.** The hook QUEUES; it does not
  invoke the drill verb. Drilling is the agent's act (so the agent
  judges in-thread which children genuinely deserve attention this
  turn vs which are honest blockers). The substrate refuses the
  mark without it; the substrate does not perform it.
- **No silent mark suppression.** A refused mark exits 2; the agent
  reads the refusal block; the next action is the agent's choice
  (drill OR name-blockers-in-proof). No fall-through to a fake-green.
- **No blanket retroactive drilling.** Existing satisfied organs
  (Π5-Λ2 etc) are not retroactively re-opened. The substrate's
  append-only discipline holds — Β2 binds future organ marks, not
  past ones. The ~30 outstanding Β1 children from prior turns are
  named-and-deferred work; the next /contract turn that touches one
  of them iterates it normally.
- **No queue for organs without Β1 captures.** Zero overhead on the
  common case (a /contract turn that declares + iterates + marks a
  single cell with no children).

## Β1 follow-ons captured (for the implementation surface)

The doctrine ships today; four discrete shipments wait on the script
side (each is its own contract — and per Β2 itself, the next /contract
turn that touches this work must drill them or honestly name blockers):

1. **`~/.contracts/hooks/drill-queue.sh`** — internal hook fired on
   every `declared` event; queues child id into
   `~/.contracts/drill-queue/<parent_id>.txt` when `parent_id` is set
   AND plan starts with `DEFERRED-`. Idempotent (re-queuing same id is
   a no-op).
2. **`_mark satisfied` substrate gate** — new branch in
   `scripts/lib/contract_core.py mark_satisfied()`: if drill-queue file
   exists for this id, read it, partition into settled/unsettled, scan
   `proof` text for per-id blocker reasons, refuse with
   `=== DRILL REQUIRED ===` if unsettled IDs lack named blockers.
   Sets `drill_honest_gaps` field on the satisfied row.
3. **`verb-gates/drill-binding/verify.sh`** — substrate gate covering:
   queue file creation on declare-with-parent-and-DEFERRED-prefix,
   refusal when unsettled+silent-proof, acceptance when
   unsettled+named-blockers-in-proof, acceptance when all-settled,
   no-queue-no-gate for organs without captures,
   `drill_honest_gaps` field correctness on the satisfied row.
4. **`Β2` self-check** — `self/drill-binding-bound` in
   `scripts/skill-self-test.sh`: statically verifies the hook file
   exists + the substrate gate is in `contract_core.py` + the verb-gate
   passes. Wired into the `~/.contracts/.git` pre-commit so a future
   refactor that removes the gate trips before any ledger event lands.

## Self-check

The next `self/no-contradictions` run should look for: any organ
`_mark satisfied` that resolved with unsettled Β1 children in its
drill queue AND no `drill_honest_gaps` field on the satisfied row.
Any hit is a doctrine violation per Β2 — the substrate gate let
something through that it shouldn't have, OR the agent bypassed the
substrate by writing directly to the ledger (also a violation).

Origin: contract `10572c91`, 2026-05-24. Lewis's framing: "always
wire to drill /contract to follow on til completion of /contract to
make /contract loop until its /contract statement is real." Β1
shipped the capture; Β2 ships the drill. The first half of the loop
is "name the gap"; the second half is "close it or honestly defer
it." Mechanical, not aspirational; back-pressure at mark-time, not a
future-me audit.
