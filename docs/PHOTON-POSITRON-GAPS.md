# Photon / positron → Contract → EBM — gap register

> Companion to [`PHOTON-POSITRON-CONTRACT-EBM.md`](PHOTON-POSITRON-CONTRACT-EBM.md)
> (the faithful map). This file is the **honest remainder**: what the chamber
> already is, where the map overclaims, and what must close next — in
> falsifiable order.
>
> Rules live in `../DOCTRINE.md`. Risks also live in
> [`05-RISK-honest-wall.md`](05-RISK-honest-wall.md) and
> [`THESIS-collective-nonparametric-intelligence.md`](THESIS-collective-nonparametric-intelligence.md).
> Build spine for the missing wire + on-chain weights:
> [`PLAN-contracts-as-onchain-ebm-weights.md`](PLAN-contracts-as-onchain-ebm-weights.md).

**What this document is:** a durable gap register for the physics translation
of the substrate — *not* a product roadmap for every feature, and *not* an
instruction to implement “full QFT of mind” in one pass.

**What this document is not:** a claim that the mapping is false. The mapping
is a **true isomorphism of structure**. The gaps are **depth, wiring, scale,
containment, and truth**.

**One-sentence summary.** The mapping is complete as a blueprint; the gaps are
depth (router ≠ mind), wiring (energy often does not fully decide), scale
(one user, local weights), containment (energy/storage leak), and truth
(verdicts can poison the field).

---

## 0. Status legend

| Tag | Meaning |
|---|---|
| **BUILT** | Code + doctrine present; exercised in the tree |
| **BUILT+PROVEN** | Built and measured / mutation-tested where claimed |
| **PARTIAL** | Present in some surfaces/branches, not product-wide |
| **DESIGNED** | Spec exists; not fully wired or not proven at scale |
| **OPEN** | Named hole; next falsifier defined below |
| **OUT OF SCOPE (now)** | Real ambition; do not start before higher-priority falsifiers |

Every gap below carries:

- **Severity** — how much it breaks the thesis if ignored
- **What exists** — so we do not re-litigate the chamber
- **Missing** — the actual hole
- **Next falsifier** — cheapest test that would change the status
- **Risk cross-ref** — R# from `05-RISK-honest-wall.md` when applicable

---

## 1. The chamber (built atoms — not gaps)

These are **closed** for the purpose of the map. Do not re-open them as “missing”
unless the code regresses.

| Atom | Status | Primary sites |
|---|---|---|
| Ledger as field | **BUILT** | ledger modules; append-only JSONL of intents + verdicts |
| Claim × check pair production | **BUILT** | `contract task begin --check`; declare + gate |
| Terminal annihilation alphabet | **BUILT** | satisfied / died / purged |
| ±1 fold into prototypes | **BUILT+PROVEN** | `libcontract/src/ebm.zig` (`fold`, reward-weighted mean) |
| Argmin energy as settle math | **BUILT+PROVEN** | `ebm.zig` `energy` / `route`; `route.zig` `recommend` |
| Honest cold refuse | **BUILT** | no prototype → null / infinite energy; never fabricate |
| Gate separate from learned prior | **BUILT** | safety never-learned; recommend is advisory |

**Implication:** the collision chamber of a **router** exists. What is missing is
mostly deeper physics, full wiring, many particles, and containment.

---

## 2. Mapping gaps (where the analogy overclaims)

These are **language / depth** gaps. They do not mean “delete the metaphor”; they
mean “do not sell depth you do not have.”

