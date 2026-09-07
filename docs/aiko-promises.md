# Aiko promises: prepared executions resolved by approval, time or events

## Summary

A **promise** is a durable, event-sourced binding between a **prepared payload**
(a tool call or a code harness, frozen and hashed at preparation time) and a
**resolution condition** (owner approval, a point in time, or an event). When
the condition resolves, the host executes the stored payload deterministically —
no model inference, no fresh arguments — and records a receipt. Approval gates
become the first resolution source; scheduling and event triggers become the
same primitive with a different condition. The model can *prepare* and
*cancel*; only the host *resolves* and *executes*.

This generalizes three things that already exist in fragments:

| Today | Gap |
| --- | --- |
| `action-approval.ts`: `PreparedAction` + `pending → approved → dispatched → settled`, canonical frozen payload, hash-bound consent, fenced dispatch, connection-revision admission, honest `unknown` | Only resolved by human decision; only the model can make the follow-up dispatch tool call; payload kinds limited to observed-network/connector sends |
| `automations.ts`: `schedule` / `listener` with durable wake, exactly-once, restart | Wake arms are actor turns — the model decides what happens at wake time; nothing prepared executes |
| `code-harness.ts` + `codeSegment`: actor runs code in the owner's VM | Runs only inside a live turn; cannot be staged for later |

A promise unifies them: **one record, one state machine, three resolution
sources, two payload kinds**.

## Model

```ts
type PromisePayload =
  | { kind: "connector"; operation: string; connectionId: string; connectionRevision: string; payload: PromiseJson }
  | { kind: "harness"; segment: CodeSegment; binds: Record<string, { connectionId: string; connectionRevision: string }> };

type ResolveWhen =
  | { kind: "approval" }                                  // human decides
  | { kind: "at"; at: number }                            // host clock wake
  | { kind: "on"; source: "journal" | "webhook" | "promise"; match: EventMatcher };

interface AikoPromise {
  readonly id: string; owner: string; thread: string;
  readonly payload: PromisePayload;
  readonly when: ResolveWhen;
  readonly expiresAt: number;              // hard cap: resolved-or-expired
  readonly preview: Preview;               // structurally derived, never model text
  readonly hash: string;                   // SHA-256 of canonical(record minus hash)
}
```

State machine (extends the proven approval fencing):

```
pending ──resolved──▶ dispatching ──▶ settled(succeeded|failed)
   │ │ │                    └──────▶ unknown (dispatcher interrupted / uncertain)
   │ │ └── expired (expiresAt passed unresolved)
   │ └── rejected (approval declined / host cancel)
   └── cancelled (model or owner withdrew before resolution)
```

Invariants carried over from `action-approval.ts`, unchanged:

- Payloads are **canonical, frozen JSON**; the record hash binds consent and
  dispatch admission. A stored promise can never be mutated — only superseded.
- **Consent is consumed before work**: the fenced `dispatching` transition wins
  exactly once per record (optimistic version chain + read-back of the unique
  transition token). Executing work receives the stored payload, never fresh
  model arguments.
- **Uncertainty is truthful**: an interrupted dispatch records `unknown`, never
  a fabricated failure, and grants no second attempt.
- **Connection admission at dispatch**: `connectionRevision` is re-checked when
  the payload executes; revocation cancels every unresolved promise bound to it.
- Resolution/execution events are journal events on the owner's thread
  EventLog (`AikoPromiseTransition`), projected with the same version-chain
  discipline `project()` uses today, so DO restarts re-derive state for free.

New invariant: **resolution is host-owned**. No NativeTool, actor method or
model argument can resolve or execute a promise. The model only prepares,
cancels and reads state.

## Resolution sources

### approval (human)

Identical trust surface to today's `handleDecision`: the mini app session or a
verified Telegram sender is authenticated server-side; the decision request
carries `id + hash` and must match the stored record. What changes:

- The click **is** the resolution — the host immediately admits dispatch
  (the model is not needed to convert consent into execution).
- Telegram gains inline keyboards (`callback_query` handling in the webhook
  transport) so the proposal message carries Approve / Open / Dismiss buttons.
  The callback payload carries the promise id and a per-transition token;
  `answerCallbackQuery` closes the loop.
- The mini app drawer already lists pending approvals (`/approvals`); it gains
  the same promises screen with the structural preview.

### at (time)

