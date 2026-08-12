# Contract Agency Substrate — Execution Plan

> **Historical.** Dated plan. Not current product documentation. What the tree is today: [../docs/SOURCE-OF-TRUTH.md](../docs/SOURCE-OF-TRUTH.md).

Execution status: **complete (2026-07-20)**. Release evidence, metric results,
executed workflows, verification commands, and the human-authority boundary are
recorded in `docs/AGENCY-SUBSTRATE-RELEASE-EVIDENCE.md`.

Status: ready to execute
Date: 2026-07-20
Source interpretation: [`docs/VIDEO-AGENCY-MAPPING.md`](docs/VIDEO-AGENCY-MAPPING.md)
Primary implementation: `libcontract/`
Compatibility implementation: `zig/` and `scripts/contract`

## 1. Objective

Evolve Contract from a durable action/check ledger into a grounded agency substrate:

- human-authored purpose remains the root authority;
- observations terminate in independent reality anchors;
- actions declare their reach and expose observable consequences;
- evaluators carry provenance, independence, uncertainty, expiry, and counter-metrics;
- governance runs at explicit speeds and owns targets, vetoes, revocation, and rollback;
- failures travel upward without being hidden by cached success;
- structural changes to the graph are proposed and approved explicitly;
- people can see what the graph is doing while it runs.

The intended result is not “more contracts.” It is a coherent graph in which perception, action, governance, coupling, and development correct one another without pretending the machinery originates the user’s values.

## 2. Product decision

### Decision

Build six explicit node roles on top of the existing contract row and ledger:

1. `purpose`
2. `sensor`
3. `action`
4. `evaluator`
5. `governor`
6. `development`

Keep the existing reduced loop and canonical `contract:<id>` dependency. Roles add typed semantics and policy; they do not create a parallel execution engine.

### Why

The current system is strong at durable execution, lineage, signatures, caching, and deterministic verification. It is weaker at distinguishing “a check returned zero” from “the intended outcome touched reality,” making evidence independence operational, propagating bad news, governing loop speed, and changing graph topology safely.

### Evidence strength

- **Strong:** current implementation and tests show durable declarations, actions, checks, signatures, cache, schedules, lineage, activity logging, revocation/trust primitives, and a functioning task verifier.
- **Medium:** the agency model provides a coherent structural diagnosis, but its terminology is conceptual rather than an implementation specification.
- **Weak:** we do not yet have longitudinal evidence that the six roles improve task outcomes across diverse real workloads.

### What would change this decision

- If typed roles add substantial complexity without detecting failures the current trust layer misses, collapse them into typed capabilities on the existing row.
- If independent anchors cannot be expressed without domain-specific plugins, keep the core anchor interface small and move sensor implementations to adapters.
- If topology development cannot be made auditable and reversible, ship proposal-only development and defer automated graph mutation.

## 3. Non-negotiable principles

1. **The user authors purpose.** Models and rules may clarify or propose; they may not silently replace root values.
2. **Evidence must terminate in reality.** Ledger agreement alone cannot establish grounded truth.
3. **One source is one witness.** Derived or duplicated evidence does not increase independence.
4. **Bad news outranks cached success.** Fresh contradictory evidence invalidates dependent truth.
5. **Reach must be observable.** An action may not claim successful reach beyond its consequence sensors.
6. **Fast loops cannot rewrite slow-loop rules.** Operational nodes do not mutate their own governing criteria.
7. **Checks contain action; they do not micromanage intelligence.**
8. **Topology changes are explicit, attributed, reviewable, and reversible.**
9. **On-chain/value-moving behavior remains disabled unless explicitly requested.**
10. **Secrets never enter contract bodies, logs, prompts, or evidence payloads.**

## 4. Scope

### In scope

- Typed roles and role-specific validation.
- Evidence anchors and provenance.
- Independence-aware aggregation.
- Action reach and consequence coverage.
- Target ownership and loop cadence.
- Counter-metrics, vetoes, expiry, revocation, and rollback.
- Priority propagation of failure and contradiction.
- Topology-change proposals and approval.
- Activity/event schema and human-readable live rendering.
- CLI and library APIs.
- Legacy bridge and migrations.
- Unit, integration, property, fault-injection, and adversarial tests.
- Documentation and worked examples.

### Out of scope

- A new reasoning model.
- Autonomous authorship of values.
- Unattended payment or on-chain submission.
- A general workflow language replacing shell actions.
- Domain-specific sensor implementations beyond reference adapters.
- Automatic self-modification without an explicit authority decision.
- A distributed consensus protocol.

