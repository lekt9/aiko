# Photon / positron → first principles

> The Standard Model of the substrate — not a feature list.
>
> Companions:
>
> | Doc | Role |
> |-----|------|
> | [`PHOTON-POSITRON-CONTRACT-EBM.md`](PHOTON-POSITRON-CONTRACT-EBM.md) | Structure map (chamber) |
> | [`PHOTON-POSITRON-GAPS.md`](PHOTON-POSITRON-GAPS.md) | Depth / wiring / scale holes |
> | [`PHOTON-POSITRON-RUNTIME.md`](PHOTON-POSITRON-RUNTIME.md) | Drive (clock hand, waves, preempt) |
> | Aiko `plan3.md` | Product resident packaging |
>
> **Code wins.** If this file and the tree diverge, fix this file in the same change.
> **Rules live in** `../DOCTRINE.md`. This document *names* laws; doctrine and code *enforce* them.

---

## 0. One root claim

Intelligence here is not frozen weights. It is:

```text
field + duals + collision + energy + settle + bounds + drive
```

reapplied **self-similarly** at every scale, with hard cutoffs.

| Word | Meaning |
|------|---------|
| **Field** | Append-only ledger (+ reconstructible EBM + addressable world index) |
| **Duals** | Claim × antiparticle (check / gate / veto / cancel / …) |
| **Collision** | Forced meeting → terminal alphabet or HOLD chain |
| **Energy** | Fold of terminal truth into prototypes; route by descent |
| **Settle** | Argmin energy / wave completion / parent from grounded children |
| **Bounds** | Depth, fan-out, cost, sabbath, lease, privacy — UV cutoffs |
| **Drive** | Killable host while that ticks; never the source of truth |

Physics language is a **faithful translation of structure**, not literal QED.

---

## 1. Ontology (what exists)

### 1.1 Field (primary)

The **ledger** is the field. Rows are excitations and interactions. The EBM is a
**cheap local functional** reconstructed from terminal history — not a second
store of truth.

Secondary fields (coupled, not substitutes):

| Field | Holds | Must not hold |
|-------|-------|----------------|
| Ledger | Intents, terminals, leases, cache events, lineage | Secrets as free text |
| EBM prototypes | Reward-weighted means of *what worked* | Unverified opinions |
| World index (Unbrowse) | Addressable routes into the live world | Private user raw by default |
| Process RAM | Ephemeral working set | Authority, “what worked,” job truth |

**Law F1 — Field primacy.** If it is not on the ledger (or reconstructible from
it), it is not durable intelligence.

**Law F2 — Apparatus ≠ field.** Daemons, limbs, TUI sessions, and workers may
run forever or die; they do not *own* the field.

### 1.2 Particles (excitations)

| Excitation | Name in system | Birth |
|------------|----------------|-------|
| Intent γ | Goal / plan / prompt slice | User event, schedule, limb inbound |
| Claim e⁻ | Action / tool / binary / child plan | `declare` / task / wave node |
| Antiparticle e⁺ | Something that can annihilate or HOLD the claim | See §4 catalog |
| Occurrence | Time-indexed re-fire of a durable contract | `at:` / `repeat:` / `when:` / retry |
| Wave member | Ready node in a topological wave | `muscle.schedule` expand |

### 1.3 Identity stack (do not collapse)

| Layer | Role | Rotates? |
|-------|------|----------|
| **Word / truth-root** | Scripture-grounded doctrine; does not rotate | No |
| **Deployer / wallet root** | Signs *for* the Word; lineage derivation | Yes (with re-sign) |
| **Contract env key** | HKDF-derived per claim; proofs on rows | Derived, not stored |
| **Agent session** | Disposable experimenter turn | Yes, freely |
| **Limb / resident PID** | Clock hand / channel adapter | Yes, freely |

**Law I1.** Session and PID identity never substitute for wallet lineage or the Word.
**Law I2.** The root key signs for the Word; it does not replace it.

---

## 2. The atom (one collision)

At **every** scale the indivisible unit of learning is:

