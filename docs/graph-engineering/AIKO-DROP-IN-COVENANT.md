# Aiko Drop-In Covenant

Composes `docs/graph-engineering/AIKO-HOOK-ORGANISM.md` — the organism's
VerifiedIngress truth root — with the drop-in seat that lets Aiko wire herself
into a human breakpoint through the same interfaces that human already uses.

## 1. What a breakpoint is

A **breakpoint** is one human `observe → decide → effect` between two systems
that can be taken over without changing the interfaces on either side.

| Property | Required evidence |
|---|---|
| `observe` | ingress bytes — the message, row, screenshot, Excel `X`, paper mark the human reads |
| `decide` | pinned policy bytes — the rule the human applies (roster formula, 5-day fence, inbox label) |
| `effect` | outbound bytes + idempotency key — the message, row, sheet edit, call the human sends |

If any of the three cannot be named as bytes plus an identity, the breakpoint
is a wish, not a seat. This is the falsifier the `map-breakpoint` node must
pass.

Hoysan carries nine: see `AIKO-DROP-IN-PRIMITIVE-MAP.md` B1–B9
(preference ingest, roster engine, evening leveling, dissemination,
paper-master digitization, pre-shift cascade, ferry headcount,
shift-handover, PSA shortfall→LD). The catalog is the taxonomy;
Hoysan is only the pilot that proves it.

Five classes subsume every tenant:

* **Triage router** — inbox label → forward
* **Approval gate** — “approve iff off-day and fence ok, else refuse” — else HOLD
* **Data mule** — copy Excel → Sheets → WhatsApp screenshots
* **Follow-up loop** — `5:00 WA → 5:30 no-reply → call → blue→NTS replacement`
* **Judgment call** — angry PSA call de-escalation — **HOLD**, pre-draft only, never auto-send

## 2. Authority enters once — VerifiedIngress

`VerifiedIngress` is the sole authority. Only the transport authentication
boundary may construct it, and only after checking the original transport
bytes and credentials. Its closed fields (per `AIKO-HOOK-ORGANISM.md`) are:
authenticated subject, verified tenant, transport/audience, granted scopes,
SHA-256 of canonical request bytes, provider nonce/idempotency namespace+key,
and verification evidence including credential generation. Downstream code may
narrow it, never manufacture or widen it.

No prompt, envelope hint, `CONTRACT_ROOT`, or caller-supplied `tenant/role`
becomes authority until joined to a `VerifiedIngress`. Dispatch through the
**same interfaces the human used** — same WhatsApp group, same Sheet, same
Excel file share — so the seat is verifiable by the humans on either side.

## 3. Spawn without ambient memory — delegation_capability

“Shares the same memory and context” is implemented as **delegated citations**,
not shared RAM.

* Child receives an opaque `delegation_capability` handle — verified
  subject/tenant + root/parent/fence + audience/purpose + expiry/max_effects +
  scope. Not an env-string `CONTRACT_ROOT` lineage.
* Context is a **Contract read projection** (`contract/libcontract/src/
  context_projection.zig`) over cited rows + graph `input_bindings` +
  settlements + Neuron `evidence[].sources` — narrow reads, not transcript dump.
* Execution is fenced (`contract/libcontract/src/execution_control.zig`):
  `lease_id/fence` CAS on execution/attempt/graph+input version/non-terminal
  state. An expired worker cannot `invoke` or `settle` even with the same label.
* `cross_journal_retention` keeps pinned rows queryable and citations
  traversable across `compact` — evidence + ordinal cross the fold; wall clock
  does not. Smithers is scheduler only; Contract owns lineage, readiness,
  settlement, invalidation. There is no second ledger.

Copying `~/.aiko`, transcripts, `HOME`, or raw `API_KEY` into the child is
**refused** by the gate.

## 4. Least-authority primitives (SMP-14) and reuse (SMP-24)

* **SMP-14 least authority, deny by default** — the child gets
  `cell/primitives/account-handle` (`cred:tenant/origin/account`, refuses raw
  tokens) and a membrane-derived grant capped at the declared
  `wiring[]` scope. `fde/self-wire.cell.yaml`
  (`account-handle → deploy-workflow → deploy-aiko`) is the seat harness
  parent; this skill composes it.

* **SMP-24 reuse before generation** — every drop-in node `reads` at least one
  frozen primitive (`cell/primitives/*`, `cell/patterns/*`,
  `neuron/limbs/*`, `contract/libcontract/src/*`). `cell/patterns/
  hoysan-draft/hoysan-draft.cell.yaml` is reused as the roster engine
  (its `infeasible → refuse → retain nothing` gate stays); pilots extend its
  request schema, not fork it. `input-sources/harness.cell.yaml` makes
  `poll ↔ webhook ↔ hook` a wiring choice, not a provider branch.

* **SMP-33 reply authority by possession** — a child holding no `allow_send`
  can still answer the `reply_to` pinned into its stimulus on the attested
  `correlation` (proven by `neuron/limbs/conversation` — `ForgedSender`
  blocked even with a full send grant). Hoysan's phone-negotiation reply
  path relies on this.

## 5. Grounding and effect discipline (SMP-17, SMP-18, §28)

* Evidence for any roster claim must resolve to a grounded read (stimulus,
  message, or digest-pinned artifact) and be carried as `evidence[].sources`
  so `produced_by + evidence` reconstruct the derivation graph.
* External delivery is via committed `outbox/` — `send` does not deliver until
  the commit boundary, idempotent on `(firingId, effectIndex)`. Invalidation
  is `redrive` case 3: `ALREADY_SENT → CompensationGap`, never resend.

## 6. Status

This covenant composes the organism covenant; it does not replace it.
`AIKO-HOOK-ORGANISM.md` remains the authority on ingress identity
(`SHA256(nonce namespace || idempotency key || Contract root)`) and on
endpoint generation being an authorized occurrence output.

**SMP coverage:** 14, 24, 17–18, 33 plus §28 observability as cited above.
Remaining SMPs are structural defaults.

*Covenant version: drop-in/1 — 2026-08-17. Witness: `tests/drop-in-covenant-gate.sh`.*
