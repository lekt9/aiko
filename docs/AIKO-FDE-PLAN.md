# Aiko as an AI Forward Deployed Engineer — execution plan

**Status:** product contract written (`docs/AI-FORWARD-DEPLOYED-ENGINEER.md`). Cell-native self-wire increment (`cell/patterns/fde/`) is witnessed by `tests/fde-workflow-gate.sh`. OS vault, Smithers pause/resume, Telethon, and SAP remain Designed or Absent.
**Executable walk:** [`graph-engineering/aiko-fde.walk.json`](graph-engineering/aiko-fde.walk.json)

## North star

Aiko becomes one handoff-safe **AI Forward Deployed Engineer (AI FDE)**: give her a role, a dedicated least-privilege employee account, and an outcome. She learns an existing system through Unbrowse, authors the smallest native integration and typed workflow needed, admits both by digest, acts through the normal account boundary, and does not settle until the effect is independently observed.

This is a category thesis, not yet a market-first claim. The defensible copy is **“Aiko is an AI Forward Deployed Engineer”**, not **“the first AI FDE”**, until a competitive witness exists. “Drop-in employee” describes the target experience; credential handoff, Telethon user-account access, and SAP are currently absent.

## The covenant (W6H)

| Question | Binding answer |
|---|---|
| **Who** | One tenant-scoped Aiko role identity, operating through dedicated named employee/service accounts; never a borrowed personal session. |
| **What** | A controllable, digest-pinned workflow plus native adapters, durable context lineage, and independently settled effects. |
| **When** | On an event, cadence, reply, invalidation, or explicit human approval; redrive terminates or opens a compensation gap. |
| **Where** | Aiko is the product identity; Cell is the typed workflow artifact; Contract is durable truth; Neuron is the admitted execution boundary; Unbrowse is the local web-learning port. |
| **Why** | Businesses need an operator that can enter the real operating loop and be handed off without claiming work happened when it did not. |
| **How** | Observe → compile route/workflow → write inert → test → admit by digest → attach least authority → act via outbox → independently read back → settle or compensate. |

“Single entity” must not become a monolith. The single entity is the role identity and context envelope. Preserve the one-way dependency and handoff guarantee: generated workflows continue without a hard Aiko dependency.

## Native binding — no second scheduler

```text
Smithers/control UI ──authors/pauses/approves──► Cell workflow (typed DAG)
                                                    │ digest + typed edges
Aiko host ──materializes current frontier───────────┤
                                                    ▼
Contract ledger ◄──W6H, occurrences, claims── Neuron admitted limbs
      ▲                                             │
      │ independent read-back                      │ effects/outbox
      └──────── Unbrowse/local adapters ◄──────────┘
```

- **Smithers:** the Hoysan lane already has four durable Smithers workflows, but there is no general Smithers→Cell→Contract binding. Keep it a control/authoring surface: it must emit, pause, and resume the bound Cell/Aiko walk rather than become another scheduler or ledger.
- **Cell:** the workflow Aiko writes natively: typed membranes, explicit caps, DAG wiring, deterministic double-fire check, and content digest.
- **Aiko graph flow:** derives the ready frontier from declared dependencies. The current plan is a chain at the first frontier, then fans out only where data does not cross.
- **Contract:** owns durable claims, occurrence invalidation, deadlines, and the audit record.
- **Neuron:** owns firing, least-authority attachment, limb admission, outbox effects, redrive, and compensation refusal.
- **Unbrowse:** learns first-party route DAGs under the logged-in account, keeps secrets local, independently validates replay, and demotes on drift. It is an organelle, not Aiko's root authority.

## Authentication: employee accounts, not developer API keys

The product default is normal employee authorization: SSO/OAuth/browser login, Telegram phone/code/2FA, or a dedicated SAP user with assigned roles. First use may require human MFA or consent; that security act is not “setup failure.”

Aiko receives only an **opaque credential handle**. The session secret stays in the OS secret store and is injected locally at the destination boundary. It never enters prompts, Cell inputs, ledger rows, evidence citations, generated package digests, telemetry, or git. Every handle is tenant/origin/account scoped and supports inventory, expiry, revoke, rotate, and logout. Unknown scope, expired auth, MFA, ambiguous timeout, or failed read-back remains pending or escalates.

## Delivery graph

The checked planner reports:

```text
Wave 0  product-contract                                      (chain now)
Wave 1  credential-envelope  ||  workflow-binding
Wave 2  context-plane || native-authoring-loop || unbrowse-port
Wave 3  telethon-pilot       ||  sap-pilot
Wave 4  fde-judge
Wave 5  docs-reposition
```

`aiko-doctor graph-plan docs/graph-engineering/aiko-fde.walk.json` reports 10 active obligations, peak parallelism 3, no cycles, unknown dependencies, write collisions, grounding gaps, or missing witnesses. The bug-fix node is already settled and excluded from the active count.

### 0. Source-build failure — settled

Restore `readAll`'s 16 MiB whole-buffer guard and move lock-time compaction back below it (12 MiB). The `admitGraph` hot path is deliberately streaming, so a 17 MiB ledger must still deduplicate while a direct whole-buffer read returns `error.LedgerTooLarge`. Returning data caused the test's successful allocation to look like a leak because `expectError` could not own/free an unexpected success value; the `errdefer` frees it on the intended error path.

