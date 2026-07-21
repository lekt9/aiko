# FECH Capability ABI v1

This document is the canonical integration contract between Contract and Aiko
for FECH capability discovery, ranking, planning, and outcome learning. The
machine-readable authority is `fixtures/fech/capability.schema.json`.

## Boundary

Contract stores versioned capability facts, ranks them against sanitized task
context and observations, and returns recommendations. It never invokes a
capability. Aiko discovers live providers, supplies availability, retains all
arguments and results, applies permissions, executes, and emits one sanitized
observation.

Descriptors and observations are separate. A descriptor cannot contain usage
statistics, credentials, examples with values, local paths, prompts, URLs, or
execution content. An observation cannot contain arguments or results.

## Stable identity and versions

`id` is `<provider>.<tool>.<action>` after ASCII lowercase normalization.
Segments contain only `a-z`, `0-9`, `_`, `-`, and `:`. Provider-qualified MCP
IDs use `mcp:<server-id>`; skill and Unbrowse IDs use their stable installed or
route IDs. Display names never participate in identity.

`capability_version` changes whenever input/output schemas, permissions,
effects, prerequisites, provider identity, or execution meaning changes. It
does not change for wording-only description edits. Evidence is keyed by the
pair `(id, capability_version)` and MUST NOT transfer to another version.

A source refresh atomically replaces that source's effective snapshot.
Registering an identical snapshot is idempotent. Missing descriptors become
unavailable but their version-bound evidence remains historical.

Contract's `aiko_builtin` snapshot is part of the effective catalog. It keeps
the typed `application_observe` / `application_act` action priors and their
capability prerequisite edges, but they become live only when Aiko advertises
the corresponding real tool in the prompt-scoped availability snapshot.

## ABI operations

The v1 JSON operations are:

- `contract_register_capabilities(source, descriptors_json)` — validate and
  atomically replace one source snapshot.
- `contract_list_capabilities(filter_json)` — return the effective catalog.
- `contract_recommend_plan(context, availability_json, limit)` — return up to
  `limit` candidates and one conservative plan.
- `contract_record_capability_observation(context, observation_json)` — the
  generalized typed recorder. It validates and re-serializes the observation
  into the existing append-only outcome machinery.
- `contract_record_capability_outcome_v2(...)` — retained as a compatibility
  wrapper for existing application-runtime callers; it does not create a
  second feedback store.

Unknown schema versions, permissions, effects, result shapes, or permission
results fail closed. Availability is prompt-scoped and is never persisted as a
descriptor fact.

## Composition rules

V1 returns either one capability, one prerequisite sequence, or one parallel
group. Automatic routing requires fresh version-matched evidence, live
availability, sufficient confidence and margin, and a permitted effect.
Parallel groups contain independent `read_only` capabilities only. Contract
may recommend; Aiko remains the execution and approval authority.

Every candidate includes `provider`, `tool`, and `action`, so Aiko can map the
recommendation back to its actual dispatcher target. `skill` providers remain
guidance-only: they can be suggested for explicit loading, but never become an
automatic route or a member of a parallel execution group.

## Privacy invariant

Only the fields admitted by the schema cross into Contract. Implementations
must parse into the typed structure and re-serialize it; they must never append
the caller's raw JSON. In particular, keys named `args`, `arguments`, `prompt`,
`url`, `path`, `credential`, `secret`, `headers`, `body`, `output`, `result`, or
`content` are not part of this ABI and cause validation failure.

## Verification

The fixed corpus and eight-scenario acceptance harness live at
`fixtures/fech/evaluation.json` and `scripts/fech_verify.py`. Build the shared
library in ReleaseSafe mode, then run the harness from the Contract root. It
checks top-three accuracy, false-positive and parallel thresholds, exact
version invalidation, fresh-failure inhibition, descriptor refresh latency,
warm ranking latency, and ledger privacy sentinels. The latest reference
machine measurements, including a real cached Unbrowse replay versus its
browser path, are recorded in `fixtures/fech/benchmark-report.json`.