| ID | Gap | Story implies | Actually have | Severity | Next falsifier |
|---|---|---|---|---|---|
| M1 | Full path integral | Sum over all histories with a rich action | Soft prior: nearest centroid + thin linear head | High (overclaim) | Can a richer action measurably beat cosine-centroid on a fixed task set? |
| M2 | True multi-particle interactions | Many agents’ collisions reshape one field | Architecture for N; **N ≈ 1** (founder ledger) | High (thesis) | Two independent agents fold into a shared prior and improve a held-out route? |
| M3 | Gauge / conserved laws everywhere | Noether-level invariants on every fire | Lineage + CAS + doctrine; not physics-grade conservation story | Medium | Name invariants that *fail closed* when broken (tests) |
| M4 | Renormalization / scale walk | Same law cleanly across all scales | Fractal *keys* exist; live multi-scale settle thinner than pitch | Medium | Same goal routed correctly at coarse and fine keys with measured win |
| M5 | Literal QED | Real pair-production math | **Translation only** | Low (discipline) | Keep wording: isomorphism of structure, not identity |

**Gap in one line:** the map is a true isomorphism of **structure**, not of
**depth**. You have the collision chamber of a router, not a full QFT of mind.

**Standing rule:** every external pitch that uses photon/positron language must
link or paraphrase §1 (built) + this §2 (limits) in the same breath.

---

## 3. EBM / substrate gaps (technical core)

### A. Thin energy model — R1 (central bet)

| | |
|---|---|
| **Severity** | Critical — company’s central technical bet |
| **Status** | **BUILT** as router; **OPEN** as mind |
| **What exists** | `E = −cosine(x, centroid)`; optional linear `W` (JEPA-style); train-on-fire |
| **Not in the model** | Multi-step planning, composition, novel synthesis, long-horizon credit assignment |
| **Missing** | Richer composed energy (H-JEPA-style stacks that *drive* act selection), **or** proven emergence from many thin routers + verification |
| **Next falsifier** | On a held-out multi-step task set: does energy routing + verification beat scan-order / raw LLM tool pick by a stated margin? If not, do not fund “composed mind” |
| **Do not** | Market “reasoning-grade energy model” until the falsifier passes |

### B. The missing wire — energy decides fire order

From [`PLAN-contracts-as-onchain-ebm-weights.md`](PLAN-contracts-as-onchain-ebm-weights.md):

| | |
|---|---|
| **Severity** | High — without this, the EBM is commentary |
| **Status** | **PARTIAL** (math + some measured graphs; not product-wide always-on) |
| **Hole 1** | Energy often *annotates* more than it *decides*. `route` / argmin exist and are unit-tested; live “what fires next” is not always energy-ranked with fairness floor on every surface |
| **Hole 2** | Weights live **local**, not primarily on-chain; laptop is not yet a pure frecency cache over a shared field |
| **Missing** | Always-on energy-ranked frontier order + fairness floor + exploration fraction + HOLD stays non-terminal — on the shipped Aiko/contract path |
| **Next falsifier** | Fixed task set: energy-ranked resolution beats scan-order on ≥1 metric (fires-to-settle / time / wasted spend); disable fairness → starvation RED |
| **Depends on** | Phase 0 baseline instrumentation (same plan) |

### C. Generation wall — one centroid

| | |
|---|---|
| **Severity** | High for multi-modal skills |
| **Status** | **OPEN** (called out in `ebm.zig` honest limit) |
| **What exists** | One reward-weighted mean per prototype key |
| **Missing** | Multi-prototype / mixture / hierarchical energy per key when good configs are **not** one cluster |
| **Next falsifier** | Construct a multi-modal binary (two disjoint success clusters); show single centroid fails LOO; show mixture recovers |

### D. Reasoning layer — R2

| | |
|---|---|
| **Severity** | Critical for “intelligence” claims |
| **Status** | **OPEN** (seed only) |
| **What exists** | Retrieval + energy route; shallow energy-descent generation seed |
| **Missing** | Planner that composes tools/contracts under energy **and** verification |
| **Next falsifier** | Multi-hop computer-use suite: harness + small model vs harness alone vs model alone — report deltas, not vibes |
| **Rule** | Retrieval ≠ thought. Do not conflate index coverage with reasoning |

### E. Negative phase incomplete vs classical EBM