## 5. Success metrics

All metrics are evaluated on the contract test corpus plus at least three real workflows.

| Metric | Definition | Target | Data source |
|---|---|---:|---|
| Grounded resolution rate | Resolved action nodes with at least one valid independent terminal anchor / all resolved action nodes requiring grounding | 100% | ledger + trust audit |
| False-green detection | Seeded false-success scenarios rejected or revoked / seeded false-success scenarios | ≥95% | adversarial suite |
| Independence inflation | Cases where duplicated/derived evidence increases independent witness count | 0 | property tests |
| Failure propagation latency | Time from contradictory sensor event to dependent node invalidation | <1 resolver tick locally | activity log |
| Reach coverage | Declared effect scopes with matching consequence sensors / effect scopes | 100% for high-risk effects | capability audit |
| Frozen-rule integrity | Attempts by an action to alter its evaluator/governor accepted | 0 | adversarial suite |
| Reversible development | Applied topology changes that can restore the prior valid graph | 100% | migration tests |
| Legacy absorption | Existing supported task/declare/status workflows passing unchanged | 100% | compatibility suite |
| Observability completeness | Required lifecycle events rendered with node, edge, reason, evidence, and timestamp | 100% | renderer snapshots |
| Secret leakage | Known secret fixtures present in ledger, activity log, trace, or UI | 0 | leak scanner |

Guardrails:

- Median local task verification time must not regress by more than 20% when no advanced governance is requested.
- Ledger row size must remain bounded; large evidence stays behind typed content-addressed pointers.
- A verifier failure must never destroy the prior valid proof or prevent manual recovery.
- No new routine Keychain prompt may occur for read-only status, local unsigned checks, or log rendering.

## 6. Architecture target

```text
purpose (human authority, slowest loop)
   │ owns target and frozen boundaries
   ▼
governor ────── counter-metric / veto / rollback
   │ contains
   ▼
action ──────── declared reach and capability
   │ produces
   ▼
sensor ──────── external observation / reality anchor
   │ feeds
   ▼
evaluator ───── provenance / independence / uncertainty / expiry
   │ verdict + contradiction
   ├───────────────────────────────┐
   ▼                               │
resolved / invalidated             │
   │                               │
   ▼                               │
development proposal ── approval ──┘ changes graph topology
```

### Common node envelope

Every role reuses the existing identity, lineage, signatures, environment fingerprint, timestamps, and append-only ledger semantics. Add:

- `role`
- `authority_pointer`
- `purpose_id`
- `cadence_class`
- `effect_scope`
- `evidence_policy_id`
- `valid_from`
- `valid_until`
- `revokes`
- `supersedes`
- `schema_version`

Role-specific fields must not become an unbounded generic map. Each field has a typed parser, validation rule, canonical serialization, and compatibility behavior.

## 7. Delivery phases

### Phase 0 — Baseline and invariants

Outcome: freeze what already works and establish measurable baselines before changing semantics.

Work:

- Inventory current row types, trust fields, evidence paths, capability checks, cache keys, schedule behavior, activity events, CLI commands, and compatibility aliases.
- Record performance baselines for declare, status, task verify, cache hit, cache invalidation, and 1k-node graph audit.
- Create fixtures for the current JSONL ledger and signed outputs.
- Add a secret-leak fixture and Keychain prompt observation harness.
- Turn the principles in §3 into executable invariant tests.

Evidence:

- `docs/BASELINE-AGENCY-SUBSTRATE.md`
- benchmark JSON committed as test fixtures;
- compatibility test matrix;
- invariant tests failing only where the planned work is intentionally absent.

Exit gate:

- Existing suites pass.
- Baselines are reproducible twice within 10% variance.
- No production behavior has changed.

Rollback:

- Documentation/tests only; remove new inactive fixtures if they destabilize CI.

### Phase 1 — Typed role model

Outcome: the ledger can distinguish purpose, perception, action, evaluation, governance, and development without splitting into separate engines.

Work:

- Define role enum and versioned canonical encoding.
- Implement role constructors and validators.
- Enforce legal containment and dependency edges.
- Add authority inheritance rules.
- Preserve legacy rows as `action` or `evaluator` only when interpretation is unambiguous; otherwise keep `legacy`.
- Expose role and authority in C ABI, client API, MCP output, and CLI status.

Legal edge examples:

- `purpose → governor`
- `governor → action`
- `action → sensor`
- `sensor → evaluator`
- `evaluator → governor`
- `development → proposed graph patch`

Exit gate:

- Round-trip tests cover every role and schema version.
- Malformed and authority-escalating edges are rejected.
- Legacy fixtures remain readable byte-for-byte.