```text
pair production     claim × antiparticle born together
        │
        v
propagation         work in the world (tool, binary, wait, child graph)
        │
        v
collision           duals meet (check, gate, sensor, timeout, cancel, …)
        │
   ┌────┴────┐
   v         v
satisfied   died / HOLD-chain / released
   │         │
   v         v
fold(+1)    fold(−1) or no positive fold
   │
   v
field slightly reshaped → next settle prefers lower energy
```

**Law A1 — No free particles.** A substantive claim without an antiparticle is
speech, not a contract fire.

**Law A2 — Terminal alphabet is closed.** Exactly three terminals:
`satisfied` | `died` | `purged`. HOLD is **non-terminal** (chains by child /
release, does not invent a fourth end).

**Law A3 — No positive fold without grounded evidence.** LLM assertion,
activity, or self-report alone is not +1. External check / sensor / evaluator
grounding required for potentiation (muscle doctrine).

**Law A4 — Cold vacuum refuses.** No prototype ⇒ no fabricated route
(infinite energy / null recommend).

---

## 3. Fractal seal (same pattern recursively)

### 3.1 Seal statement

> **At every scale S, the atom of §2 is mandatory.**  
> Only **scope**, **budget**, and **which antiparticles apply** change.  
> The physics does not change.

| Scale S | Scope | Same atom |
|---------|-------|-----------|
| Tool fire | One binary / one tool call | claim × check → terminal → fold |
| Task | `task begin --check` | same |
| Wave node | One muscle DAG node | same |
| Root turn | User/agent turn root | same + children |
| Occurrence | Scheduled re-fire | same under new lease |
| Limb event | Inbound message | same (event → root graph) |
| Collective | Multi-agent fold into shared ledger | same alphabet, shared field |

### 3.2 Cutoff table (UV / IR bounds)

Fractal **without cutoffs** is pathology. Every expand must meet:

| Cutoff | Typical bound (normative defaults; product may tighten) | On breach |
|--------|----------------------------------------------------------|-----------|
| Graph depth | ≤ 4 (newplan) | HOLD / refuse expand |
| Children per node | ≤ 16 | refuse |
| Total children per root | ≤ 64 | refuse |
| Concurrent workers | configurable, default 4 | queue / HOLD |
| Wave count | `MAX_WAVES` (muscle) | refuse |
| Parallel per wave | `MAX_PARALLEL` | refuse |
| Pointer / dependency cycles | **0** | reject expand |
| Repeated (state, action) signature in one lineage | cycle HOLD | HOLD |
| Cost / tip self-deal | bounded rewardFromTip | no buyout of route |
| Sabbath / freeze | env / doctrine | pause drill |
| Lease duration | finite `lease_until_unix` | re-claimable |
| Store size | compact-if-oversized | archive exhaust |

**Law B1 — Expand is DAG-only.** No A→A pointer cycles; no circular self-confirmation.

**Law B2 — Time may re-enter; graph may not loop.** Same contract id may gain a
**new occurrence**; it may not expand into itself as a child forever.

**Law B3 — Parent reinforcement is grounded.** Parent + only when required
children have externally successful outcomes; unknown → neutral; failed → inhibit.

### 3.3 What is invariant vs free across scales

| Invariant (all S) | Free to change with S |
|-------------------|------------------------|
| Duals before substantive fire | Which tools / which check |
| Closed terminal alphabet | Payload of proof |
| Gate/reflex before consequential effect | Energy ranking weights |
| No cold fabrication | Embedding dimension / keys |
| Ledger primacy | Host language / limb protocol |
| Bounds exist | Numeric budgets |

---

## 4. Antiparticle catalog (what can meet a claim)

Annihilation is not only `--check`. First principles require a **catalog**.

