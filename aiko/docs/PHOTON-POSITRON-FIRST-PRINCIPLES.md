# Photon / positron → first principles

**Upstream canon:**

[`../../contract/docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md`](../../contract/docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md)

This Aiko copy is intentionally complete at the law and integration level. The
Contract document owns substrate implementation detail; this document owns how
those laws cross the application boundary. Aiko must remain reviewable when the
sibling checkout or Gitea is unavailable.

## Companion set

| Doc | Role |
|-----|------|
| [EBM / chamber map](PHOTON-POSITRON-CONTRACT-EBM.md) | Structure |
| [Gaps](PHOTON-POSITRON-GAPS.md) | Depth holes |
| [Runtime](PHOTON-POSITRON-RUNTIME.md) | Clock hand, preempt |
| [Interface holes plan](CONTRACT-INTERFACE-HOLES-PLAN.md) | Universal Telegram/iOS/adapter routing |
| [plan3.md](../plan3.md) | Product resident |

## Root claim

```text
field + duals + collision + energy + settle + bounds + drive
```

same atom recursively (fractal seal), with hard cutoffs.

## Quick laws

1. **Ledger is the field** — daemons are apparatus, not mind.  
2. **No free particles** — substantive claim needs an antiparticle.  
3. **Closed terminals** — satisfied | died | purged; HOLD is non-terminal.  
4. **No +fold without grounded evidence.**  
5. **Cold vacuum refuses** fabricated routes.  
6. **Expand is DAG-only** — time may re-enter; graph may not cycle.  
7. **Energy reorders; does not starve.**  
8. **Catabolism is mandatory** — compact, atrophy, lease expiry, sabbath.  
9. **World index is a second field** — address, don’t store the world in EBM.  
10. **N≥2 before “collective intelligence.”**

## 1. Ontology and identity

The append-only Contract ledger is the primary field. EBM prototypes are
reconstructible summaries of terminal history; the Unbrowse index is a coupled
world field; process memory is disposable working state. A daemon, chat, TUI,
worker, or limb is apparatus and cannot be the only owner of durable truth.

Keep these identities separate:

| Layer | Authority |
|---|---|
| Word / truth root | Non-rotating doctrine |
| Deployer / wallet root | Signs for the doctrine; may rotate with lineage |
| Contract environment key | Per-claim derived proof identity |
| Agent session | Disposable experimenter |
| Resident PID / limb | Disposable clock hand or channel adapter |

Session or PID identity never substitutes for wallet lineage or doctrine.

## 2. The collision atom and fractal seal

```text
claim + antiparticle
        ↓
work propagates in the world
        ↓
check / gate / sensor / timeout / cancel collides
        ↓
satisfied | died | purged        (HOLD is non-terminal)
        ↓
grounded ± fold reshapes the field
```

The same atom applies to a tool fire, task, wave node, root turn, scheduled
occurrence, limb event, and collective contribution. Only scope, budget, and
the applicable antiparticles change.

Every expansion is bounded: depth, fan-out, total children, concurrency, waves,
cost, lease, privacy, and store size all need finite limits. Pointer and
dependency cycles are rejected. Time may re-enter as a new occurrence; the
graph may not expand into itself. Parent positive credit waits for grounded
required children.

## 3. Antiparticle catalog

Every path that can fire an effect or mark work done must name one or more of:

| Antiparticle | Collision result |
|---|---|
| Check / postcondition | Mechanical or external satisfied/died verdict |
| Gate | allow / confirm / deny before consequential effect |
| Reflex | fire / prepare / hold |
| Sensor truth | Evidence for settle |
| Timeout / lease expiry | Ownership release and later re-claim |
| Release / retry | New attempt without rewriting history |
| Supersede / revoke | Invalidates authority of a subtree |
| Failure invalidation | Dependants cannot false-green |
| User / session cancel | Release without a half-written terminal |
| Budget exhaust | HOLD with a reason |
| Cycle / expansion refusal | Illegal graph is never born |
| Sabbath / kill switch | Global hold |
| Receptor / capability | Refuses unauthorized cross-lineage adoption |
| Shape re-verification | Forfeit or re-prove a drifted route |

An LLM verdict alone is never positive evidence. Poor antiparticles train
delusion into the field, so mechanical checks are preferred.

## 4. Composition algebra

| Operator | Meaning |
|---|---|
| SEQ | A later wave waits on dependencies |
| PAR | Ready siblings execute concurrently within a cap |
| AND | All required children must succeed; the default parent rule |
| OR / first-success | Explicit alternatives; never inferred silently |
| QUORUM(k) | k independent witnesses are required |
| INHIBIT | Failure raises energy or blocks propagation |
| HOLD | Non-terminal wait carried by a child or release |
| WHEN | Event creates a new occurrence, not a graph cycle |
| UNDER | Parent containment and inherited budget |

