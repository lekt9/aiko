# Native Contract Background Execution for Aiko

## Goal

Make user-defined work durable and mechanically resumable without requiring the
Aiko TUI to remain open or requiring users to invoke Contract manually.

Aiko must load Contract in-process, reconcile time/dependency/event-triggered
contracts through the native dylib ABI, enqueue due work through Aiko's existing
synthetic prompt infrastructure, execute with the user's saved permission
policy, verify the postcondition, and append a terminal or continued-HOLD
outcome to the Contract ledger.

This plan spans:

- `/Users/lewis/Unbrowse/contract`
- `/Users/lewis/Unbrowse/aiko`

## Current State

### Contract

- The ledger is append-only and reconstructs state from events.
- Typed agency rows distinguish purpose, governor, action, sensor, evaluator,
  and development while legacy rows remain explicitly ungoverned.
- High-risk typed actions fail closed without approval and matching consequence
  coverage; grounded promotion requires fresh independent anchors and respects
  counter-metric vetoes.
- Negative evidence bypasses positive cache reuse, propagates invalidation in
  one resolver tick, and permits rollback only to a verified compatible
  checkpoint.
- Causal JSON events, watch/explain, and the offline renderer expose resolver
  state without entering wallet or Keychain paths.
- `satisfied`, `died`, and `purged` are the terminal alphabet.
- Pending/HOLD contracts can carry:
  - `at:<unix-seconds>`
  - `repeat:<N>s|m|h`
  - `when:contract:<id>` dependencies
  - `when:event:<name>` workspace signals
- `contract tick` materializes due occurrences, invalidates stale cached truth,
  compacts oversized ledgers, and backfills unresolved contracts.
- `contract tick --every <seconds>` provides a standalone resident loop.
- Occurrence planning, materialization, leasing, renewal, retry release,
  settlement, and named signals now live in `libcontract/src/scheduler.zig`.
- ABI v3 exposes the bounded scheduler tick while preserving all v2 symbols.
- The CLI delegates occurrence materialization to the same library kernel;
  its legacy action/backfill executor remains in `zig/src/main.zig`.

### Aiko

- Contract is loaded directly as `libcontract.dylib`.
- Contract routing already influences prompt grounding and native tool choice.
- Aiko already has:
  - scheduled one-shot and recurring prompts;
  - persisted durable scheduler state;
  - missed one-shot recovery after session restoration;
  - synthetic auto-wake prompt origins;
  - prompt queue deduplication;
  - background monitors and notifications;
  - macOS sleep/wake awareness.
- Durable `scheduler_create` calls now declare Contract schedules directly.
- Live sessions reconcile workspace-scoped Contract claims into the existing
  scheduled-prompt rail and settle only owned completed turns.
- The packaged `contract-worker` runs headlessly under a per-user LaunchAgent,
  so TUI closure no longer stops reconciliation.

## Non-Negotiable Invariants

1. **One ledger:** Contract remains the source of durable task truth. Do not
   introduce a second authoritative task database.
2. **One resolver:** move the existing resolver tick into `libcontract`; do not
   independently reimplement Contract resolution in Rust.
3. **Native integration:** Aiko calls Contract through the dylib ABI. It must
   not spawn the Contract CLI for normal operation.
4. **At-least-once delivery, idempotent effects:** crashes may redeliver an
   occurrence, but stable occurrence keys and execution leases must prevent
   duplicate side effects.
5. **No false satisfaction:** an execution attempt cannot append `satisfied`
   without postcondition evidence accepted by Contract.
6. **HOLD is resumable:** missing permission, unavailable credentials, offline
   services, sleeping machines, and unmet dependencies remain non-terminal.
7. **Explicit terminal failure:** only unrecoverable or policy-directed failure
   appends `died` or `purged`.
8. **Permission continuity:** background work may use only the authority the
   user granted when defining the task. A background model cannot silently
   widen it.
9. **Privacy by default:** persisted prompts, evidence, notifications, and logs
   must redact secret-shaped values and unnecessary personal identifiers.
10. **Backward compatibility:** existing ledgers, CLI `tick`, scheduler state,
    and packaged Contract ABI v2 installations must continue to work through a
    versioned migration.
11. **Package coherence by default:** every normal Aiko release build rebuilds
    and repackages the sibling Contract dylib, and the manifest pins the exact
    Aiko and Contract hashes. Only `build-aiko-only` may intentionally skip the
    combined package refresh.

## Target Architecture

```text
macOS launchd
      |
      v
Aiko background coordinator
      |
      | native ABI: contract_tick / claim / settle
      v
libcontract.dylib -----> append-only Contract ledger
      |
      | due occurrence descriptors
      v
Aiko durable execution queue
      |
      | synthetic ContractWake prompt
      v
Aiko native tools and provider routing
      |
      | observations + postcondition evidence
      v
Contract verdict: satisfied | HOLD | died | purged
```

The coordinator owns process lifecycle and execution. Contract owns scheduling
semantics, dependencies, occurrence identity, truth, and verification.