| Antiparticle | Mechanism | Outcome class |
|--------------|-----------|----------------|
| **Check / postcondition** | `--check`, evaluator, schema verdict | satisfied / died |
| **Gate** | `gate.zig` allow/confirm/deny | deny = no effect; confirm = human dual |
| **Reflex** | fire / prepare / hold | hold = no fire; prepare = rehearse only |
| **Sensor truth** | agency sensor roles | evidence for settle |
| **Timeout / lease expiry** | `lease_until_unix` | release → re-claim (soft death of ownership) |
| **Release / retry** | `execution_released` | re-entry later |
| **Supersede / revoke** | agency pointers | invalidate subtree |
| **Failure invalidation** | same-tick breadth-first | dependants cannot false-green |
| **User / session cancel** | host releases lease (+ optional supersede) | no half-written terminal |
| **Budget exhaust** | cost / depth / child caps | HOLD with reason |
| **Cycle / expand refuse** | muscle guards | never born as illegal graph |
| **Sabbath / kill switch** | env / reflex global | hold all fires |
| **Receptor / capability** | grant missing | cannot adopt foreign value |
| **Shape reverify drift** | epoch shape | forfeit / re-prove route |

**Law P1 — Catalog completeness.** Every path that can mark work “done” or
“fire effect” must name its antiparticle. No silent completion.

**Law P2 — Calorimeter honesty.** Bad or lazy antiparticles train delusion into
the field (R3). Prefer mechanical checks; treat LLM-only verdicts as non-+1.

---

## 5. Composition algebra (how atoms combine)

### 5.1 Operators

| Op | Meaning | Reinforcement |
|----|---------|-----------------|
| **SEQ** | Wave N after deps of wave N−1 | Parent waits |
| **PAR** | Ready siblings in one wave | Independent; concurrent within cap |
| **AND** | Parent + only if all required children succeed | Default parent rule |
| **OR / first-success** | Any of a set suffices | Must be explicit; default is not silent OR |
| **QUORUM(k)** | k of n independent witnesses | Trust / multi-witness paths |
| **INHIBIT** | died / negative fold / inhibit edge | Pushes energy up / blocks |
| **HOLD** | Non-terminal wait | Child or release carries blocker |
| **WHEN** | `when:contract:` / event trigger | Birth of occurrence, not expand cycle |
| **UNDER** | Containment parent_id | Lineage + budget inheritance |

### 5.2 Credit assignment (minimal law)

**Law C1.** Positive credit flows **up** only through grounded AND (or explicit
OR/QUORUM). No parent self-satisfaction.

**Law C2.** Negative credit (inhibit) flows to the prototype of the **failed
action context**, and may HOLD/inhibit ancestors per failure policy — never
silent ignore.

**Law C3.** Multi-hop planning credit (who *caused* success three waves up) is
**not** claimed solved by single-centroid EBM. Until a richer energy model
exists, only **local** fold + explicit parent rule apply. (Maps to gap A/D.)

### 5.3 Causal cone

| Edge | Causal meaning |
|------|----------------|
| `parent_id` | Containment — child in parent's light-cone |
| `contract:` ref | Cross-edge — adoption only with receptor/grant where required |
| `when:contract:` | Temporal wake — B becomes due after A settles |
| No edge | No guaranteed influence; do not assume shared energy |

**Law C4.** Cross-lineage adoption without grant is stranger access — refused.

---

## 6. Energy laws (EBM as bookkeeping of collisions)

| Law | Statement |
|-----|-----------|
| **E1** | `E(x) = −cosine(x, prototype)` (or published successor); lower is better |
| **E2** | `satisfied` → fold +; `died` → fold − (contrastive phase) |
| **E3** | Route / recommend = argmin E over candidates; cold = refuse |
| **E4** | Energy **reorders**; it does not starve (fairness floor when ranking fires) |
| **E5** | Exploration may sample off-prior; it may not invent cold skills as facts |
| **E6** | Fractal keys: one fire may update many scales; each key is still one thin atom |
| **E7** | One centroid generalizes one cluster only (generation wall — gap C) |
| **E8** | Freshness / atrophy: disuse decays pull (catabolic half of muscle) |
| **E9** | Tip/reward shaping is bounded; value shapes route, cannot buy it |
| **E10** | Learned prior is advisory; gate/reflex are never-learned for safety |

