# Aiko — convergence plan: reactive, self-wiring, self-writing

> **Historical.** T1–T4 are landed. Kept for the reasoning, not as a worklist.
> Current tree: [`docs/SOURCE-OF-TRUTH.md`](docs/SOURCE-OF-TRUTH.md).

Risk-ordered, in the shape `/ix-memory:ix-plan` produces. **ix could not supply the
blast radii**: it has no symbol graph for this Zig tree (`ix locate` resolves no
entities; it has indexed only markdown). Every independence claim below is
therefore derived from real call sites and file boundaries, and is labelled as
such. Where independence is not proven, the node waits.

---

## 0. What is already true (verified this session, not asserted)

| Property | Evidence | State |
|---|---|---|
| **Self-wiring** | `interface-morphogenesis-gate.sh` PASS; `self-constructing-agent-gate.sh` PASS (auto-attacher, introspection-trigger, dispatch-router, preemptor: admit → operate → revoke → detach → GC) | ✅ |
| **Self-writing** | `meta-agent-gate.sh` PASS, asserting `generated_limb_attached is True`; `IMPLEMENTATION.md:208` — a generated limb is written inert, admitted by digest, attached, used, revoked, detached, collected | ✅ |
| **Reactive** | `redrive-gate.sh` PASS — three cases: re-derive, escalate, compensate-never-recross | ✅ |
| **Composable** | 3 effects (`write\|send\|spawn`); `journalCommit` has exactly 1 caller; `MAX_CHAIN_STEPS = 8`; `remote-interface-chain-gate.sh` PASS chaining local→process→HTTP→MCP→verifier in ONE goal | ✅ |
| **One build, Linux-native** | `zig build` → `aiko` + `libcontract.a` from clean; `aiko-doctor` links both layers with a comptime assert that `contract.FireRequest == typed_neuron.FireRequest` | ✅ |
| **Durable + time-aware** | contract 858/858; W6H refuses a row that cannot answer all six, naming the missing one; `at:`/`repeat:` synapses; occurrence invalidates a resolved contract | ✅ |

**The correction that reframes the remaining work:** self-writing is not
forbidden. The invariant is *write inert → admit by digest → never retain on
compilation alone*. Generation and admission are separate firings, so generated
bytes exist before their own pin. Nothing below needs to weaken admission.

---

## 1. The actual gap

Self-wiring and self-writing both exist **and are not joined**.

```
morphogenesis   CapabilityGap → DISCOVER an external boundary → derive manifest → admit
Meta-Agent      (a limb is needed) → WRITE a limb inert → admit → attach → judge
                         ↑
                 nothing connects these: no path takes a gap and WRITES a handler for it
```

Today a gap can only be closed by a boundary that already exists somewhere. If
nothing out there satisfies it, the loop retires the gap instead of authoring
the thing that would close it. That single missing edge is what separates
"self-wiring" from the spec's "generates its own integration scaffolding on
first run".

---

## 2. Targets, blast radius, risk

| # | Target | Touches | Risk | Why |
|---|---|---|---|---|
| **T1** | **Bridge** — served `port` firing → contract row (W6H + occurrence) | new root `src/`, `contract.neuron.fireJson` | **HIGH** | First code writing durable state into contract's ledger from the served path. A wrong row is a wrong audit record, and the ledger is append-only — mistakes are permanent by design |
| **T2** | **Author** — close a CapabilityGap by WRITING a handler limb, not only by discovering one | `morphogenesis.zig`, `limb_ops.zig`, new limb package | **MEDIUM** | Reuses the witnessed generate→admit lifecycle. Risk is a generated handler that admits but does not satisfy the gap — already refused by morphogenesis refusal #2 |
| **T3** | **Dispatch** — one `contract.mcp_server.runStdio` tool set; what Hermes mounts | `contract/libcontract/src/`, new dispatch | **LOW** | New surface, no existing caller to break. `runStdio` exists and is unused |
| **T4** | Desktop resource build step | `aiko/apps/desktop` | **LOW** | One build step; currently satisfied by a deleted macOS dylib |

---

## 3. Data flow — which edges are real