## Phase 1 — Extract the Contract Resolver Kernel

Repository: `/Users/lewis/Unbrowse/contract`

- [x] Move `TriggerSpec`, trigger parsing, occurrence planning, atomic
      materialization, and execution leasing into a reusable `libcontract`
      module.
- [ ] Move the remaining compaction/warming and legacy unresolved-action
      backfill orchestration out of `zig/src/main.zig`.
- [x] Keep CLI trigger materialization as a thin adapter over that module.
- [ ] Define a bounded tick input:
  - current wall time or production-clock mode;
  - maximum contracts;
  - maximum passes;
  - optional ledger/workspace scope;
  - caller identity.
- [ ] Define a structured tick result containing:
  - newly materialized occurrences;
  - contracts that became runnable;
  - contracts still on HOLD and their typed blocker;
  - terminal transitions;
  - retryable and permanent errors;
  - next known wake deadline.
- [x] Ensure tick never leases an unbounded amount of work in one call.
- [x] Preserve occurrence idempotency across process crashes.
- [x] Add deterministic clock-injected tests for `at:`, `repeat:`,
      dependencies, named events, leases, and retry release.

### Phase 1 acceptance

- The CLI tick and library tick produce identical ledger transitions for the
  same fixture.
- Repeating the same tick produces no duplicate occurrence.
- Advancing into a new repeat bucket produces exactly one new occurrence.
- Existing Contract tests and real-ledger replay fixtures pass.

## Phase 2 — Add a Versioned Native Tick ABI

Repository: `/Users/lewis/Unbrowse/contract`

- [x] Add ABI v3 without removing v2 symbols; Aiko accepts both versions.
- [x] Export a function equivalent to:

```c
char *contract_tick_json(const char *request_json);
```

- [x] Return owned JSON through the existing Contract allocation/free
      convention.
- [x] Add ABI endpoints for durable execution lifecycle:
      expressible with existing calls:
  - claim/lease an occurrence;
  - renew a lease;
  - record an attempt;
  - release back to HOLD with next retry time;
  - submit evidence and terminal verdict.
- [ ] Use stable error codes and typed JSON, not human console output.
- [ ] Make unsupported ABI versions fail closed with an actionable error.
- [x] Add Zig ABI tests plus a foreign-language dylib smoke test.

### Phase 2 acceptance

- A standalone test process can load the dylib, tick a fixture ledger, claim
  one occurrence, settle it, free all returned memory, and exit cleanly.
- No Contract CLI subprocess is involved.
- ABI fuzz/malformed-input tests do not crash or mutate the ledger.

## Phase 3 — Build the Native Aiko Contract Coordinator

Repository: `/Users/lewis/Unbrowse/aiko`

- [x] Extend the existing Contract loader with typed wrappers for ABI v3.
- [x] Introduce a session-lifetime `ContractCoordinator`.
- [x] On startup:
  - load and negotiate Contract ABI;
  - reconcile pending/due contracts;
  - recover expired execution leases;
  - compute the next wake deadline.
- [x] While running:
  - sleep until the next Contract deadline or a ledger-change notification;
  - tick with bounded work;
  - enqueue runnable occurrences;
  - apply retry backoff with jitter for transient failures.
- [ ] Use FSEvents/kqueue to wake on ledger changes instead of constant polling.
- [x] Use a stable queue key derived from contract id plus occurrence id.
- [x] Add `PromptOrigin::ContractWake` rather than disguising Contract work as a
      user prompt or scheduler fire.
- [ ] Surface coordinator status without leaking prompt payloads.

### Phase 3 acceptance

- A due fixture contract becomes one synthetic Aiko turn.
- Duplicate ticks and process restarts do not create concurrent duplicate
  turns.
- A newly satisfied dependency wakes its dependent on the next reconciliation.
- Existing user, scheduler, subagent, and auto-wake prompt behavior is unchanged.

## Phase 4 — Execution, Permission, and Verification Envelope

- [ ] Persist a task authority envelope when the user defines background work:
  - permitted tools/capabilities;
  - allowed applications, hosts, and filesystem roots;
  - whether external writes/messages/purchases are allowed;
  - expiry and revocation metadata;
  - required interactive approvals.
- [ ] Bind the authority envelope cryptographically to the Contract occurrence.
- [ ] Prevent providers or prompts from widening the envelope.
- [ ] Route each occurrence through Contract before model sampling.
- [ ] Prefer deterministic/native execution when Contract supplies a complete
      action and evaluator; use a model only for unresolved typed holes.
- [ ] Record execution attempt, tool outcomes, independent observations, and
      evaluator evidence.
- [ ] Submit the evidence to Contract for the final verdict.
- [ ] On recoverable failure, append HOLD/retry evidence and a next-attempt time.
- [ ] On required approval, notify the user and remain HOLD.

### Phase 4 acceptance

