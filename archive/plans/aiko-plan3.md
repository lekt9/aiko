# Plan 3 — Resident clock hand (ledger-stateless daemon)

> **Historical plan.** Not a current worklist.

**Series:** `plan.md` (FECH capability intelligence) → `newplan.md` /
`plan-arch.md` (universal contract-native Aiko) → **this** (always-on driver
that does not become the mind).

**Companions:**

| Doc | Role |
|-----|------|
| `../contract/docs/PHOTON-POSITRON-CONTRACT-EBM.md` | Structure map (chamber) |
| `../contract/docs/PHOTON-POSITRON-GAPS.md` | Depth / wiring / scale gaps |
| `../contract/docs/PHOTON-POSITRON-RUNTIME.md` | Runtime map (waves, daemon, preempt) — shipped with this plan |
| `../contract/docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md` | Full law set (fractal seal, duals, composition, conservation) |
| `../contract/docs/MUSCLE-MEMORY.md` | Bounded DAG waves |
| `../contract/libcontract/src/scheduler.zig` | Tick / lease / settle kernel |
| `newplan.md` | Workers disposable; Contract owns durable state |

---

## 1. Goal

Ship a **product-default, killable resident** whose only job is:

```text
while true:
  plan = Contract.tick / claim   # pure function of ledger + wall clock
  execute leased claims          # stateless Aiko workers (or host actions)
  Contract.settle / release      # truth returns to the ledger
  sleep(next_wake or poll)
```

**Non-goals (explicit):**

- A daemon that holds skill memory, job queues, or “what worked” only in RAM.
- A contract graph edge that points at itself as a `while` (pointer cycles).
- Replacing Telegram limbs — limbs are the same while + channel wake.
- Superintelligence, on-chain weights, multi-prototype EBM (see gap register).

**One-sentence doctrine:**

> **Statelessness is about authority, not process lifetime.**  
> The ledger is the field; the daemon is a replaceable measuring apparatus.

---

## 2. Why this is Plan 3 (what was missing)

Plans 1–2 made Contract the reflex substrate and Aiko workers disposable.
What stayed vague:

| Question | Answer this plan freezes |
|----------|---------------------------|
| Are daemons antipatterns? | **No.** Stateful-as-truth daemons are. |
| Can Contract be the while? | **No.** It can schedule the *next occurrence*; a host must tick. |
| Pointer → pointer → end? | **Bounded DAG waves** (`muscle.schedule`); cycles rejected. |
| Preempt? | Lease expiry, release/retry, supersede/revoke, failure invalidation, reflex hold, gate — not OS mid-token kill as law. |
| What already exists? | `contract tick` / `tick --every`; ABI `contract_tick_json`; Aiko `tick_due_contracts` + `run_contract_worker`. |

**Gap this plan closes:** packaging + doctrine + proof that the **good daemon**
is default, documented, and witnessed — not a second mind.

---

## 3. Architecture (two loops, one field)

```text
                    LEDGER = field (truth)
         declare | occurrence | lease | settle | fold
                            ▲
                            │ settle / fold
              ┌─────────────┴─────────────┐
              │   RESIDENT (clock hand)   │  ← this plan
              │   killable · no authority │
              └─────────────┬─────────────┘
                            │ tick / claim
              ┌─────────────┴─────────────┐
              │  WAVE EXECUTION           │
              │  muscle DAG · reflex ·    │
              │  gate · stateless workers │
              └───────────────────────────┘
```

### 3.1 Contract kernel (already mostly built)

| Verb | Role |
|------|------|
| `scheduler.materializeDueTriggers*` | Due `at:` / `repeat:` / `when:contract:` |
| `claim` + `lease_until_unix` | Exclusive right to run an occurrence |
| `execution_released` / retry | Soft preempt / loop again later |
| `execution_settled` | Occurrence closed |
| `resolverTick` / `contract tick` | Compact + warm + materialize + backfill |
| `tick --every N` | **Native resident while** in the Contract binary |
| `muscle.schedule` | Expand root pointer → topological waves (no cycles) |
| `reflex.decide` | fire / prepare / hold |
| EBM fold on terminals | Energy of collisions |

### 3.2 Aiko host (exists, must be the default product story)

| Piece | Role |
|-------|------|
| `contract_native::tick_due_contracts` | ABI claim batch + `next_wake_unix` |
| `settle_contract_claim` | Return verdict to ledger |
| `run_contract_worker` (pager-bin) | Loop: tick → spawn single-shot worker → settle |
| Channel limbs | Same while + inbound wake (Telegram et al.) |

### 3.3 Illegal vs legal “self call”

| Illegal | Legal |
|---------|--------|
| Expand pointer A → A (cycle) | Same contract id, **new occurrence** via `repeat:` |
| Unbounded fan-out / depth | Caps in `muscle` / newplan budgets |
| Daemon learns only in RAM | Terminal → fold; process can die |
| Parent satisfies itself | Parent + only after grounded children |

---

## 4. Invariants (fail closed)

1. **Ledger is the only durable mind.** Restart resident ⇒ no lost truth if rows were written.
2. **Leases, not immortal ownership.** Expired lease ⇒ another host may claim.
3. **Workers are stateless.** Fresh process per claim (or clean budget envelope); lineage via env/parent id.
4. **No cycle expand.** Graph remains a DAG; time may re-enter.
5. **Reflex + gate before effect.** Ranking proposes; reflex/gate decide.
6. **Energy reorders; it does not starve** (when energy-ranked claim order ships).
7. **HOLD is non-terminal.** Blockers are children / release, not a fourth terminal.
8. **Privacy:** worker evidence sanitized; no credentials in settle payloads.
9. **One closed-loop step** shared by CLI tick, resident, and future MCP (`resolverTick` / ABI tick).