| | |
|---|---|
| **Severity** | Medium (optional vs classical CD; still real) |
| **Status** | **PARTIAL** |
| **What exists** | `died` → reward −1 (inhibition from real failures) |
| **Missing** | Synthetic / fantasy negatives (hard-negative mining, model samples that never happened) |
| **Next falsifier** | On route_bench-class data: does adding hard negatives lift LOO without harming cold honesty? |
| **Note** | Prefer real deaths when available; fantasy negatives must not invent “skills” |

### F. Zero-shot / cold tools

| | |
|---|---|
| **Severity** | Medium (UX + exploration) |
| **Status** | **OPEN** by design of pure-ledger |
| **What exists** | Never-used binary invisible until first satisfied fire |
| **Missing** | Safe exploration floor that does **not** fabricate routes from typed descriptions |
| **Next falsifier** | Policy: explore only with explicit agent proposal + gate; measure first-success cost without polluting prototypes with unearned +1 |

### G. Scale of settle

| | |
|---|---|
| **Severity** | Medium at hundreds; High at thousands of tools |
| **Status** | **OPEN** at scale |
| **What exists** | O(N) scan over prototypes in `recommend` |
| **Missing** | ANN / hierarchical / fractal coarse-to-fine settle so cost stays bounded |
| **Next falsifier** | Synthetic N=10 / 100 / 1000 prototypes: latency + accuracy curve; define budget where ANN is required |

### H. Branch / packaging drift

| | |
|---|---|
| **Severity** | High for “what ships to users” |
| **Status** | **PARTIAL** historically (main vs lean organ strength) |
| **Missing** | One canonical packaging story: shipped Aiko binary **always** has train-on-fire + energy rank + honest cold, with a hash-attested build |
| **Next falsifier** | Install package → `contract recommend` learns from one fire → second similar goal routes correctly; documented in release evidence |

---

## 4. Verification / truth gaps — R3 (biggest risk)

Annihilation only purifies energy if the **calorimeter is honest**.

| ID | Gap | Why it matters | Status | Next falsifier |
|---|---|---|---|---|
| V1 | Verdict quality | Bad terminals train delusion into the field | **PARTIAL** (local roles) | Inject false-green; agency/trust layer must catch or system RED |
| V2 | Multi-party corroboration at scale | Local agency roles built; network two-witness not the default lived loop | **DESIGNED / local PROVEN** | Two machines, independent witnesses, same claim — only dual-agree settles shared fold |
| V3 | Sensor truth | Gate cannot prove sensor honesty or purpose wisdom | **OPEN** (inherent) | Bound claims: “evidence-gated,” not “oracle-true” |
| V4 | Fake / lazy checks | Real `--check` is social + skill; not fully enforced on all agent surfaces | **PARTIAL** | Inventory every surface that can mark done; require non-echo checks in CI/skill gates |

**Cross-ref:** `TRUST-LAYER.md`, `AGENCY-SUBSTRATE.md`, adversarial agency evidence.

---

## 5. Energy containment & economics — R5

Until containment is boring, the product stays founder-only for good reason.

| ID | Gap | Status | Next falsifier |
|---|---|---|---|
| C1 | Storage grows on every fire | By design; ship blocker if unbounded | Growth curve on N fires; bound or offload path |
| C2 | On-chain offload of weights | **DESIGNED** / partial; not proven at scale | Store/read one centroid blob on-chain; rehydrate local EBM bit-identical |
| C3 | Base + delta compression | Plan Phase 3; unproven on real sharing | Measure delta size on real weight families before betting rent savings |
| C4 | Cost model (rent / KB, off-chain boundary) | Needs continuous real numbers | Living table: devnet+mainnet rent, decision thresholds |
| C5 | “2× reliability / ½ cost” | Design target; **not independently benchmarked** | Public or third-party suite with fixed methodology |

**Rule:** prove **local energy-ranked value** (gap B) before paying for on-chain weight storage.

---

## 6. Collective / product gaps — R8–R9

You built a **collider**; you have not yet run a **beam program with many bunches**.

