# Active Goal — FECH Core Capability Intelligence

## Outcome

Build the smallest useful Fractal Energy Cell Harness across Aiko and
`../contract`: normalize Aiko-native tools, MCP tools, installed skills, and
Unbrowse routes into one typed capability descriptor; rank them locally using
Contract's existing energy/evidence machinery; return a conservative execution
plan; execute it through Aiko's existing permissioned runtime; and record a
privacy-safe outcome so future routing improves.

The proof is not a new distributed network. The proof is that Aiko selects a
working, previously-proven capability more quickly and reliably than blind tool
selection or browser fallback.

## Product Boundary

```text
Aiko inventory
  native tools + MCP tools + skills + Unbrowse routes
                         ↓
              normalized descriptors
                         ↓
        Contract ranking + evidence + plan
                         ↓
          Aiko permissions + execution
                         ↓
           sanitized outcome feedback
```

### Contract owns

- capability descriptor storage and version-aware identity;
- energy ranking over task context and verified observations;
- freshness, success/failure evidence, inhibition, and invalidation;
- prerequisite sequences and conservative parallel-group recommendations;
- the stable native ABI used by Aiko.

### Aiko owns

- discovering the four capability sources;
- resolving live availability and permission requirements;
- prompt-scoped recommendation delivery;
- agent choice, execution, concurrency, cancellation, and approvals;
- sanitizing execution observations before passing them to Contract;
- UI/TUI diagnostics explaining what was selected and why.

### Unbrowse owns

- discovering and replaying website API routes;
- authentication/capture details for those routes;
- exporting route metadata as capability descriptors.

## Core Data Types

### Capability descriptor

```json
{
  "schema_version": 1,
  "id": "provider.capability",
  "capability_version": "1",
  "provider": "aiko | mcp:<server> | skill | unbrowse",
  "tool": "tool_name",
  "action": "action_name",
  "description": "Short agent-readable purpose",
  "input_schema": {},
  "output_schema": {},
  "requires": [],
  "permission": "read | write | network | purchase",
  "effects": ["read_only"],
  "available": true
}
```

Descriptors contain stable capability facts. They do not contain mutable
success rates, usage counts, credentials, raw examples, or machine paths.

### Capability observation

```json
{
  "capability_id": "provider.capability",
  "capability_version": "1",
  "success": true,
  "duration_ms": 42,
  "permission_result": "allowed",
  "error_class": null,
  "result_shape": "object",
  "observed_at": "ISO-8601"
}
```

Observations must never contain raw arguments, prompts, URLs, credentials,
page contents, response bodies, command output, or user-entered values.

### Capability plan

```json
{
  "version": 1,
  "candidates": [],
  "sequence": ["capability.id"],
  "parallel": [],
  "confidence": 0.0,
  "margin": 0.0,
  "automatic": false,
  "reason_codes": []
}
```

V1 supports one capability, one prerequisite sequence, or one parallel group
of independent read-only capabilities. Arbitrary recursive execution is out of
scope.

## Implementation Phases

### Phase 0 — Freeze the integration contract

- [x] Audit the current Contract ABI v3 capability routing and outcome fields.
- [x] Reconcile stale ABI documentation and make one integration document
      canonical.
- [x] Define descriptor, observation, availability, and plan JSON Schemas.
- [x] Define stable ID/version rules and when old evidence is invalidated.
- [x] Add golden fixtures shared by Aiko Rust tests and Contract Zig tests.

Acceptance:

- The schemas reject credentials, raw execution content, and unknown effect or
  permission classes.
- An incompatible capability version cannot inherit previous success evidence.
- Aiko and Contract parse the same golden fixtures.

### Phase 1 — General capability registry in Contract

- [x] Replace the application-only static catalog boundary with a registry that
      accepts normalized descriptors while retaining built-in application priors.
- [x] Add native ABI operations to register/replace a source snapshot and list
      the effective catalog.
- [x] Keep descriptor state separate from append-only outcome evidence.
- [x] Deduplicate by stable ID, provider, and version.
- [x] Remove descriptors that disappear from a refreshed source snapshot
      without deleting their historical evidence.

Proposed ABI additions:

- `contract_register_capabilities(source, descriptors_json)`
- `contract_list_capabilities(filter_json)`
- `contract_recommend_plan(context, availability_json, limit)`
- `contract_record_capability_observation(context, observation_json)` reuses
  the existing append-only outcome machinery; v2 remains compatible.

Acceptance:

- Registering the same snapshot twice is idempotent.
- A removed or unavailable capability is never automatically selected.
- A catalog of 1,000 descriptors can be refreshed without ledger corruption.

### Phase 2 — Four Aiko normalizers