---

## 5. Phases (falsifiable order)

### Phase 0 — Inventory & doctrine freeze (docs)

**Ship:**

- This file (`plan3.md`).
- `contract/docs/PHOTON-POSITRON-RUNTIME.md` (waves, daemon, preempt, self-continuation).
- Cross-links from gap register § runtime, EBM map, `docs/README` (both trees).

**Gate:** docs exist; doctrine answers “daemon vs stateless” in one page.

### Phase 1 — Prove the two residents already in tree

| Resident | Command / path | What it does |
|----------|----------------|--------------|
| Contract pure tick | `contract tick --every <s>` | Compact, warm router, materialize due, backfill resolve |
| Aiko claim worker | `run_contract_worker` / packaged worker mode | Claim leases → spawn `--single` → settle |

**Gate (witness script):**

1. Declare a durable `repeat:` or `at:` contract with a safe check.
2. Run **one** `contract tick` → occurrence materializes (or claim appears).
3. Kill process; run tick again → no double-corrupt settle; lease rules hold.
4. Document exact commands in `scripts/witness-plan3-resident.sh`.

**Status of pieces:** code **BUILT**; product **PARTIAL** (not always advertised as the default limb).

### Phase 2 — Product default: one packaged resident entry

**Ship:**

- Single documented entry for operators, e.g.:
  - `aiko contract-worker` / LaunchAgent / install script path, **or**
  - documented `contract tick --every 5` for resolve-only homes.
- Install path does **not** require a chat session.
- Logging: next_wake, claims, settle outcomes; no secret prompts in durable logs.

**Gate:** fresh install → resident starts → survives logout of TUI → processes a scheduled claim.

### Phase 3 — Energy-ranked claim / frontier order (gap B wire)

When claiming or ordering ready work:

1. Score candidates by energy (resolved-like first).
2. Fairness floor: every live occurrence still fires within bound.
3. Exploration fraction: off-prior samples.
4. HOLD stays non-terminal.

**Gate:** same as `PHOTON-POSITRON-GAPS` priority 1 — beat scan-order on a fixed set; fairness mutation RED if disabled.

**Depends on:** Phase 1 witness green; do not block Phase 0–2 on this.

### Phase 4 — Limb unity

Every channel limb uses the **same** tick/claim/settle path as the worker (no shadow queues).

**Gate:** Telegram (or one limb) inbound → root contract → children → settle → fold; kill limb mid-flight → lease recovery still correct.

### Phase 5 — Optional: sleep-until-wake (not busy poll)

Use `next_wake_unix` from tick batch to sleep precisely (with channel select).

**Gate:** CPU idle when no due work; wakes within tolerance of due time.

---

## 6. Preempt & re-entry (normative map)

| Intent | Mechanism |
|--------|-----------|
| Worker died | Lease expiry → re-claim |
| Soft yield | `execution_released` + `retry_after` |
| Policy change | Agency supersede / revoke → invalidation tick |
| Bad news | `failure` breadth-first same-tick invalidation |
| User cancel (session) | Release lease + optional supersede purpose (session layer) |
| Don’t fire learned junk | `reflex.hold` / `prepare` |
| Hard safety | `gate` deny |

Energy does **not** yank a running syscall; it chooses **who gets the next lease**.

---

## 7. Relationship to photon / EBM map

| Physics | Plan 3 object |
|---------|----------------|
| Field | Ledger + reconstructible EBM |
| Pair production | Claim × check / task begin |
| Annihilation | Settle / terminal → fold |
| Measuring apparatus | Resident while (replaceable) |
| Path re-sum | New occurrence / next wave, not graph cycle |
| Vacuum refuse | Cold recommend / empty claim batch |

If the resident holds learned state, the physics story breaks (apparatus becomes field).

---

## 8. Out of scope (do not smuggle in)

- Multi-prototype EBM, fantasy negatives, ANN settle (gap C/E/G).
- On-chain weight offload (gap containment).
- ZK / query privacy.
- New currency.
- Unbounded “self-calling contract while.”

---

## 9. Success criteria (plan complete vs product complete)

### Plan 3 **document** complete when:

- [x] Doctrine frozen (daemon = clock hand).
- [ ] Runtime companion doc linked from contract + aiko indexes.
- [ ] Witness script for tick/lease existence.
- [ ] Committed and pushed.

### Plan 3 **product** complete when:

- [ ] Default install runs a resident without opening a chat.
- [ ] Phase 1 witness green on a clean machine.
- [ ] Limb path shares claim/settle with worker.
- [ ] (Stretch) Phase 3 energy-ranked order measured.

---

## 10. Immediate execution order (this wheel)

1. Land `plan3.md` (this file).
2. Land `contract/docs/PHOTON-POSITRON-RUNTIME.md` + indexes.
3. Land `scripts/witness-plan3-resident.sh` (smoke: binary exposes tick/every; ABI tick symbols; worker path referenced).
4. Cross-link from `PHOTON-POSITRON-GAPS.md` and `aiko/docs/README.md`.
5. Commit + push `aiko` and `contract`.

Implementation of Phase 2 LaunchAgent packaging and Phase 3 energy order is **next wheel** after this plan ships as doctrine + witness scaffolding.

---

## 11. Standing rules

1. Prefer fixing the **host while** over inventing a new mind in the daemon.
2. Prefer **new occurrence** over **cycle edge**.
3. Prefer **lease recovery** over sticky process affinity.
4. Prefer **documented one entrypoint** over three half-working loops.
5. Never market “always-on intelligence” without “ledger reconstructible after kill.”

---

*Plan 3 freezes the clock hand. Plans 1–2 built the field and the workers. The gap register still owns depth; this plan owns drive.*
