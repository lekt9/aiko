# GraphHarness native main path — fresh independent review

> **Historical.** Dated review or transcript. Not current product documentation. What the tree is today: [../SOURCE-OF-TRUTH.md](../SOURCE-OF-TRUTH.md).

**Verdict: FAIL**

The current serial acceptance gate is green, but the bounded architecture is not implemented with zero P0/P1/P2 findings. I found **zero P0, two P1, and one P2**. The failures are confined to acceptance policy/topology; the repaired ownership, identity, Contract, reuse, and public authority seams otherwise match the newly bounded architecture.

## Scope and method

This was a fresh read of the current tree, including:

- `docs/graph-engineering/MAIN-PATH.md`;
- `aiko/.agents/skills/aiko-meta-agent/contract-skill.json`;
- the Rust GraphHarness compiler, Cell, edge, orchestration, shell-service, CLI, and MCP paths;
- `contract/libcontract/src/graph_harness_attestation.zig`, `c_abi.zig`, and the Skill-execution ledger projections;
- all of `tests/graph-harness-main-path-gate.sh` and its invoked exact-source witnesses.

Commands/probes run:

1. `bash tests/graph-harness-main-path-gate.sh` — **PASS**, run serially (exit 0).
2. Installed public `aiko workflow submit` probes from fresh temporary directories. In particular, `Return exactly the JSON object {"ok":true}` and `Compute 2 + 2 and return exactly 4` both returned `ok:true`, `state:"submitted"`, a Contract root, and a prepared CAS bundle despite there being no admitted acceptance profile.
3. Durable read-back of the generated math bundle confirmed the exact current node/edge topology described below.

Only this review document was edited.

## Findings

### P1 — The claimed two-edge subjective review is actually a chained, witness-influenced review

The architecture explicitly bounds ordinary general-language acceptance to two direct reviews of one captured product (`MAIN-PATH.md:92`). The manifest does not implement that topology:

- `verify` depends directly on `capture` and receives `product_snapshot`, `product_digest`, and `goal_digest` (`contract-skill.json:132-150`).
- `judge` depends on both `capture` **and `verify`**, and receives `verification` as an input (`contract-skill.json:154-174`).
- The manifest nevertheless says the judge acts “without trusting the witness summary” (`contract-skill.json:155`).

The prepared bundle preserves these dependencies and edges verbatim. A public fresh-directory submission produced:

```text
capture -> verify -> judge
capture ------------> judge
verify.verification -> judge.verification
```

Thus the second reviewer is structurally exposed to, and scheduled after, the first reviewer. A prompt asking it not to trust that input is not mechanical independence. `native_host_verdict` also publicly describes the captured product as being for “two direct evaluators” (`contract_native.rs:1162-1175`), which is false for the authenticated graph actually declared to Contract.

This is P1 because the defect is on the admission evidence path: correlated/anchored agreement can be deterministically settled and then signed by Contract. Repair the manifest so both model-review nodes depend directly on `capture`, neither consumes the other's verdict, and only the deterministic settlement node joins their typed outputs.

### P1 — Objective artifact workflows do not require, or refuse for lack of, an admitted acceptance profile

`MAIN-PATH.md:92` says objective artifact workflows must require an admitted bounded acceptance profile rather than prose-derived tests. No such type or check exists on the current production path:

- there is no `acceptance_profile` representation in the manifest, Rust main-path modules, public service, or gate;
- `embedded_host_profile` replaces every node's acceptance with generated `required-non-null` witness/judge programs (`graph_harness.rs:474-483, 565-578, 878-881`);
- `execute_pinned_edge` checks exact non-null output shape plus a digest re-read (`graph_harness_edge.rs:85-137, 139-220`). That is sound output grounding, but it is not an objective artifact predicate;
- the goal-specific decision remains the general-language `verify`/`judge` pair in the manifest, and Contract can subsequently attest their settled rows.