```
T1 bridge ──────────────► T3 dispatch     REAL. The dispatch's tool list IS the
                                          bridge's surface. Cannot be authored first.
T2 author ──────────────► T3 dispatch     REAL. "close a gap by writing one" is a tool
                                          the dispatch must expose.
T1 bridge ◄────────────► T2 author        NO EDGE PROVEN, and none apparent: different
                                          files (root src + contract ledger vs
                                          morphogenesis + limb_ops), different concerns.
                                          Neither reads the other's output.
T4 ─────────────────────► (nothing)       Independent of all three.
```

**T1 ∥ T2, then T3.** That is a genuine two-way split with a fan-in — the only
real fan-out in the whole plan.

**Counter-rule check:** two nodes is a thin fan-out, and both are
judgement-heavy work on a substrate where every prior fan-out on shared concepts
produced duplicates. Recommendation: **build T1 and T2 serially by hand**, and
spend the parallelism budget on adversarial verification instead, which is where
it has actually paid this session (the duplication lens caught what two
correctness reviewers missed).

---

## 4. Sequence, with a gate per step

### T1 — Bridge  *(do first: T3 depends on it, and it is the highest-risk node)*

1. Read a committed firing out of neuron's journal (`limb_ops.collectStale` /
   `readJournal` already expose the reader — reuse, do not write a second).
2. Project it into the six interrogatives:
   `who` = node identity · `what` = the firing's claim · `when` = commit ordinal
   (never a wall clock — `now_ms` is inside the firing digest) · `where` = the
   agent + artifact prefix · `why` = the cited evidence sources · `how` = the
   effect kinds committed.
3. Hand it to `contract.neuron.fireJson`. The type is already shared, so nothing
   is translated.
4. Amendment path: a new order occurrence invalidates the prior row; `redrive`
   already classifies what re-derives, what escalates, and what may only
   compensate.

**Gate** `tests/bridge-gate.sh`: fire through a served port, run the bridge,
assert a contract row exists answering all six interrogatives; then supersede the
order and assert the prior row is invalidated and only the changed workers are
compensated. Prove it fails closed by deleting the `when` projection and
confirming the gate catches `MissingWhen`.

### T2 — Author  *(independent of T1)*

1. On a `CapabilityGap` with no admitted boundary and no discoverable one,
   author a handler limb package **inert** — manifest + neuron + schemas.
2. Admit it by digest through the existing `limb_ops.admit`. No new admission
   path. Same battery.
3. Attach least-authority, retry the original gap on the real path, judge.
4. **Retain only on a verified real-path success**; revoke + detach otherwise.
   This is morphogenesis refusal #2 and it is what stops the loop from keeping
   code that merely compiles.

**Gate** `tests/author-gate.sh`: a gap no boundary satisfies → a limb is authored,
admitted, attached, and *satisfies the gap over the real path*; a second gap whose
authored limb fails is revoked, detached and GC'd, leaving no admitted digest.

### T3 — Dispatch  *(needs T1 + T2)*

One `runStdio` dispatch exposing: ledger read, task/occurrence verbs, `port`
publish/attach, gap open/close, and the bridge. This is the object Hermes mounts
and the single API surface the spec asks for.

**Gate** `tests/dispatch-gate.sh`: drive the whole staffing workflow over MCP
stdio — ingest, draft, approve, notify, read acks, escalate, amend — and assert
every step landed a contract row.

### T4 — Desktop resource step *(anytime)*

---

## 5. What this does NOT deliver

Stated so the plan cannot be read as promising it:

- **UI layer** — ~0%. Both repos ship read-only, deliberately payload-free
  observability. The spec's "custom UI language" exists nowhere.
- **OCR of the order image** — R11 is open (no MCP read tool, `toolResult`
  hardcodes text). An OCR *HTTP API* works today; a vision model does not.
- **Credential passing / browser access** — no vault, no driver, in any layer.
- **Constraint solver** — none, and none claimed. Must be a limb, and must be
  **deterministic**: R10 is explicit that a non-deterministic producer
  re-derives a different answer, invalidates its own dependents, and never
  reaches a fixpoint.
- **Aiko's Rust host** — excluded from the build. It compiles; its test build
  SIGTERMs at 1GB free of 15GB, so including it would be unverifiable here.

---

## 6. The order that matters

**T1 → T2 → T3**, with T4 whenever. T1 first because T3 depends on it and it
carries the highest risk; T2 second because it is the spec's headline claim and
rests on an already-witnessed lifecycle; T3 last because it is the door, and a
door is the wrong thing to build before the room is proven.