Kill criterion:

- If role-specific fields require duplicating more than 20% of the resolver, stop and redesign them as policies over the common row.

### Phase 2 — Reality anchors and sensor contracts

Outcome: grounded claims can prove where they touched the external world.

Work:

- Define anchor classes: executed test, filesystem observation, HTTP/API observation, browser state, human attestation, economic receipt, physical/adapter measurement.
- Give every anchor a content hash, source identity, collection method, observation time, expiry, and tamper status.
- Store large/private evidence behind content-addressed pointers.
- Add adapter interface for domain-specific sensors.
- Distinguish observation from interpretation.
- Reject self-referential “ledger says ledger is correct” anchors.

Reference adapters:

- command result with exit code and captured digest;
- browser assertion with URL, viewport, selector/result digest;
- HTTP response with endpoint class, status, schema digest, and freshness;
- scoped human attestation with authority and expiry.

Exit gate:

- Every grounded reference example terminates in a non-ledger anchor.
- Altered evidence fails integrity checks.
- Expired anchors cannot produce fresh truth.
- Private payloads do not appear in ledger/log/UI fixtures.

### Phase 3 — Reach and consequence coverage

Outcome: actions cannot claim effects that the system is unable to observe.

Work:

- Define effect scopes: local read, local write, network read, network mutation, deployment, message, payment, on-chain, human-impacting decision.
- Require consequence sensors for high-risk scopes.
- Bind capability grants to declared reach.
- Add dry-run/approval boundaries to mutations.
- Compute a reach-coverage verdict before resolution.

Exit gate:

- Each high-risk action fixture is rejected without a matching consequence sensor.
- An action cannot widen reach after approval.
- Read-only operations do not trigger signing or Keychain prompts.

### Phase 4 — Independence-aware evaluation

Outcome: confidence reflects independent contact with reality, not the number of confirming rows.

Work:

- Implement evidence-source lineage and independence classes.
- Detect copied, derived, circular, and same-origin evidence.
- Add counter-metric and veto semantics.
- Separate confidence, sufficiency, and validity.
- Make contradiction a first-class evaluator output.
- Integrate temporal validity and stale-evidence handling.

Exit gate:

- N derived witnesses count as one independence class.
- Circular graphs cannot satisfy quorum.
- A valid veto blocks promotion.
- Fresh contradiction invalidates cached truth in one resolver tick.
- Property tests cover graph permutations and duplicate injection.

### Phase 5 — Governance cadence and target ownership

Outcome: faster operational loops cannot silently rewrite the standards that govern them.

Work:

- Define cadence classes: immediate, operational, management, audit, purpose.
- Assign exactly one authoritative owner per target.
- Enforce mutation direction: slower owners may revise faster references; faster nodes may only propose.
- Freeze non-negotiable policies and held-out evaluators.
- Implement arbitration for conflicting action loops.
- Record every target revision with author, reason, evidence, and effective time.

Exit gate:

- Action nodes cannot mutate their own targets, evaluators, or veto thresholds.
- Conflicting loops remain blocked until an authorized governor resolves the trade-off.
- Target history is fully reconstructable.

### Phase 6 — Algedonic failure propagation and regeneration

Outcome: bad news reaches governance even when the normal path is cached, degraded, or incentivized to remain green.

Work:

- Add priority event types for failure, contradiction, sensor loss, anchor expiry, capability breach, and compromised evidence.
- Bypass positive-result caches for negative evidence.
- Recursively invalidate dependants with an explicit causal path.
- Add rollback checkpoints and last-known-good graph pointers.
- Make recovery observable as a sequence, not a status overwrite.
- Exercise process crash, partial ledger write, stale cache, unavailable sensor, and revoked identity.

Exit gate:

- Every seeded failure reaches the owning governor.
- A stale satisfied row cannot mask a fresh contradiction.
- Recovery restores a verified last-known-good state or stops with an honest unresolved status.

### Phase 7 — Governed topology development

Outcome: Contract can distinguish retrying a loop from changing the loop architecture.

Work:

- Define graph patch operations: add/remove/replace node, add/remove edge, split loop, replace evaluator, change cadence, change owner.
- Represent changes as `development` proposals with rationale, evidence, predicted impact, authority requirement, and rollback patch.
- Add dry-run simulation and invariant validation.
- Require explicit approval for purpose, authority, frozen-policy, payment, and on-chain changes.
- Apply accepted patches atomically and retain the prior topology.

Exit gate:

- Every patch is previewable, attributable, reversible, and schema-valid.
- Unauthorized self-modification is rejected.
- A failed migration restores the exact prior valid graph.

Kill criterion:

- If atomic reversible application cannot be guaranteed, ship read-only topology proposals and defer application.

### Phase 8 — Observable graph and activity renderer

Outcome: a person can tell what Contract is doing, why it is blocked, which evidence it trusts, and what requires authority.

Work:

- Define a stable JSON event schema for declaration, action, observation, evaluation, veto, invalidation, retry, rollback, approval, and topology change.
- Extend `activity_log.zig` with reason codes and causal links.
- Add `contract watch [id] --json` for streaming events.
- Add `contract explain <id>` for a compact causal narrative.
- Produce a local HTML graph renderer from the JSON stream.
- Show node role, status, owner, cadence, evidence sources, independence classes, expiry, counter-metrics, reach, retries, and blockers.
- Redact secrets before persistence and rendering.

Required states:

- working;
- waiting for evidence;
- waiting for approval;
- blocked by veto;
- stale;
- contradicted;
- rolling back;
- recovered;
- unresolved;
- satisfied.

Exit gate:

- Snapshot tests cover every state.
- The renderer works from an existing log without network access.
- A user can trace a verdict to terminal anchors in three interactions or fewer.
- Status/watch/explain create no Keychain prompts.

### Phase 9 — Bridge migration

Outcome: existing users keep working while the agency graph is introduced safely.

Work:

- Continue reading and executing legacy rows.
- Default new advanced declarations to typed roles only when required fields are present.
- Offer an explicit migration preview; never silently reinterpret ambiguous rows.
- Dual-write compatible activity events during the bridge.
- Compare old and new verdicts in shadow mode.
- Preserve old CLI verbs and aliases until absorption criteria hold.

Absorption metric:

```text
typed workflows successfully completing the same job
──────────────────────────────────────────────────────
all eligible workflows attempted during the bridge
```

Removal threshold:

- ≥80% absorption for 14 consecutive days;
- zero critical compatibility regressions;
- false-green detection improves or remains equal;
- median verification latency stays within the 20% guardrail.

Exit gate:

- Migration fixtures cover old ledgers, mixed ledgers, interrupted migration, rollback, and re-open after downgrade.

### Phase 10 — Adversarial proof and release

Outcome: the architecture demonstrates grounded behavior under stress rather than only normal-path compliance.

Required scenarios:

1. A check exits zero while browser state is wrong.
2. Five evaluators derive from one source.
3. Two evaluators confirm each other circularly.
4. A sensor expires after a cached success.
5. An action attempts to weaken its veto threshold.
6. Operational speed conflicts with safety/error rate.
7. A network mutation reaches beyond its sensors.
8. A bad-news event arrives during cache reuse.
9. A topology patch fails halfway.
10. A compromised identity’s evidence is revoked.
11. A human attestation exceeds its scope or expiry.
12. A renderer/log contains planted secret fixtures.
13. Keychain is locked during read-only inspection.
14. The legacy and typed resolvers disagree.

Work:

- Add deterministic adversarial tests.
- Add fuzz/property tests for graph edges, patches, expiry, and independence.
- Benchmark 1, 100, 1k, and 10k-node graphs.
- Run macOS Keychain interaction audit.
- Update CLI, library, trust-layer, architecture, and migration documentation.
- Produce one worked storefront verification graph and one failure/rollback demonstration.

Release gate:

- All §5 targets and guardrails pass.
- Every adversarial scenario has a documented expected causal trace.
- No high-severity security or data-integrity issue remains open.
- The compatibility bridge is enabled by default.

## 8. Dependency order

```text
Phase 0
  └─ Phase 1
      ├─ Phase 2
      │   └─ Phase 3
      └─ Phase 4
          └─ Phase 5
              └─ Phase 6
                  └─ Phase 7

Phase 1 + Phase 4 + Phase 6
  └─ Phase 8

Phases 1–8
  └─ Phase 9
      └─ Phase 10
```

Parallel work is allowed only when shared schemas are already frozen. No phase may weaken an earlier exit gate to make a later test pass.

## 9. Implementation map

Expected primary files:

- `libcontract/src/contract.zig` — common envelope and role fields.
- `libcontract/src/trust.zig` — anchors, independence, validity, vetoes.
- `libcontract/src/lineage.zig` — evidence origin and derivation.
- `libcontract/src/capability.zig` — effect scope and reach.
- `libcontract/src/gate.zig` — promotion and veto gating.
- `libcontract/src/guards.zig` — frozen governance and mutation rules.
- `libcontract/src/cache.zig` — negative-evidence invalidation.
- `libcontract/src/reverify.zig` — expiry and contradiction.
- `libcontract/src/ledger.zig` — role/event persistence.
- `libcontract/src/activity_log.zig` — causal observable events.
- `libcontract/src/client.zig` and `c_abi.zig` — public typed API.
- `libcontract/src/mcp_server.zig` — structured agent surface.
- `libcontract/src/main.zig` or CLI entrypoints — role/watch/explain/develop verbs.
- `zig/src/*` — compatibility parity where still supported.
- `docs/TRUST-LAYER.md` and architecture docs — public contract.

New modules should be introduced only when responsibility cannot fit coherently:

- `anchor.zig`
- `governance.zig`
- `development.zig`
- `event_schema.zig`

## 10. Verification strategy

### Test layers

1. **Unit:** parsers, canonicalization, role validation, expiry, authority, independence.
2. **Property:** graph permutations, duplicate evidence, circularity, patch reversibility.
3. **Integration:** declare → act → sense → evaluate → govern → invalidate/resolve.
4. **Fault injection:** crash, partial write, stale cache, sensor outage, locked Keychain.
5. **Adversarial:** all Phase 10 scenarios.
6. **Compatibility:** existing ledgers, CLI commands, signatures, cache keys, schedules.
7. **Performance:** node-scale and event-volume benchmarks.
8. **Human legibility:** explain/watch/render traces checked against expected causal stories.

### Evidence standard

A phase is not complete because code exists or an LLM says it looks correct. Completion requires:

- executable test output;
- fixture or external observation;
- causal activity trace;
- security/privacy check;
- compatibility result;
- performance comparison where relevant.

## 11. Operating cadence

- **Per change:** focused tests, formatter, static checks, secret scan.
- **Per phase:** full relevant suite, adversarial subset, benchmark delta, documentation update.
- **Weekly during implementation:** review open risks, failed assumptions, scope, and evidence quality.
- **At bridge launch:** daily compatibility and false-green review.
- **Before legacy removal:** 14-day absorption and guardrail report.

## 12. Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Role taxonomy becomes bureaucracy | Meta-system smothers operational work | Common envelope, optional advanced fields, latency guardrail |
| “Reality anchor” becomes another label | False grounding | Terminal anchor adapters and self-reference rejection |
| Human attestation becomes omnipotent override | Authority capture | Scope, provenance, expiry, counter-evidence |
| Negative events cause invalidation storms | Availability collapse | Causal deduplication, bounded propagation, last-known-good checkpoints |
| Development enables self-modification | Loss of user authority | Proposal-first, explicit approval, frozen purpose, reversible patch |
| Renderer leaks secrets | Privacy/security incident | Pointer-only payloads, redaction before persistence, planted-secret tests |
| Compatibility logic splits resolver | Long-term maintenance fork | Bridge at parsing/policy layer, one resolver |
| Keychain prompts block routine work | Poor usability and stalled agents | Prompt budget, read-only no-signing rule, explicit signing boundary tests |
| Signatures prove execution but not quality | False green | Independent sensors, counter-metrics, stress scenarios |

## 13. Definition of done

The goal is complete only when all of the following are true:

- Six roles exist as typed semantics over one resolver.
- Purpose and frozen rules have explicit human authority.
- Grounded resolutions terminate in valid independent anchors.
- Effect reach is declared and covered by consequence sensors.
- Derived/circular evidence cannot inflate confidence.
- Counter-metrics and vetoes govern promotion.
- Fresh failure invalidates stale success and propagates to the target owner.
- Cadence prevents fast loops from rewriting slow-loop criteria.
- Topology changes are proposed, approved where required, atomic, and reversible.
- Watch, explain, JSON logs, and local graph rendering expose the causal state.
- Routine read-only operations produce no Keychain prompts.
- Existing ledgers and supported CLI workflows pass through the bridge.
- All adversarial scenarios pass.
- Metrics and guardrails in §5 are met with stored evidence.
- Documentation accurately distinguishes what Contract records, what deterministic machinery verifies, what external sensors observe, and what only a human can judge.

## 14. First execution slice

Start with Phases 0–2 as one bounded slice:

1. Freeze baselines and invariant tests.
2. Add the role enum and canonical serialization without changing resolution.
3. Implement command, browser, HTTP, and human-attestation anchor fixtures.
4. Make one existing `contract task verify` produce a typed action → sensor → evaluator trace.
5. Render that trace through a minimal JSON log.

This slice proves the model without prematurely implementing automated topology mutation or a full visual graph.