This is not merely a missing CLI label. The installed public product accepted and declared fresh Contract roots for exact-result workflows (`2 + 2 -> exactly 4` and an exact JSON object) without any admitted acceptance-profile identity in their prepared envelopes. The only package labels were evaluation/workspace/runtime authority labels. Those roots are therefore eligible for the ordinary subjective execution path instead of refusing at preparation/submission.

This is P1 because an objective claim can proceed toward Contract-signed admission using subjective review, contrary to the explicit fail-closed boundary. Add a typed objective-artifact classification and authenticated acceptance-profile identity; preparation/expansion must refuse when that identity is absent or not admitted. Do not synthesize an objective test from the goal prose.

### P2 — The green main-path gate is blind to both bounded acceptance invariants

The gate's public product probe uses only a subjective greeting. It does not submit an objective artifact request and require a stable missing-profile refusal. Its ownership checker asserts orchestration method names and evidence-field strings, but never checks that `judge` is independent of `verify` or that both bind directly to the captured product. The edge witness uses hard-coded strings such as “direct product witness passed”; it does not execute or validate the production meta-agent manifest topology (`graph_harness_edge.rs:800-805`).

Consequently the gate remains green with both P1 defects present. Add at least:

1. a manifest/prepared-envelope assertion that `verify` and `judge` each depend on `capture`, neither depends on nor consumes the other, and settlement alone joins them; and
2. a fresh-directory public negative probe proving an objective artifact workflow without an admitted profile refuses before Contract declaration/worker launch.

## Bounded architecture checks that passed

- **Contract remains sole scheduler and ledger.** Rust repeatedly asks Contract for leased waves and settles through the Contract ABI; the orchestration module contains no durable frontier or competing ledger. `expandGraphJson` validates direct bindings, declares children, calls `muscle.schedule`, and records the graph identity (`c_abi.zig:439-795`).
- **Executor ownership is correctly narrowed.** Cell nodes go through the deployment-pinned `CellSidecar`; exact deterministic host transforms and the edge-model adapter retain their own pinned adapter identities and are not relabeled as Cell (`graph_harness.rs:537-564`; `contract_native.rs:2618-2890`). This review does **not** demand that admitted host/edge transforms be short-circuited through Cell.
- **Neuron/Contract evidence chain remains fail closed.** Claims re-read the prepared CAS and compare child pins; execution emits cited sources/`produced_by`; Neuron decisions precede Contract settlement; terminal issuance is Contract-owned.
- **Attestation authority is separated.** Contract derives durable evidence/verdict references and signs using deployment bootstrap. Rust authenticates with a public-only deployment verifier. Compiler success, prepared state, and registry presence do not self-admit.
- **Prepared reuse is honest.** `workflow submit --bundle-ref` loads and rehashes immutable prepared bytes, then calls `ground_turn_with_facts_and_prepared`; it does not call `load_admitted`. Identical open submissions return the same root in the public gate. Status/inspect may authenticate historical admission, but explicitly report `contract_revalidation_no_admission_shortcut`; no historical admission path launches work.
- **No forbidden admitted short-circuit was found.** This matches the current Contract limitation: without an atomic revocation/current-key recheck plus fresh declaration, authenticated admission is inspection history, not launch authority.
- **Public authority inputs are closed.** CLI/MCP requests cannot select rollout, state roots, signer/verifier, Cell runner, or legacy bypass. Missing/drifted execution bootstrap refuses rather than falling back to repository-relative runners.
- **Primary bypass closure is mutation-sensitive.** Structured expansion and strict claim execution do not re-run `plan_bounded`; both injected planner mutations are rejected by the gate.

## Final judgment

**FAIL.** The serial gate passes and the core ownership/revalidation repairs are sound, but the current implementation and its “two direct evaluators”/objective-profile claims are not mechanically true. PASS requires zero P0/P1/P2; the two P1 acceptance defects and the P2 witness gap prevent that verdict.