- A background task cannot call a tool outside its saved authority.
- A tool exit code alone cannot satisfy a task whose postcondition is false.
- A transient offline failure resumes later.
- A revoked task cannot execute even if it was already queued.

## Phase 5 — Native macOS Background Lifecycle

- [x] Add an Aiko background-agent entry point that runs the coordinator
      without the TUI.
- [x] Package and install a per-user `launchd` agent with Aiko.
- [x] Use one launchd worker per user plus Contract's exclusive occurrence
      leases across all live sessions.
- [x] Start at login and restart after crashes.
- [ ] Schedule wake deadlines through macOS-native facilities where available;
      reconcile missed deadlines after sleep or reboot.
- [x] Share authentication/provider configuration with Aiko without copying raw
      credentials into launchd plists or logs.
- [x] Add CLI controls:
  - [x] `aiko background status`
  - [x] `aiko background start`
  - [x] `aiko background stop`
  - [x] `aiko tasks list`
  - [x] `aiko tasks inspect <id>`
  - [x] `aiko tasks retry <id>`
  - [x] `aiko tasks cancel <id>`
- [ ] Make installation and removal reversible.

### Phase 5 acceptance

- Define a one-shot task, close the TUI, and observe verified completion.
- Reboot across its deadline and observe one recovery execution after login.
- Killing the coordinator during execution causes safe lease recovery without
  duplicate committed side effects.

## Phase 6 — Event Sensors

- [x] Define a native, workspace-scoped named-signal interface whose output is
      append-only evidence, not an unrestricted prompt.
- [ ] Implement initial local sensors:
  - file created/changed;
  - process exited;
  - application launched/closed;
  - browser/Electron page or API condition;
  - network reachability;
  - Git/workspace change.
- [ ] Add remote adapters only behind explicit authorization:
  - webhook;
  - API polling;
  - email/calendar/provider events.
- [ ] Persist sensor cursors so restarts neither lose nor duplicate events.
- [ ] Feed sensor truth into Contract and let dependencies determine what wakes.
- [ ] Rate-limit noisy sensors and coalesce equivalent occurrences.

### Phase 6 acceptance

- “When file X appears, process it” survives an Aiko restart.
- Replaying the same filesystem or webhook event does not repeat a committed
  side effect.
- A false or stale sensor observation cannot satisfy the dependent contract.

## Phase 7 — Observability and Operations

- [ ] Provide a redacted task timeline:
  - declared;
  - waiting and blocker;
  - triggered;
  - leased;
  - executing;
  - evidence collected;
  - satisfied/died/purged;
  - retry scheduled.
- [ ] Expose next wake time and coordinator health.
- [ ] Add structured metrics for:
  - trigger-to-start latency;
  - completion latency;
  - retry count;
  - duplicate suppression;
  - stale leases;
  - unresolved pending age.
- [ ] Alert on contracts pending beyond policy limits.
- [ ] Ensure debug logs never contain credentials, device codes, private prompt
      contents, or unredacted personal identifiers.

## End-to-End Test Matrix

1. **Time, live process:** one-shot `at:` fires once.
2. **Time, TUI closed:** background agent executes and verifies.
3. **Time, asleep/rebooted:** missed deadline reconciles once.
4. **Recurring:** one occurrence per interval bucket; no overlap duplicates.
5. **Dependency:** B remains HOLD until A satisfies, then wakes.
6. **Dependency failure:** A dies; B follows declared policy rather than running.
7. **File event:** matching creation wakes; unrelated changes do not.
8. **Application event:** Electron/API condition wakes through native runtime.
9. **Permission HOLD:** task pauses for approval and resumes after approval.
10. **Credential HOLD:** expired auth pauses; refresh/login later resumes.
11. **Crash before effect:** lease expires and work retries.
12. **Crash after effect:** idempotency/evidence prevents a duplicate commit.
13. **Revocation:** cancelled task never executes from an old queue entry.
14. **ABI mismatch:** coordinator reports degraded state and performs no mutation.
15. **Privacy:** secret fixtures never appear in ledger, logs, notifications, or UI.

## Rollout

1. Ship the Contract library tick behind an ABI feature flag.
2. Run Aiko coordinator in observe-only mode and compare its due set with the
   standalone Contract CLI.
3. Enable execution for local read-only tasks.
4. Enable reversible local writes with saved authority.
5. Enable external side effects only after idempotency and approval tests pass.
6. Make the background agent opt-in during beta.
7. Promote to default only after crash/reboot/sleep soak tests show no duplicate
   committed effects.

## Definition of Done

- Users can define time-, dependency-, or sensor-triggered work in natural
  language.
- Aiko compiles it into Contract-backed durable state with an explicit authority
  envelope and postcondition.
- Work resumes without the TUI and without manual Contract commands.
- Restarts, sleep, missed deadlines, and transient failures are reconciled.
- Every occurrence is visibly satisfied, still on HOLD with a typed reason, or
  explicitly terminal.
- Duplicate delivery cannot produce duplicate committed effects.
- Contract remains the single source of truth and is invoked natively in-process.