**Action principle (honest).** Today the “action” extremized is **local route
fit**, not a full multi-step Lagrangian. Do not market path-integral planning
until composition energy exists (gap A/D).

---

## 7. Catabolism (the dual of declare/fold)

Anabolism without catabolism is unbounded growth (R5).

| Process | Role |
|---------|------|
| **Fold +** | Synthesis — remember success |
| **Fold − / inhibit** | Active rejection |
| **Freshness decay** | Passive forget without new fire |
| **Compact-if-oversized** | Store homeostasis on tick |
| **Purge** | Terminal removal class (rare, doctrine-bound) |
| **Revoke / supersede** | Authority catabolism |
| **Sabbath** | Forced rest of drill |
| **Lease expiry** | Ownership catabolism |

**Law K1.** Every resident tick should prefer **homeostasis before greed**
(compact / bound before infinite warm).

**Law K2.** Growth of the field is allowed only with a published containment
path (local bound, frecency cache, or on-chain offload plan).

---

## 8. Drive laws (runtime)

| Law | Statement |
|-----|-----------|
| **D1** | Something must tick (liveness). No tick ⇒ calendar without clock hand |
| **D2** | Tick is a pure step over ledger + now: materialize, claim, settle, warm, compact |
| **D3** | One closed-loop step shared by CLI, resident, worker, MCP |
| **D4** | Leases finite; multi-host reclaim after expiry |
| **D5** | Workers stateless; lineage via parent/env, not chat memory |
| **D6** | Preempt = lease/release/supersede/invalidate/reflex/gate — not RAM truth edits |
| **D7** | Good daemon holds no skill memory; bad daemon is the antipattern |
| **D8** | Product default should run a resident without a chat session (plan3 Phase 2) |

---

## 9. Observation and back-action

| Mode | Counts as collision? | Fold? |
|------|----------------------|-------|
| Passive read for routing | No | No |
| Declared observe with outcome | Yes if it is a contract node | Only on grounded terminal |
| Passive screenshot / log for human | No | No (and privacy-minimize) |
| Sensor role in agency graph | Yes | Per evidence policy |
| Muscle observe(before, after, reward) | Training event | Only externally verified reward |

**Law O1.** Looking is free; **claiming** is not.
**Law O2.** Observation used as +1 without dual is false annihilation.
**Law O3.** Privacy: no credentials, raw private content, or secret-shaped values
as passive training payload.

---

## 10. World-index dual (second field)

| Practice field (ledger/EBM) | World field (index) |
|-----------------------------|---------------------|
| What worked **here** | What exists **out there** |
| Train on fire | Capture once, address many |
| Cold refuse if no prototype | Miss if not indexed |
| Stale skill | Stale route / page |

**Law W1.** EBM addresses the world; it does not store the world.
**Law W2.** Intelligence scales roughly as  
`index coverage × collective firing history × route/verify quality`.
**Law W3.** Stale index is a wrong vacuum — freshness is part of energy landscape.
**Law W4.** Query privacy over shared index is unsolved; do not claim it (R6).

Unbrowse pair-production (capture → replayable route) is the **world chamber**;
Contract pair-production is the **practice chamber**. Same atom, different field.

---

## 11. Economics (coupling constants)

| Law | Statement |
|-----|-----------|
| **$1** | Cost/budget is a bound on fire, not a substitute for truth |
| **$2** | Energy and payment-energy may co-rank spend; neither overrides gate |
| **$3** | Commons reward is for verified use, not for noise (cooperative economics) |
| **$4** | “2× / ½ cost” is a design target until independently witnessed |
| **$5** | Novelty-currency ambitions are out of scope for this model |

---

## 12. Conservation laws (always / never)

### Always

1. Substantive fire carries duals (catalog §4).
2. Terminals are only satisfied | died | purged.
3. Positive fold requires grounded evidence.
4. Cold recommend refuses.
5. Expand respects DAG + cutoffs.
6. Consequential effect passes gate (and reflex where configured).
7. Durable truth is ledger-reconstructible after process death.
8. Parent + waits on grounded children (AND default).
9. Leases expire.
10. Privacy minimization on training payloads.