Positive credit flows upward only through grounded AND or an explicit
OR/QUORUM rule. Negative credit attaches to the failed action context. The
current centroid EBM performs local credit assignment only; multi-hop causal
credit remains research, not a shipped claim.

## 5. Energy, catabolism, and bounds

- Energy is `-cosine(context, prototype)` until a published successor exists.
- Satisfied folds positive; died folds negative; cold routes return no answer.
- Energy may reorder ready work but must retain a fairness floor.
- Exploration may leave the prior; it may not invent a cold skill as fact.
- Gate and reflex safety are never overridden by a learned prior or payment.
- Freshness decay, negative fold, compact, purge, revoke, sabbath, and lease
  expiry are the required catabolic duals of declare and positive fold.
- Resident ticks prefer homeostasis before growth.

## 6. Drive, preemption, and observation

Something killable must tick the durable ledger. A tick materializes due
occurrences, claims finite leases, runs stateless workers, settles grounded
results, warms useful routes, and compacts bounded stores. CLI, resident,
worker, MCP, and TUI should converge on the same closed-loop step.

Sequential phases and parallel workers are represented as Contract DAG data,
not as a second workflow runtime. A later node receives earlier results through
named `input_bindings` to dependency evidence (`node.output`); ambient
`{{prev}}` text is only accepted by the migration compiler and is translated
to those explicit bindings.

Preemption is expressed as lease expiry, release, supersede, invalidation,
reflex, or gate—not as edits to hidden RAM truth. Passive observation does not
create a collision or fold. An observation may train only when declared as a
contract node and grounded by its evidence policy. Credentials and private raw
content do not become passive training payloads.

### Control plane, not execution language

Contract governs work; it does not replace the machinery that performs work.

```text
intent
  → Contract claim + dual/check + authority + bounds
  → execution plane (agent edits, shell, compiler, tool, API, human)
  → observed postcondition
  → Contract settle / release / fold
```

The provider-neutral membrane classifies authorization as
`contract_authorized`, `read_only_degraded`, or `HOLD`. Execution,
environment acknowledgement, progress, and goal completion are separate
states. When Contract cannot bind, only classified read-only work may continue
with an explicit degraded receipt. Local writes, external messages, purchases,
deletion, publication, credential access, permission changes, and process
spawns remain in `HOLD`.

A process-spawn envelope additionally requires a finite lease, health sensor,
cancellation capability, restart owner, restart bound, and child-process
bound. These are graph/control data; native process machinery remains the
executor.

Code is still edited as code and verified by real compilers and tests. A
Contract row that merely says “generate code” without an execution path and
postcondition is a free particle, not execution.

Not every internal operation becomes a contract. Passive reads, local
reasoning, reversible inspection, and disposable intermediate experiments may
remain ephemeral. Cross the Contract boundary when work is consequential,
durable, scheduled, delegated, retryable, externally effectful, or intended to
train the shared prior. This preserves a small auditable control plane instead
of turning the ledger into a transcript of every shell token.

### Internal systems are nested funnels and flywheels

An internal tool intended to persist or improve is compiled as the same closed
loop at each applicable scale:

```text
micro action → sensor → evaluator
                         ↓ evidence funnel
meso action  → sensor → evaluator
                         ↓
macro action → sensor → evaluator
                         ↓
global action → sensor → evaluator
                         ↘ new bounded occurrence
```

Micro concerns one tool fire. Meso concerns a workflow or session. Macro
concerns the product, team, or durable capability. Global concerns purpose,
governance, and whether the system itself should change. Every action has a
sensor and evaluator; slower layers consume grounded evidence from faster
layers rather than self-report.

The flywheel is temporal, not a graph cycle. One occurrence remains a bounded
DAG. Its evaluator may schedule a new occurrence under a finite recurrence
policy. Development may propose a new version but cannot silently rewrite the
live graph. Interfaces such as CLI, TUI, MCP, messaging, and iOS hook into the
same compiled system as receptors and effectors.

Contract's native `workflow.zig` compiles `kind: contract_internal_system` data
into this topology and exposes it through
`contract_compile_internal_system_json`. Aiko's
`scripts/contract_workflow.py` is only an ABI adapter. The substrate refuses
missing purpose, authority, evidence policy, unbounded recurrence, duplicate
scales, gaps in the micro-to-global funnel, and unknown effects. Each accepted
effect derives its own sensor evidence, evaluator evidence, and approval class;
generic success receipts cannot stand in for delivery, goal progress, recovery,
or cancellation evidence. Aiko calls the native
`contract_validate_effect_evidence_json` collision gate; removing even one
derived antiparticle makes validation fail.

## 7. World field, economics, and conservation