Prepared + scheduled in one step ("send this Friday 09:00"). Reuses the
automation wake machinery: the DO holds a next-wake per owner derived from
`min(pending.at)`; the durable wake fires, the host checks `expiresAt` and
admits dispatch. No model turn at wake time. Recovery re-arms wakes from the
journal after restart (the `automationNextWake` pattern).

### on (event)

A closed matcher over event sources that already exist:

- `journal`: the automation hook forwarder pattern — value-free lifecycle
  events (`AikoLoginSubmitted`, `AikoPromiseSettled`, sign-in completion).
  Matchers match on event `type` plus bounded fields; events that can carry
  credential-shaped values are excluded from matching by an allowlist.
- `webhook`: connector-route events (e.g. a sign-in completing) resolve
  promises through the same host admission.
- `promise`: a settled promise emits `AikoPromiseSettled`, enabling follow-up
  chains ("when the export finishes, upload it") — capped (below).

### Deadline and expiry

Every promise has one `expiresAt` (host-enforced cap, e.g. ≤ 30 days).
Unresolved at expiry → `expired`. `at`-promises may also declare `notBefore`
as a second field in v1; general `all`/`any` combinators are deliberately
deferred (open question below).

## Payload executors

Both executors are host-driven and deterministic; each receives the immutable
stored payload.

| Kind | Executor | Notes |
| --- | --- | --- |
| `connector` | the existing dispatch `work` path (provider call through the bound connection) | Same as today's approval dispatch; revision admitted at dispatch |
| `harness` | `codeSegment` into the owner's VM runner with the staged segment | Closed code-sandbox protocol surface; resource caps unchanged; stdout/summary bounded |

Credentials never appear in a payload. A harness that needs an app credential
declares `binds` at preparation; at dispatch the host resolves the connection
through the private seam (the `manager-resolve` / vault path), and the value
exists only inside the owner's VM for that run. The preview shows *that* a
credential is bound and to which app — never a value.

## Receipts and follow-ups

A settled promise appends `AikoPromiseSettled { id, outcome, at, digest }` —
value-free, receipt-qualified. Optionally (owner preference / per-promise flag)
the host wakes the actor with that receipt so the model can tell the owner what
happened and answer follow-up questions. The wake is a bounded, receipt-only
turn: the model receives the outcome, not execution authority, and the turn
consumes the existing reply/budget policy (one bounded reply per promise).

Chains are promises whose `on.source` is `"promise"`. Caps: chain depth ≤ 3,
width ≤ 8 per owner, a promise cannot resolve on its own id (self-loop) or its
ancestors (the projection tracks lineage), and per-owner pending totals are
capped (operator limit, default 16). Exceeding a cap fails preparation with a
clear reason.

## Surfaces

| Surface | Preparation | Resolution | Receipt |
| --- | --- | --- | --- |
| Model tools | `promise_prepare` (per-capability argument schemas), `promise_cancel`, `promise_list` | never | `promise_settled` wake (bounded) |
| Telegram | proposal message with preview | inline Approve / Dismiss buttons (new `callback_query` transport), sender-verified | reply when the wake flag is set |
| Mini app | rich preview (harness code + binds) | Promises screen: approve / reject / cancel | status list |
| Control panel | — | same decisions, operator-authenticated | journal view |

