# Aiko — what to build, and what not to

This replaces a 3,279-word architecture document. Elon's algorithm says the most
common mistake is optimising a thing that should not exist, so this starts by
deleting, and what survives is small. The previous version is in git history;
read it for the reasoning, not as a worklist.

---

## 1. The requirements, and who they came from

A requirement is only as good as the person attached to it. Three came from
Lewis, in the meeting, in his own words:

| # | Requirement | Source |
|---|---|---|
| R1 | Production workflows must work **without a hard Aiko dependency**. Aiko augments; it does not become the single point of failure | Lewis, explicit |
| R2 | **Zero setup**: credentials and context in one shot, no back-and-forth configuration loop | Lewis, explicit |
| R3 | The human **reviews the outcome, not the process** | Lewis, explicit |

Everything else in the prior document was marked `[PROPOSED]`, which means it
came from nobody. That is not a reason to discard it, but it is a reason to hold
it to a far lower prior than the three lines above.

**R1 is already an architecture, not a promise.** `neuron` builds and passes its
suite with `contract` absent. That is the mechanical evidence that a delivered
system survives Aiko being unavailable or handed off. Do not fuse the trees.

---

## 2. Delete: most of the proposal already exists

| Proposed | Already built | Evidence |
|---|---|---|
| Pointer graph, cache invalidation | `produced_by` + `evidence[].sources` → `telemetry stale` | `redrive-gate` |
| Selective recomputation | `redrive` — **and it has a third case the proposal lacks** | `redrive-gate` |
| Cache keyed on inputs + version | digest-pinned admission, firing identity | `skill-doc-gate` |
| Skill registry | admitted limbs, digest-keyed | `skill-doc-gate` |
| Node contract | `neuron.json` + `SKILL.md` + `caps_request` | `skill-doc-gate` |
| Self-building lifecycle | `morphogenesis.resolveGap`: discover → derive → test → admit → attach → retry → judge | `interface-morphogenesis-gate` |
| Missing-skill generation | `Route.authored`, **bounded** by a catalogue that never reads the gap | `authored-gap-gate` |
| Deterministic assignment | staffing engine, `(last_worked, name)` total order | `staffing-engine-gate` |
| Reply / no-reply / terminal call | escalation ladder, per-worker, terminating | `escalation-ladder-gate` |
| Single API surface | `aiko-doctor mcp`, six tools | `dispatch-gate` |

The proposal's most consequential omission is its `on_contradiction:
INVALIDATE_AND_PROPAGATE`. Re-deriving "notify 35 workers" **re-messages the 31
who did not change**. `redrive` case 3 already refuses that. Adopting the
proposal as written would undo a solved problem.

---

## 3. Delete: four things that would make the system worse

**`confidence: Float [0.0, 1.0]`.** The wire already carries
`confidence_milli: u16`, bounded, rejected above 1000, and hashed into the firing
identity. Floats do not hash stably, so a float confidence cannot be part of a
deterministic identity and the recompute loop would never settle.

**`rotation_fairness_score > 0.7`, `minimum_to_proceed: 0.6`.** These numbers
came from nobody and gate execution. An unfalsifiable threshold on the control
path is the "certifies nothing" defect, wearing a number.

**`cache_status: VALID | STALE | INVALID | COMPUTING | ERROR`.** Staleness is
*derived* from `produced_by` plus source movement. Storing it creates a second
source of truth that can disagree with the first — a defect this repository has
already shipped once, when the observer and `redrive` classified the same row
differently.

**`id: UUID`, `version: SemVer`.** A digest *is* the version and cannot drift
from its content. SemVer is a human promise. An audit found a live bypass where
the digest did not cover every byte of a package; the fix was to cover them, not
to add a second identifier that can lie.

Keep the word "neuron" — the runtime is already called that. Delete the
biological mapping table: it is asserted to be "the design principle, not
metaphor", and then does no mechanical work.

---

## 4. Simplify: the whole thing is eight verbs

Six exist. Two do not.

```
aiko.ledger.read     what happened            ✅
aiko.port.publish    admit an inbound surface ✅
aiko.port.attach     bind a handler           ✅
aiko.gap.resolve     objective in             ✅   ← reuse | discover | author
aiko.redrive         the reactive pass        ✅   ← re-derive | escalate | compensate
aiko.bridge          firing → W6H ledger row  ✅

aiko.claim.register  { statement, expect_by, evidence_kind, on_contradiction }   ⬜
aiko.claim.observe   { claim_id, observation } → confirmed | contradicted | pending  ⬜
```

That is the simplification. **Not a new architecture — two new verbs.**

---

## 5. What the two verbs are for

The one genuinely new idea in the proposal is a claim that carries its own
refutation condition and a deadline: *"expect X by T, else contradict."* It is
worth building because the system already has the special case — the escalation
ladder is exactly this shape — and generalising it lets any node make a
falsifiable claim about the world instead of only the staffing path.

It rests on machinery that exists: `valid_from` / `valid_until`, cadence, and
occurrence-keyed invalidation in contract.

**The bound, and it is not optional.** A contradiction must route through
`redrive`'s three cases, not around them. A claim whose dependent already crossed
a boundary produces a **CompensationGap**, never a re-fire. The proposal's
`INVALIDATE_AND_PROPAGATE` has no such case, which is the one thing that must not
be copied.

**The witness, which fails today:** a claim whose deadline passes with no
evidence contradicts itself and fires its dependent — *without re-crossing any
boundary already crossed*, asserted per recipient rather than in aggregate.

---

## 6. The second thing worth building, later

Shadow-run and promote: a versioned change, replayed against history, run in
parallel without side effects, promoted or rolled back on comparison. Genuinely
absent, and it is the safe form of self-improvement — **acceptance held fixed,
implementation varies**. "Rewrite until the acceptance passes" terminates;
"rewrite to whatever seems better" does not.

Do not build it before the claim verbs. It needs evidence to compare, and the
claim verbs are what produce evidence.

---

## 7. Still absent, and honestly named

| | |
|---|---|
| OCR ingestion (Step 1) | no read tool at the MCP edge; an OCR HTTP API works today |
| Operator UI | not started; the live view is read-only by design |
| Credential passing | none, in any layer — and R2 depends on it |
| Constraint solving beyond rotation | no shift-conflict resolution, no multi-constraint optimisation |

R2 (zero setup) is **blocked on credential passing**, not on architecture. That
is the gap between this repository and the meeting's headline promise, and no
amount of graph design closes it.

---

## 8. How to read a claim in this document

Every row in §2 names a gate. Run it. `zig build gate` is the acceptance
criterion, and a claim here that no gate covers is a claim to distrust —
including the ones written above.
