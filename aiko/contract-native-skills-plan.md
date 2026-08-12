# Contract-Native Skills Extraction Plan

> **Historical.** Dated plan. Not current product documentation. What the tree is today: [../docs/SOURCE-OF-TRUTH.md](../docs/SOURCE-OF-TRUTH.md).

## Goal

Make Aiko's Contract substrate small, generic, and mechanically enforceable.
Move domain knowledge and workflow-specific behavior out of
`contract_native.rs` and adapters into versioned contract-native skills.
Contract remains the universal execution primitive; skills describe what
contracts to materialize for a capability, how to verify them, and which
effects require authority.

The migration is complete when typical local, web, application, scheduling,
and communication workflows are implemented as discoverable skill bundles,
every bundled example passes through the real installed Contract ABI, and the
core contains no product-, application-, person-, media-, or task-specific
behavior.

## Architectural rule

```text
event or intent
  → generic skill discovery and energy ranking
  → selected contract-native skill
  → validated contract graph template
  → generic Contract DAG, lineage, budgets, and authority gates
  → deterministic scripts or fresh stateless Aiko workers
  → generic evidence and settlement
  → rendered result
```

A skill does not replace Contract. It is a declarative factory for Contract
nodes. A skill may point to other skills, and each pointer is materialized as a
normal child contract with explicit lineage, dependencies, effect scope,
authority, budget, evidence requirements, and output schema.

## Core-versus-skill boundary

### Keep in the substrate

- Contract ABI loading and compatibility checks.
- Canonical root/parent lineage and inherited depth, fan-out, concurrency,
  deadline, cancellation, and cost budgets.
- Skill discovery, manifest/schema validation, version selection, and local
  trust provenance.
- Generic graph validation, cycle detection, DAG materialization, wave
  execution, dependency barriers, retries, and settlement.
- Effect taxonomy, authority evaluation, global/per-capability kill switches,
  reversible/read-only classification, and mandatory holds.
- Durable schedules as a mechanism, without domain-specific language parsing.
- Sanitized event/evidence storage, correction, deletion, retention, export,
  and deterministic replay.
- EBM ranking, confidence calibration, cost/risk/recency penalties, and
  grounded reinforcement.
- Generic tool-call observation and stateless Aiko worker invocation.
- Operator APIs and UI/TUI renderers over generic contracts, skills, evidence,
  schedules, and reflex decisions.

### Extract from the substrate

The current Rust implementation hard-codes behavior that must become skills:

- Git branch/status/log inspection and project directory snapshots.
- Installed, running, and foreground application discovery.
- CDP target discovery and visual screenshot capture.
- Recent binary/shell-history inspection and application data-source hints.
- Natural-language deadline and recurring-cadence inference.
- Standing-rule parsing and enforcement.
- Media, playlist, image, `open`, and `afplay` command construction.
- Cat/playlist default standing orders and all other example-specific defaults.
- Unbrowse/web capability discovery rules.
- Any Telegram-, UI-, benchmark-, model-, person-, or application-specific
  graph construction.

Safety policy remains core, but concrete commands, triggers, API mappings,
composition rules, and verification procedures belong to skills.

## Contract-native skill bundle v1

Each bundle lives under `.agents/skills/<name>/` and contains:

```text
<name>/
├── SKILL.md
├── agents/openai.yaml
├── contract-skill.json
├── scripts/                  # only deterministic reusable operations
├── references/               # only detailed API/platform material
└── tests/
    ├── cases.json
    └── fixtures/
```

`SKILL.md` teaches the reasoning workflow concisely. `contract-skill.json` is
the machine interface and must include:

- schema version, skill ID, capability version, platforms, and provenance;
- trigger and context features used for discovery/ranking;
- JSON Schema inputs and outputs;
- graph templates with node keys, dependencies, parallel eligibility, worker
  type, timeouts, and inherited budget requests;
- effect scope, reversibility, read-only status, authority requirements, and
  estimated cost;
- prerequisite probes and availability checks;
- sanitized observation shapes and external verification requirements;
- composition inputs/outputs for linking to other skills;
- example cases and the deterministic test oracle for each example.