| ID | Gap | Reality | Next falsifier |
|---|---|---|---|
| P1 | Collective field | Thesis needs many agents; ~one today | Second user/machine compounds prior (see M2) |
| P2 | Shared prior | Architecture yes; observed multi-agent compounding no | Shared ledger fold improves held-out routes for both nodes |
| P3 | External users / replication | Founder demos; thin independent replication | Loom + repro command for one computer-use task + route_bench |
| P4 | Always-on collision discipline | TUI / MCP / daemons / skills not uniformly contract-native | Surface inventory: each path that can act must register + verify |
| P5 | Muscle memory end-to-end | Capture → learn → advise exists in pieces | One clean path: fire → fold → recommend hint on next turn, measured |

---

## 7. Privacy / identity gaps — R6

| Claim | Gap | Status |
|---|---|---|
| Data-at-rest private | Largely real (local + sealed designs) | **PARTIAL / BUILT** locally |
| Query privacy on shared index | Unsolved (PIR / replicas / ZK) | **OPEN** |
| ZK credential binding | Research direction, not shipped | **OPEN** |
| “Privacy you can verify” as product line | Ahead of code if oversold | **Discipline** — match marketing to code |

**Rule:** say “data stays yours” only for what is sealed; do not imply query privacy or ZK binding until shipped.

---

## 8. World index gaps (Unbrowse side)

Intelligence scales as **index coverage × collective firing history ×
routing/verification quality** — not params × data × compute alone.

| ID | Gap | Why the map needs it | Next falsifier |
|---|---|---|---|
| W1 | Live world as addressable field | EBM addresses the world; does not store it | Route a task that fails without index and succeeds with it |
| W2 | Coverage + freshness | Stale index = wrong energy landscape | Freshness metric + regression when index lags |
| W3 | Query privacy over index | Same as R6 | Explicit threat model; no silent “private search” claims |

Without a strong live index, collisions train **local muscle**, not
**world-grounded** low energy.

---

## 8b. Runtime spine (drive, not depth)

Separate from energy *depth*: the **clock hand** that keeps the field alive.

| Concern | Doctrine | Plan |
|---------|----------|------|
| Daemon vs statelessness | Authority in ledger; process may live forever if killable | Aiko `plan3.md` |
| Self-call while | Illegal as graph cycle; legal as new occurrence | [`PHOTON-POSITRON-RUNTIME.md`](PHOTON-POSITRON-RUNTIME.md) |
| Preempt | Lease / release / supersede / reflex / gate | Runtime doc §4 |
| Existing residents | `contract tick --every`; Aiko `run_contract_worker` | Plan 3 Phase 1 |

Full map: [`PHOTON-POSITRON-RUNTIME.md`](PHOTON-POSITRON-RUNTIME.md).

---

## 9. Priority order (what to close first)

If only five gaps close, in **falsifiable order**:

| # | Close this | Because | Stop condition (if fails) |
|---|---|---|---|
| **1** | Always-on energy-ranked fire decision + fairness floor + exploration (**B**) | Without the wire, the EBM is decoration | Does not beat scan-order baseline → do not fund on-chain weights |
| **2** | Multi-prototype / richer energy where one centroid fails (**C**, then **A**) | Generation wall blocks real multi-modal skills | Mixture does not beat single centroid on multi-modal suite → keep single mean + document limit |
| **3** | Containment: growth bound + on-chain/frecency with measured cost (**C1–C4**) | Ship blocker / energy leak | Cost model says on-chain is uneconomic → commitment-on-chain + weights off-chain fork |
| **4** | Verdict integrity at multi-agent scale (**V1–V2**) | Poisoned terminals poison the field | Dual-witness can be gamed by one node → do not open shared prior |
| **5** | Second user / second machine (**P1–P2**, **M2**) | Collective field stops being architecture-only | No compounding → thesis stays single-agent product |