The practice field remembers what worked here; the Unbrowse world index
addresses what exists out there. EBM points into the world rather than storing
it. Index freshness is part of the energy landscape, and shared-query privacy
remains open.

Cost is a bound, never a substitute for truth. Tips and rewards may co-rank a
route within bounds but cannot buy through a gate.

### Always

1. Carry a dual for every substantive fire.
2. Use only `satisfied | died | purged` as terminals.
3. Require grounded evidence for positive fold.
4. Refuse cold recommendation.
5. Enforce DAG expansion and finite cutoffs.
6. Gate consequential effects.
7. Reconstruct durable truth after process death.
8. Wait for grounded required children before parent success.
9. Expire leases.
10. Minimize private training payloads.

### Never

1. Fabricate a route from a cold vacuum.
2. Treat an LLM saying “done” as positive evidence.
3. Expand a cycle or unbounded fan-out.
4. Make a daemon the sole copy of job truth.
5. Starve forever under energy ranking.
6. Adopt cross-lineage value without a receptor or grant.
7. Collapse doctrine, wallet, session, and PID identity.
8. Claim rich path planning from a cosine centroid.
9. Claim query-ZK privacy before it ships.
10. Rewrite history in RAM; append release, revoke, or supersede events.

## 8. Identity, time, and collective phase

Structural content hashes define claim identity; embedding similarity only
routes and never merges identities. Undo is represented by new append-only
events. Compaction must preserve reconstructible live truth.

Collective intelligence requires an observed `N≥2` compounding result and a
multi-witness fold policy. Shared prior without corroboration is correlated
delusion risk.

## 9. Aiko integration surface

| Law cluster | Aiko enforcement site | Current status |
|---|---|---|
| D2–D4 tick, claim, lease | `contract_native.rs::tick_due_contracts` | Wired |
| Grounded settle / release | `settle_contract_claim`, `settle_contract_prompt` | Wired |
| Process drive | `run_contract_worker` / scheduler loop | Wired |
| Gate / reflex | Contract ABI gate plus `decide_reflex` | Wired |
| Cold route / energy rank | Contract recommend ABI + capability ranking | Wired |
| Cancellation | Contract cancel ABI + prompt release path | Wired |
| Resident product packaging | `plan3.md` + install/package witness | Partial |
| Automatic root/schedule/tool contract boundaries | Host `contract_native` integration | Wired |
| Contract-unavailable effect policy | Explicit read-only degradation; consequential `HOLD` before dispatch | Wired |
| Agent chooses discretionary Contract boundary correctly | Injected policy + positive/negative examples | Open |
| Every model-facing tool execution (chat/TUI, including bridged MCP) carries a dual | Central `execute_tool_calls` begin/settle chokepoint plus injected-bypass witness | Wired |
| Non-tool chat/MCP/TUI lifecycle events carry a dual | Surface-by-surface inventory | Open |
| Predictor state survives process restart | Two-process isolated-store witness | Wired |
| Sequential/parallel workflow data with prior-output flow | Contract DAG `depends_on` + typed `input_bindings` | Wired |
| Runtime workflow input resolution | Named direct-dependency evidence resolver; missing evidence blocks readiness | Wired |
| Prompt/agent fitness ancestry | HMAC-signed append-only lineage with prompt, artifact, eval-set, provider, run, judge, and private default key | Wired |
| Provider-neutral interface membrane | One typed state machine across CLI, TUI, MCP, messaging, iOS, subprocess, and API families | Wired |
| Long-lived process ownership | Spawn envelope requires lease, health, cancellation, owner, restart, and child bounds | Wired |
| Multi-host double-settle | Multi-process lease witness | Open |
| N≥2 corroborated compounding | Collective integration witness | Open |
| Multi-hop causal credit | Richer energy model | Research |
| ARC hypothesis-as-Contract learning | Typed hypothesis, predicted semantic delta, evidence state, and scope registered as capability data; prediction agreement settled independently from level progress | Wired |

“Wired” means a concrete Aiko code home exists and is guarded by
`scripts/witness-first-principles.sh`; it does not promote the explicitly open
rows into completed claims.

## 10. Mapping completeness checklist

- [x] Field primacy and apparatus distinction
- [x] Collision atom and closed terminals
- [x] Fractal seal and finite cutoffs
- [x] Antiparticle catalog
- [x] Composition and local-credit limits
- [x] Energy laws and cold refusal
- [x] Catabolic dual
- [x] Drive, preemption, and observation
- [x] World-index dual and economics
- [x] Conservation laws, identity, and time
- [x] Collective honesty
- [x] Aiko integration inventory with open gaps preserved
- [x] Control-plane/execution-plane boundary and contracting threshold

Mechanical witness:

```bash
bash scripts/witness-first-principles.sh
```

Comprehensive capability gate:

```bash
bash scripts/test-first-principles-capabilities.sh
```

## 11. Capability test matrix