No bundle may declare itself successful. The generic runtime settles its nodes
from process results and declared external evidence.

## Initial reference skill set

Build these examples because together they exercise the common shapes without
putting domain behavior back in core:

1. **inspect-project**
   - Read-only Git branch/status/log and bounded project-tree inspection.
   - Demonstrates parallel probes and one merged structured result.

2. **build-and-test-project**
   - Detect the project toolchain, prepare build/test commands, run independent
     checks concurrently when safe, and collect exact exit evidence.
   - Demonstrates skill-to-skill composition with `inspect-project`.

3. **transform-local-files**
   - Select explicitly scoped files, prepare a reversible transformation,
     preview a diff, apply only within authority, and verify the result.
   - Demonstrates preparation versus mutation and rollback metadata.

4. **observe-desktop**
   - Report privacy-safe foreground/running application identity and optionally
     capture an explicitly requested visual.
   - Platform scripts provide macOS and Windows implementations; window titles,
     document contents, keystrokes, and credentials remain excluded.

5. **schedule-follow-up**
   - Parse explicit reminders and cadence, create proposed or authorized
     schedules, deduplicate them, and re-check prerequisites when they fire.
   - Natural-language schedule interpretation moves here; the durable scheduler
     remains core.

6. **apply-standing-rule**
   - Convert explicit “whenever/always” user rules into durable trigger,
     preparation, authorization, action, and verification contracts.
   - Contains no built-in cat, playlist, person, or application defaults.

7. **act-on-web-api**
   - Resolve and execute indexed Unbrowse/API capabilities, falling back to
     capture only when no route exists.
   - Demonstrates remote read versus consequential account mutation gates.

8. **send-notification**
   - Prepare and, with durable authority, send a notification through a
     channel-specific child skill such as Telegram.
   - Demonstrates a generic outbound-message hold and adapter composition.

9. **control-local-media**
   - Resolve local media, preview the selected asset, then play/open it using a
     platform implementation when the capability is explicitly enabled.
   - Moves `open`, `afplay`, playlist, and image-specific logic out of core.

10. **issue-to-patch**
    - Inspect an issue/repository, plan a narrow patch, edit, test, and prepare a
      commit or PR; publishing remains held without authority.
    - Exercises a realistic multi-skill graph over inspection, file mutation,
      build/test, and optional web publication.

## Work phases

### Phase 1 — Freeze and test the generic interface

- Specify and JSON-schema validate `contract-skill.json`.
- Add a generic local skill registry with deterministic precedence:
  project → user → bundled defaults.
- Reject invalid versions, unknown effects, unsafe script paths, dependency
  cycles, budget escalation, and undeclared outputs.
- Add a dry-run command that renders the exact Contract DAG without executing.
- Record the selected skill/version in every generated contract.

Exit condition: a fixture bundle can be discovered, ranked, expanded, and
rejected safely without adding Rust code for its domain.

### Phase 2 — Generic skill execution

- Materialize graph templates through the existing Contract ABI.
- Support deterministic script nodes, host probes, tool nodes, and isolated
  stateless Aiko worker nodes.
- Pass only declared structured inputs, bounded ancestor evidence, authority,
  cancellation, and remaining budgets.
- Validate structured outputs and settle nodes only from declared evidence.
- Allow independent children from one or several skills to run concurrently.

Exit condition: a composed fixture graph runs across at least three pointer
levels and four parallel siblings with correct lineage and grounded settlement.

### Phase 3 — Extract current hard-coded behavior

- Move project/Git inspection into `inspect-project`.
- Move application/process and visual capture into `observe-desktop`.
- Move schedule-language inference into `schedule-follow-up`.
- Move standing-order parsing into `apply-standing-rule`.
- Move media-specific routes/defaults into `control-local-media`.
- Move web/Unbrowse routing into `act-on-web-api`.
- Delete the corresponding domain branches and example defaults from
  `contract_native.rs`.
- Preserve compatibility by routing existing entry points through skill
  discovery rather than retaining duplicate implementations.