**Do not start with** superintelligence, new currency, or full ZK product claims.
Those sit behind R1–R3 (A, D, V*).

### Dependency sketch

```
  [B missing wire] ──► proves router pays
         │
         ├─► [C multi-prototype] ──► multi-modal skills
         │
         ├─► [C1–C4 containment] ──► safe to ship / scale storage
         │         │
         │         └─► on-chain weights only if B proved + cost OK
         │
         └─► [V* verdict integrity] ──► safe shared prior
                    │
                    └─► [P1–P2 second particle] ──► collective field
                              │
                              └─► deeper A/D reasoning bet
```

---

## 10. Code and doc map

### Code (substrate)

| Concern | Sites |
|---|---|
| Energy cell | `libcontract/src/ebm.zig` |
| Recommend / route | `libcontract/src/route.zig` |
| Embeddings | `libcontract/src/embed.zig`, `bge.zig` |
| Gate / safety | `libcontract/src/gate.zig` (and agency/trust modules) |
| Fractal keys | fractal / pattern modules (see architecture doc) |
| On-chain / CAS | CAS, Solana modules; plan phases 2–3 |

### Docs (register and companions)

| Doc | Role |
|---|---|
| [`PHOTON-POSITRON-CONTRACT-EBM.md`](PHOTON-POSITRON-CONTRACT-EBM.md) | Faithful map (structure) |
| **This file** | Gap register (depth / wiring / scale / truth) |
| [`02-ARCHITECTURE-fractal-ebm-harness.md`](02-ARCHITECTURE-fractal-ebm-harness.md) | Architecture + status tags |
| [`HOW-IT-WORKS-intelligence.md`](HOW-IT-WORKS-intelligence.md) | recommend loop + bench |
| [`THESIS-…`](THESIS-collective-nonparametric-intelligence.md) | Scaling law + honest wall |
| [`05-RISK-honest-wall.md`](05-RISK-honest-wall.md) | Diligence risk register (R1–R12) |
| [`PLAN-contracts-as-onchain-ebm-weights.md`](PLAN-contracts-as-onchain-ebm-weights.md) | Missing wire + on-chain phases |
| [`TRUST-LAYER.md`](TRUST-LAYER.md) / agency docs | Verdict integrity surface |

---

## 11. Standing rules (how to close gaps without marketing)

1. **Chamber first.** Do not weaken pair production, terminals, honest cold, or gate/prior separation to “make energy smarter.”
2. **Falsify before fund.** Each gap’s next falsifier is the ticket to the next spend.
3. **Energy reorders; it does not starve.** Fairness floor + exploration are correctness, not polish.
4. **No fabricated routes.** Exploration proposes; ledger satisfaction earns visibility.
5. **Code wins.** If this register and the tree diverge, update this file in the same change.
6. **Pitch discipline.** Photon/positron language always pairs map + gaps (or risk wall).
7. **N=2 before N=∞.** Collective claims require a second particle, not a better diagram.

---

## 12. Change control

- Update when: energy formula, terminal alphabet, product-wide wire status, on-chain phase gates, or collective deployment status change.
- Prefer **status tag flips** (OPEN → PARTIAL → BUILT+PROVEN) over rewriting narratives.
- Cross-link new proofs into `04-PROOF-traction.md` / agency release evidence rather than duplicating numbers here.
- Aiko tree keeps a **pointer** only; this file is the canon in `Unbrowse/contract`.

---

## 13. Quick checklist (for agents and humans)

- [ ] §1 chamber still true in shipped binary?
- [ ] Gap **B** (missing wire) still PARTIAL? If closed, flip tag + link proof.
- [ ] Gap **C** multi-modal still OPEN?
- [ ] Containment cost table current?
- [ ] Any pitch this week oversold M1–M5 or R1–R3?
- [ ] Second particle (P1) status?

When all of priority 1–5 are **BUILT+PROVEN**, rewrite the one-sentence summary —
until then, keep it.

---

*End of gap register. The chamber exists; the beam program is the work.*