Preview construction is structural: operation name, destination/connection
label, canonical inputs, bound credentials (names only), expiry, condition
("when you approve" / "at 2026-09-12 09:00 UTC" / "when sign-in to X
completes"). No model-generated prose is stored in the record.

## Security model

1. **Preparation is capability-checked.** `promise_prepare` reuses each
   capability's argument validation at prep time — an invalid call never
   reaches `pending`. The same gates that would govern the live call.
2. **Approval authentication is independent of the body** (unchanged rule):
   mini app initData/session or verified Telegram sender; never a submitted
   account id.
3. **Immutability + hash binding** end to end: what the human (or the clock, or
   the event) resolves is exactly what executes.
4. **Exactly-once dispatch** via the fenced transition; replay of the decision
   endpoint is idempotent; a retried webhook cannot double-execute.
5. **Expiry everywhere**: unresolved promises die at `expiresAt`; approved-but-
   undispatched still expires (host admits dispatch promptly after resolution —
   the window is seconds, not days).
6. **No secret material in payloads or previews**; binding happens at prep,
   resolution at dispatch through private seams.
7. **Bounded amplification**: pending caps, chain caps, wake budget, harness
   resource caps. A promise cannot escalate authority: it executes under the
   same owner, thread and connection binding it was prepared with.
8. **Restart-safe**: all state is journal projection; wakes re-arm; interrupted
   dispatches become `unknown` honestly.

## Implementation plan

> Status: the core primitive, harness executor, resolution loop (`at` wake
> alarms + journal hook driving through the forwarded-signal path), approval
> decision service, expiry and the `promise_prepare`/`promise_cancel`/
> `promise_list` tools landed together in `src/promises.ts` with
> `test/promises.test.ts`. Key journal mechanics: transition events key on
> `<id>:<previous>` (the host's keyed append absorbs duplicate keys, so reusing
> the record id would silently drop every transition after the first), and
> forwarded hook signals (`AikoAutomationSignal`) drive hook promises on the
> owner thread. Remaining: mini app/Telegram surfaces, promise-source chaining
> depth/width caps, webhook source, observed-network migration.

Phase 1 — core primitive (`src/promises.ts`) [DONE, harness-only payload]
- `AikoPromiseTransition` journal event + projection (reuse the canonical-JSON,
  freeze, version-chain and fence code paths; factor shared helpers out of
  `action-approval.ts` rather than duplicating).
- Prepare/resolve/dispatch/cancel/expire service; host clock injection for
  tests; connection-revision admission hook.
- Tests: state transitions, fence races, expiry, revocation, payload immutability,
  canonical-JSON rejection cases, restart re-projection.

Phase 2 — executors and the resolution loop [DONE for harness]
- `connector` executor: lift the existing dispatch `work` into the host.
- `harness` executor: staged `CodeSegment` via `codeSegment`; binds resolved
  through the private seam at dispatch; bounded output summary.
- DO resolution loop: journal subscription (hook forwarder) + next-wake arm;
  `AikoPromiseSettled` emission; restart recovery.
- Tests: exactly-once under concurrent resolution; unknown after interruption;
  wake re-arm after restart (mirrors `automations.test.ts` discipline).

Phase 3 — resolution sources
- `approval`: wire the mini app `/approvals` surface and the decision route to
  promises; keep `action-approval.ts` serving the existing observed-network
  flow until it migrates.
- `at`: automation wake integration. [DONE — `promiseNextWake` arms the DO
  alarm; `promiseWakeEvent` synthesizes `AikoPromiseTick` in `alarm()`]
- `on`: journal matcher allowlist; webhook admission through the connector
  route; promise-source with lineage + caps. [hook allowlist DONE: forwarded
  `AikoHookReceived`/`AikoApiObserved` signals + `AikoPromiseSettled` chain;
  webhook source and chaining caps still open]
- Tests per source; matcher allowlist rejects credential-shaped events.

Phase 4 — surfaces
- Telegram transport: inline keyboard send + `callback_query` webhook handling
  with `answerCallbackQuery`; sender verification unchanged.
- Mini app: Promises screen (list/preview/decide/cancel) on the connector API
  with strict field allowlists; harness previews render the segment.
- Control panel: decisions + journal view (operator-authenticated).

Phase 5 — model tools, follow-ups, migration [tools DONE]
- `promise_prepare` / `promise_cancel` / `promise_list` native tools with
  closed schemas; prep-time capability validation; receipt wake wiring. [DONE —
  mounted only when the Worker composes the actor with sandbox capabilities;
  redaction gate rejects credential-shaped payloads before freezing]
- Caps enforcement (pending, depth, width) + operator limits.
- Migrate the observed-network write approval flow onto promises (projection
  reads both `AikoApprovalTransition` and `AikoPromiseTransition` during the
  transition window).

## Non-goals (v1)

- No general cron/interval promises (automations already cover recurring actor
  work; promises are for *prepared* payloads).
- No `all`/`any` condition combinators beyond `approval` + optional `notBefore`.
- No approval delegation between accounts; no cross-owner promises.
- No execution outside the owner's thread binding and existing capability
  authority — a promise never grants new access.

## Open questions

1. Should `harness` results return a value-free summary to the model always, or
   only when the receipt wake fires? (Default: summary on wake only.)
2. Should approval previews be re-displayed and re-hashed at click time on
   every surface, or is the prepared hash sufficient? (Default: hash only;
   re-display is a surface concern.)
3. Expiry cap default: 7 or 30 days for `at`-promises prepared by the model
   without explicit owner confirmation? (Suggest 7 unless the owner adjusts it.)