| Claimed capability | Executed witness | Strength |
|---|---|---|
| Terminal alphabet, fold/energy, cold refusal | Full `libcontract` `zig build test` | Behavioral kernel tests |
| DAG/cycle/cutoff composition | Full `libcontract` `zig build test` | Behavioral kernel tests |
| Gate, reflex, lease, release, compact/freshness | Full `libcontract` `zig build test` | Behavioral kernel tests |
| Aiko bounded cell expansion and dependency spine | `cargo test -p xai-grok-shell contract_native::tests` | Behavioral integration unit tests |
| Prompt-scoped routes and claim occurrence identity | Same Rust suite | Behavioral integration unit tests |
| Privacy filtering and secret-shaped state exclusion | Same Rust suite | Behavioral integration unit tests |
| Central tool Contract chokepoint has teeth | `witness-contract-chokepoint.sh` injects dispatch and removes bind/HOLD | Negative/falsifier test |
| Learned predictor survives restart | `witness-contract-predictor-persistence.sh` trains and recalls in separate processes | Cross-process behavioral witness |
| Workflow phases compile to Contract dependencies and evidence bindings | `test-contract-workflow.py` | Compiler and negative-input test |
| Signed evaluation ancestry rejects tampering | `test-contract-lineage.py` | Cryptographic chain and mutation test |
| Consequential effects fail closed without Contract | `membrane_degrades_reads_but_holds_unbound_effects` | Runtime policy unit test |
| Interface-neutral membrane and process bounds | `contract_native::membrane::tests` | Seven-family state-machine tests |
| Execution does not manufacture progress | `receipt_never_confuses_acknowledgement_with_progress` | State-separation unit test |
| Workflow bindings resolve only settled named evidence | `resolves_only_named_dependency_evidence` | Positive and missing-evidence tests |
| Tick ABI, settle/cancel/reflex/recommend bridges | `witness-first-principles.sh` | Linkage/source contract |
| Resident tick, worker, lease, and CLI exposure | `witness-plan3-resident.sh` | Non-mutating runtime smoke |
| Documentation guard itself | Isolated missing-antiparticle mutation | Negative/falsifier test |
| ARC semantic transition laws do not counterfeit success | `test_world_model.py` plus all-25-game/two-seed `bootstrap-deadlock-gate.sh` | Unit separation + behavioral benchmark |
| Internal tools compile as bounded multiscale flywheels | `test-contract-workflow.py` | Four action-sensor-evaluator loops, three evidence funnels, and recurrence falsifiers |
| Effect classes derive mandatory antiparticles | Native `workflow.zig` profile tests plus `test-contract-workflow.py` | Messages, payments, writes and processes receive distinct evidence requirements; unknown effects fail closed |

The comprehensive gate intentionally does **not** start an infinite resident,
fire consequential effects, spend provider funds, mutate the user’s Contract
ledger, or claim the Open/Research rows. Multi-host double-settle, product-wide
non-tool lifecycle dual coverage, discretionary agent boundary selection, N≥2 compounding, and
multi-hop credit require their own future integration environments and remain
unpassed.

### ARC learning is more than weight updates

The predictor's weights are only one memory form. A reusable ARC lesson may
also be a Contract-native hypothesis:

```text
semantic precondition
  + provider-neutral capability
  + predicted semantic delta
  + evidence state and lifetime scope
  → bounded experiment
  → observed transition delta
  → prediction settlement
  → independent task-progress settlement
```

This distinction prevents a correct dynamics prediction from masquerading as
solving the level. The durable declaration records what the experiment claims
will happen; the native muscle records how often that prediction survives
contact with the environment. Exact frame hashes, coordinates, and tried
actions remain episode-local. Archetype memory may retain semantic roles,
transition laws, and inhibited hypotheses. Global memory may retain proposer
reliability, but never game IDs or coordinate replays.

The current honest ARC witness completes 14 aggregate levels over all 25 games
and two seeds in both arms. Contract reaches those completions in 354 actions
versus the baseline's 358. Seven distinct level families now clear: the new
family came from treating an archetype as an observable Contract precondition,
not as an exact action-list identity. Region-control can expose a secondary
reset/commit action alongside click; it binds only when the frame contains both
multiple candidate controls and a sufficiently large controlled region. Empty
click canvases refuse the solver. Twenty-one game families still complete no
levels in this run; the open frontier remains general proposal and learned-goal
quality.

## 12. Change control

When adding an effect path, name and wire its antiparticle. When adding nested
work, reuse the collision atom and add bounds. When adding memory, put durable
truth on the ledger or in a reconstructible fold. Changes to terminals, fold
signs, cold policy, antiparticle classes, or cutoff defaults must update the
Contract canon and this integration copy together. Product-only packaging stays
in `plan3.md` and the runtime companion.