Also document that Rust proto generation needs either `PROTOC`/`protoc` or DotSlash for the repository's `bin/protoc` wrapper.

**Witness:** `zig build test` (873 tests; green on this macOS ARM64 tree).

### 1. Product contract

Create `docs/AI-FORWARD-DEPLOYED-ENGINEER.md` as the canonical product boundary. Separate **Proven / Designed / Absent**, name the first vertical acceptance, and keep “market first” as an explicit evidence gap.

### 2. Foundations (parallel)

1. **Credential envelope:** opaque handles, OS vault only, tenant/origin/action scopes, SSO/MFA handoff, revoke/rotate, and deterministic redaction. No plaintext-file fallback for employee credentials.
2. **Workflow binding:** one mapping from Cell digest and ports to Aiko graph nodes, Contract rows, Neuron firings, and `produced_by`/evidence lineage. Smithers controls this artifact; it does not execute beside it.

### 3. The self-deploying employee (parallel after foundations)

1. **Unbrowse port:** logged-in observation → sanitized route DAG → independent replay → promoted local route; drift demotes it. Raw captures and filled auth holes never publish.
2. **Native authoring loop:** a capability gap produces inert adapter code and a Cell; build/test/admit/attach/retry/judge; compilation alone retains nothing.
3. **Context plane:** tenant-isolated context over both existing systems and Aiko-authored code. Context is cited lineage and pinned reads, not an unbounded transcript. A source move makes derived context stale.

### 4. Two vertical pilots (parallel)

- **Telethon:** dedicated Telegram employee account; phone/code/2FA login; inbound update normalization; per-chat ACL; send through outbox; independently read back; auth expiry escalates; redrive never resends an already-crossed message. Source specification: `github:LonamiWebs/Telethon` and its official docs.
- **SAP:** dedicated least-privilege sandbox user; begin through the employee UI/first-party routes learned by Unbrowse; generate a native adapter to the observed interface; permission-gate mutations; submit once; independently read back the SAP business document/status. Do not claim RFC/BAPI/OData support until the selected customer surface is built and witnessed. Source directory: <https://api.sap.com/>.

Telethon is the faster wedge. SAP should remain in the same graph as an independent research/pilot branch, but public promotion need not wait for production SAP if the product contract chooses Telethon as the first vertical. If so, split `fde-judge` into `telethon-judge` and a later `sap-judge` rather than fabricating a single green launch gate.

### 5. Independent judge and documentation promotion

Different verifiers judge: (1) correct outcome, (2) credential/tenant safety, (3) reproduction and handoff, and (4) compensation after invalidation. Only then update README/VISION/GOAL/product/risk docs. Public copy must continue to label anything without a runnable gate as designed or absent.

## Gates that make the positioning true

| Gate | Must prove |
|---|---|
| `credential-envelope-gate` | secrets never enter prompts/ledger/logs; tenant isolation; expiry/revoke/rotate; MFA returns a typed human gate |
| `fde-workflow-gate` | Smithers/control change alters the bound Cell; digest/graph/context agree; pause/resume is durable; no second scheduler |
| `unbrowse-aiko-gate` | first interaction learns, independent replay promotes, drift demotes, unsafe mutation requires external approval, secrets remain sealed |
| `fde-authoring-gate` | generated code is inert, tested, digest-admitted, attached least-authority, retained only after real-path success |
| `fde-context-gate` | context cites its sources, is tenant-isolated, invalidates on movement, and survives handoff without the Aiko host |
| `telethon-fde-gate` | account auth + inbound/outbound + read-back + per-recipient ACL + no duplicate redrive |
| `sap-fde-gate` | permission denial + one sandbox transaction + timeout uncertainty + document read-back + compensation |
| `fde-end-to-end-gate` | role-to-outcome deployment from empty state; independent lenses agree; delivered workflow works without hard Aiko dependency |
| `fde-docs-gate` | every capability claim maps to a green gate or carries Designed/Absent status |

## Sources and native anchors

- `src:CLAUDE.md` — architecture direction, determinism, citations, admission, outbox, compensation.
- `src:VISION.md` — no hard dependency, one-shot credentials/context target, outcome review, credential gap.
- `src:cell/SPEC.md` — typed membranes and DAG composition.
- `src:docs/graph-engineering/README.md` — native Contract/Aiko graph planning.
- `src:neuron/src/morphogenesis.zig`, `src:neuron/src/limb_ops.zig` — self-wiring and digest admission.
- `github:unbrowse-ai/unbrowse` — cache-first capture/replay lifecycle and sealed local auth boundary.
- `github:LonamiWebs/Telethon` — Telegram user-account client implementation/specification.
- <https://api.sap.com/> — SAP's official integration surface directory.

The attempted live retrieval of Telethon's documentation was denied by the local Unbrowse capture boundary, so this plan records the upstream repository pointer and keeps implementation research as an explicit pilot obligation rather than inventing details beyond the known login/session shape.