Exit condition: a source-level boundary test fails if removed domain tokens or
commands return to the core.

### Phase 4 — Build the reference skill library

- Implement all ten reference skills using the bundle initializer and generate
  matching `agents/openai.yaml` metadata.
- Keep `SKILL.md` concise and move schemas/platform/API detail into direct
  references.
- Reuse scripts only where deterministic behavior is necessary.
- Add explicit composition contracts between the skills.
- Bundle the validated default library into macOS and Windows packages.

Exit condition: every reference bundle validates independently, can be
discovered from a fresh installed Aiko, and has no undeclared dependency.

### Phase 5 — Evaluation harness and forward tests

- Create `scripts/test-contract-native-skills.sh` as the canonical suite.
- Validate every manifest and skill folder.
- Run every case in `tests/cases.json` in an isolated temporary HOME and
  Contract ledger.
- Snapshot the produced DAG and assert root, lineage, dependency waves,
  authority decisions, budgets, and output schema.
- Execute safe fixtures and compare externally observed results.
- Restart Aiko/Contract between learning cases and confirm ranking persistence.
- Test skill correction, version replacement, deletion, and deterministic
  ledger rebuild.
- Run adversarial cases for secret-shaped inputs, path traversal, forged
  evidence, cyclic pointers, budget escalation, command injection, missing
  authority, and consequential-effect laundering through a read-only parent.
- Forward-test representative skills in fresh agent contexts without leaking
  expected outputs.

Exit condition: the canonical suite passes every safe example and every
negative case fails closed.

### Phase 6 — Installed-runtime and UX verification

- Expose native CLI, TUI, desktop, Telegram, scheduled-worker, and subagent
  entry points to the same registry and graph executor.
- Show selected skill/version, generated children, evidence, rank explanation,
  and hold reason in existing Contract operator surfaces.
- Build/install the combined macOS runtime and run the suite against it.
- Cross-build the Windows CLI/runtime and validate manifests, Win32 process
  controls, cancellation, and package contents.
- Document how users create, test, enable, disable, update, and delete their own
  contract-native skills.

Exit condition: source-tree and installed-package runs produce equivalent
graphs and decisions on supported platforms.

## Verification matrix

The automated suite must cover:

- schema/frontmatter validation for every bundled skill;
- deterministic registry precedence and version selection;
- energy ranking between multiple applicable skills;
- three-level skill-to-skill pointer lineage;
- dependency barriers and parallel sibling execution;
- depth, fan-out, concurrency, total-work, cost, timeout, cycle, and
  cancellation limits;
- effect and authority inheritance without privilege escalation;
- externally grounded success and failure propagation;
- structured input/output validation and secret redaction;
- schedule proposal, authorization, firing, restart survival, and
  deduplication;
- persistence, correction, invalidation, deletion, and rebuild of learned
  rankings;
- project inspection, build/test, reversible file edit, desktop observation,
  web read, held web mutation, held notification, authorized test
  notification, media dry-run, and issue-to-patch dry-run;
- the same expansion path from CLI, desktop, Telegram, schedules, and
  subagents;
- macOS installed-runtime smoke tests and Windows cross-build/package checks;
- a source boundary check proving domain-specific constants are absent from
  the substrate.

Networked or consequential examples use local mock servers/sinks by default.
Tests must never send real messages, publish changes, purchase anything, access
credentials, or mutate external accounts.

## Definition of done

- The substrate is a domain-neutral Contract engine and skill interpreter.
- The ten reference workflows are contract-native skills, not Rust/TypeScript
  special cases.
- All current entry points discover and execute them through the same ABI.
- Every bundled example and adversarial case passes the canonical suite.
- Safe preparation and execution work in parallel; consequential effects are
  held without applicable authority.
- The installed macOS runtime passes the suite and Windows artifacts pass
  cross-platform checks.
- Users can inspect, correct, disable, replace, export, and delete skills and
  their learned evidence.
- The implementation, tests, packages, commits, and push are complete, with
  unrelated working-tree data preserved.