- [x] Normalize Aiko's built-in tool definitions.
- [x] Normalize connected MCP `tools/list` definitions and refresh them when
      tools change or a server disconnects.
- [x] Normalize installed `SKILL.md` metadata without treating prose as an
      executable interface.
- [x] Normalize Unbrowse route contracts through an explicit export adapter.
- [x] Produce live availability facts separately from descriptors.

Acceptance:

- Every advertised descriptor resolves back to a real Aiko execution target.
- Disconnected MCP servers and unavailable Unbrowse routes are inhibited.
- Descriptor collection reads no credentials and emits no credential-bearing
  fields.

### Phase 3 — Ranking and conservative composition

- [x] Rank using context affinity, verified success/failure, freshness,
      availability, permission/effect fit, and measured duration.
- [x] Return the top three candidates with machine-readable reason codes.
- [x] Support prerequisite sequences from typed `requires` edges.
- [x] Parallelize only independent read-only capabilities with no shared lock,
      session, or mutation effect.
- [x] Refuse automatic routing when confidence, margin, freshness, or
      availability thresholds are not met.
- [x] Fall back to normal Aiko reasoning and tools when no safe route qualifies.

Acceptance:

- Correct capability appears in the top three on at least 85% of the checked-in
  evaluation set.
- Automatic-route false positives remain at or below 2%.
- Stale successes cannot override fresh failures or unavailability.
- No write, purchase, message-send, or external mutation runs in an automatic
  parallel group.

### Phase 4 — Aiko execution and generic feedback

- [x] Deliver the plan through the existing prompt-scoped Contract route.
- [x] Let the model choose among non-automatic candidates.
- [x] Execute through Aiko's existing tool dispatcher, approval boundary,
      cancellation, and progress events.
- [x] Record one sanitized observation after every routed execution.
- [x] Classify permission denial, unavailable provider, timeout, invalid input,
      provider failure, and success separately.
- [x] Bind observations to descriptor version and provider identity.

Acceptance:

- Contract never invokes Aiko tools directly.
- Existing Aiko permission prompts remain authoritative.
- Failed or denied calls lower/inhibit the matching route without poisoning
  unrelated capabilities.
- Automated privacy tests prove that raw arguments and results are absent from
  the Contract ledger.

### Phase 5 — Explainability, UI, and benchmarks

- [x] Expose selected candidates, status, confidence, freshness, prerequisites,
      and reason codes through Aiko's native interface.
- [x] Add compact TUI/UI treatment for selected route, fallback, and learning
      status without dumping internal ledger terminology into normal chat.
- [x] Benchmark warm ranking, catalog refresh, route accuracy, route execution,
      and browser fallback on a fixed corpus.
- [x] Add end-to-end tests for one capability from each of the four sources.

Acceptance:

- Warm local ranking p50 is at most 50 ms and p95 at most 150 ms.
- Refreshing 1,000 descriptors completes within 500 ms on the reference machine.
- Read-only parallel plans complete successfully at least 90% of the time on
  the evaluation suite.
- A representative cached Unbrowse route beats browser fallback on measured
  latency and tool-call count.
- Aiko remains fully usable if Contract is missing or incompatible, with one
  visible degraded-state warning.

## Required End-to-End Scenarios

1. A native application task selects `application_observe` prerequisites and
   executes through the existing permission rail.
2. An MCP capability ranks, executes, records success, and ranks higher for a
   similar later task.
3. A disconnected MCP capability is inhibited immediately.
4. An installed skill is recommended as guidance but is not falsely executed
   as a tool.
5. An Unbrowse route is preferred over browser automation when available and
   proven.
6. A failed Unbrowse route falls back to the browser path and records a typed
   failure without retaining request or response content.
7. Two independent read-only capabilities run in parallel; any mutation or
   shared-session requirement forces sequential, permissioned execution.
8. Updating a descriptor to an incompatible version prevents old evidence
   from making it automatic.

## Explicitly Out of Scope

- P2P, DHT, gossip, or federated discovery;
- the public Unbrowse collective and contract publication;
- shared accounts, multi-brain sync, and cross-user permissions;
- marketplaces, monetization, reputation, and contribution incentives;
- EVM, Solana, settlement, and other on-chain work;
- scanning or wrapping arbitrary local binaries and data sources;
- viral/seed propagation;
- recursive autonomous inter-contract execution;
- a second ledger or replacement contract row schema;
- replacing Aiko reasoning or its existing permission runtime.

## Definition of Done

The FECH core is complete when Aiko can inventory the four supported capability
sources, Contract can rank and conservatively compose them from versioned local
evidence, Aiko can execute the selected plan through existing permissions, and
the sanitized result changes a later recommendation. All eight end-to-end
scenarios and the performance/privacy thresholds above must pass.