### Never

1. Never fabricate a route from a cold vacuum.
2. Never treat LLM “done” as +1 without check.
3. Never expand pointer cycles or unbounded fan-out.
4. Never let the daemon be the only copy of job truth.
5. Never starve forever under energy ranking (fairness floor).
6. Never adopt cross-lineage value without receptor/grant.
7. Never collapse Word / wallet / session / PID into one identity.
8. Never market full path-integral mind from cosine-centroid alone.
9. Never claim query-ZK privacy before it ships.
10. Never rewrite history’s meaning by silent RAM — only supersede/revoke/append.

### Multi-host / multi-particle (designed; proof still thin)

11. No double-satisfy of one occurrence under two honest settlers (lease + settle protocol).
12. Shared prior fold requires corroboration policy at collective scale (R3/R8).

---

## 13. Gauge / identity of descriptions

When are two texts the **same** claim?

| Mechanism | Same? |
|-----------|-------|
| Content-addressed `inputs_hash` (plan + cwd + file refs + parent) | Yes → same id (idempotent declare) |
| File refs content change | No → new claim (Docker-layer invalidate) |
| Parent inputs change | No → new child hash context |
| Cosine-similar goal, different plan | Different claims; may share prototype neighborhood |

**Law G1.** Idempotency is structural (hash), not semantic (embedding).
**Law G2.** Semantic nearness routes; it does not merge identities.

---

## 14. Irreversibility (arrow of time)

| Append-only | May supersede / invalidate | May compact |
|-------------|----------------------------|-------------|
| Declared intents, terminals, lease events | Agency revoke/supersede nullifies *authority*, not the fact that rows existed | Exhaust archive for size |
| Signatures over history | Root rotation re-signs under doctrine | — |

**Law T1.** The field’s past is append-mostly; “undo” is **new rows** (revoke,
supersede, release), not edit-in-place of meaning.
**Law T2.** Compaction must preserve reconstructible truth for live law; exhaust
is catabolism with attestation, not silent amnesia.

---

## 15. Collective phase (many-body)

| Regime | Condition | Map status |
|--------|-----------|------------|
| Single experimenter | N≈1 ledger | Default today |
| Multi-host same ledger | Leases + shared file/store | Kernel partial |
| Multi-agent shared prior | Independent fold + corroboration | Architecture > observed |
| Phase transition | Collective reliability > any node | **Bet**, not result |

**Law M1.** Do not claim collective intelligence without N≥2 witnessed compounding.
**Law M2.** Shared fold without multi-witness policy is correlated delusion risk.

---

## 16. End-to-end picture (all laws in one diagram)

```text
                         WORD (truth-root)
                              │
                         wallet signs for
                              │
         ┌────────────────────┴────────────────────┐
         │              LEDGER FIELD                 │
         │  declare · lease · terminal · cache ·    │
         │  lineage · compact                       │
         └─────────────┬──────────────▲─────────────┘
                       │              │ settle / fold
         ┌─────────────▼──────────────┴─────────────┐
         │     DRIVE (resident / limb while)        │
         │     tick → claim → workers → settle      │
         └─────────────┬────────────────────────────┘
                       │ expand (DAG, cutoffs)
         ┌─────────────▼────────────────────────────┐
         │  FRACTAL GRAPH (same atom each node)     │
         │  SEQ/PAR/AND · HOLD · WHEN               │
         └─────────────┬────────────────────────────┘
                       │ duals meet
         ┌─────────────▼────────────────────────────┐
         │  ANTIPARTICLES (check, gate, reflex, …)  │
         └─────────────┬────────────────────────────┘
                       │ ± energy
         ┌─────────────▼────────────────────────────┐
         │  EBM (local)  ←→  WORLD INDEX (address)  │
         └──────────────────────────────────────────┘
```

---

## 17. Mapping completeness checklist

Use this to audit “is the first-principles map whole?”

### 17.1 Map (documentation)

- [x] Field primacy + apparatus distinction  
- [x] Atom (pair → collide → fold)  
- [x] Fractal seal + cutoff table  
- [x] Antiparticle catalog  
- [x] Composition algebra + credit limits  
- [x] Energy laws + honest action principle  
- [x] Catabolism dual  
- [x] Drive / preempt laws  
- [x] Observation back-action  
- [x] World-index dual  
- [x] Economics coupling  
- [x] Conservation always/never  
- [x] Gauge / idempotency  
- [x] Irreversibility  
- [x] Collective phase honesty  

### 17.2 Surface inventory (where laws have code homes)

| Law cluster | Primary enforcement site | Status |
|-------------|--------------------------|--------|
| A2 terminals | `libcontract/src/terminal.zig` `classify` | **WITNESSED** (source + tests) |
| A4 / E3 cold refuse | `ebm.zig` energy +inf; `route.zig` null | **WITNESSED** |
| E1–E2 fold / energy | `ebm.zig` Prototype fold/energy | **WITNESSED** |
| B1–B2 DAG / cycles / cutoffs | `muscle.zig` schedule + cycle test | **WITNESSED** |
| A1 / P1 task duals | `zig/src/main.zig` `task begin` requires `--check` | **WITNESSED** (CLI) |
| P1 gate | `gate.zig` | **WITNESSED** (module) |
| P1 reflex | `reflex.zig` fire/prepare/hold | **WITNESSED** (module) |
| D2–D4 tick / lease | `main.zig` resolverTick / tick --every; `scheduler.zig` | **WITNESSED** |
| K1 compact / E8 freshness | tick compact; `ebm.freshness` | **WITNESSED** |
| B3 parent after children | `MUSCLE-MEMORY.md` + muscle reinforce | **WITNESSED** (doctrine+code) |
| Agent duals reminder | `SKILL.md` task begin --check | **WITNESSED** (skill) |
| Aiko claim worker | Aiko `tick_due_contracts` / `run_contract_worker` | **PARTIAL** (see plan3) |
| Every chat/MCP/TUI path duals | All agent surfaces | **OPEN** (ongoing) |
| Multi-host double-settle | Lease protocol + multi-process test | **OPEN** |
| N≥2 collective compounding | Two agents, shared prior | **OPEN** |
| Multi-hop credit / rich action | Beyond local fold | **RESEARCH** (gap A/D) |

**Mechanical guard:** `scripts/witness-first-principles.sh` (exit 0 required for
regressions of the WITNESSED rows). Run:

```bash
bash scripts/witness-first-principles.sh
```

### 17.3 Product / research remaining

- [x] **Kernel homes** for A1–A4, B1–B3, terminals, cold, lease, tick, gate, reflex — *source-witnessed*  
- [ ] **Product:** every surface enforces A1–A4 and P1 (MCP/TUI/limbs inventory still OPEN)  
- [ ] **Product:** multi-host double-settle proof  
- [ ] **Product:** N≥2 collective compounding  
- [ ] **Research:** multi-hop credit / rich action (gap A/D)  

---

## 18. Standing rules for authors and agents

1. When you invent a new fire path, **name its antiparticle** (§4) or do not ship.
2. When you nest work, **reuse the atom** (§2–3); only change scope and budget.
3. When you add memory, put it on the **ledger or reconstructible fold**, not the daemon.
4. When you pitch physics, pair **map + gaps** — structure isomorphism, not depth.
5. When you close a gap in code, flip status in `PHOTON-POSITRON-GAPS.md` and keep this file’s laws stable unless a law truly changes.

---

## 19. Change control

| Change type | Update |
|-------------|--------|
| Terminal alphabet / fold signs / cold policy | This file + EBM map + doctrine |
| New antiparticle class | §4 catalog + conservation if needed |
| New cutoff default | §3.2 table |
| Richer energy / composition credit | §5–6 and gap register (A/C/D) |
| Resident packaging only | plan3 / runtime — laws here stay |

---

*This is the first-principles map. The chamber, the fractal seal, the catalog of
duals, the algebra of composition, the catabolic dual, the world field, and the
clock hand are one system. Depth may grow; these laws are the boundary conditions.*
