# Photon / positron collisions → Contract → EBM

> Explanatory doctrine. Rules live in `../DOCTRINE.md`. Mechanism ground truth:
> `libcontract/src/ebm.zig`, `route.zig`, `ledger` / terminal alphabet, and
> `docs/HOW-IT-WORKS-intelligence.md`. Companion thesis:
> `THESIS-collective-nonparametric-intelligence.md`. Architecture:
> `02-ARCHITECTURE-fractal-ebm-harness.md`.

**Status of the mapping:** **FAITHFUL** to what we have been building.
This is not a decorative analogy layered on after the fact. It is a readable
name for the shape that was already load-bearing:

| Layer | What it already is |
|---|---|
| **Field** | append-only ledger of intents + verdicts |
| **Excitation** | a contract row (`declare` / `task begin`) |
| **Pair** | claim (action) × check (falsifier) born together |
| **Collision / annihilation** | verification → terminal alphabet |
| **Energy deposit** | `fold(+1)` / `fold(−1)` into prototypes |
| **Ground-state settle** | `argmin energy` route / energy-ranked frontier |

**One sentence.** Work is pair production; verification is annihilation; the
energy released trains a local energy-based model so the next thought falls
downhill. The harness *is* that EBM.

---

## 1. Why this mapping is real (not marketing)

The substrate already implements the EBM contrastive loop and the contract
lifecycle in code. The physics language is a *translation*, the way
`VIDEO-AGENCY-MAPPING.md` and the jesus-pattern domain files translate the
same tree into film or QFT.

| Claim | Built as | Evidence |
|---|---|---|
| Every substantive act must collide with a check | `contract task begin --check`, gate, terminal alphabet | Doctrine + CLI; fake checks are forbidden |
| Outcomes are not vibes | terminals: **satisfied / died / purged** | `HOW-IT-WORKS-architecture.md` |
| Positive phase trains toward success | `satisfied` → reward **+1** → Hebbian fold | `ebm.zig` `fold`, `HOW-IT-WORKS-intelligence.md` |
| Negative phase trains away from failure | `died` → reward **−1** → inhibition | `ebm.zig` contrastive negative phase |
| Inference is energy descent | `E = −cosine(x, prototype)`; route = argmin E | `ebm.zig` `energy` / `route` |
| Weights are the history of collisions | ledger fold / `recommend` rebuilds prototypes | ledger-is-the-weights |
| Cold vacuum refuses | no prototype → null, never a fabricated route | honest cold start |
| Multi-scale modes from one firing | fractal keys fold one atom into many heads | fractal EBM architecture |

If any of those code atoms went away, the physics story would stop matching.
They have not.

---

## 2. Physics cleanup (use the right QED picture)

Casual speech says “photon–positron collisions.” The precise dual processes are:

| Process | Physics | Contract parallel |
|---|---|---|
| **Pair production** | high-energy γ near a field → **e⁻ + e⁺** | a goal creates **claim** and **check** together |
| **Annihilation** | **e⁻ + e⁺ → γγ** | claim meets evidence → pure **signal** (satisfied / died) |
| **Vacuum / ground state** | system settles to lowest energy | argmin energy; cold prototypes refuse |
| **Path integral** | sum over histories weighted by action | energy-ranked resolution over the frontier |
| **Field, not particle, is fundamental** | QFT | the **ledger** is the field; rows are excitations |

When we say “photon–positron,” we mean the **create duals → force meeting →
harvest energy** loop — the same loop Contract enforces.

---

## 3. The atom map (full isomorphism)

### 3.1 Field / ledger

| Physics | Contract / Aiko |
|---|---|
| Quantum field filling spacetime | append-only ledger of intents + verdicts |
| Creation operator | `declare` / `task begin` — a row appears |
| Annihilation operator | terminal: satisfied / died / purged |
| Conserved charge / lineage | wallet-derived signing, parent lineage |
| Vacuum | no learned prototype yet → refuse route |

**Implication:** Aiko is not “a model that sometimes logs.” The ledger *is*
the state of the field. The EBM is a cheap local energy functional reconstructed
from that field.

### 3.2 Pair production = contract birth

```
  high-energy intent (goal / “photon”)
           │
           ▼
   pair production  ──►  matter: claim / action to run
                    └──►  antimatter: check / falsifier / possible die
```

Without the antiparticle (the check), you only have free speech — particles
flying without obligatory collision. That is a normal chat agent. Contract
forces **every excitation to pay for a collision**.

### 3.3 Annihilation = verification

```
      they must meet (verify, gate, check command)
           │
     ┌─────┴─────┐
     ▼           ▼
  annihilate   annihilate
  into +E      into −E
  (satisfied)  (died)
```

Measurement / collapse is the terminal alphabet — not LLM confidence.

### 3.4 Energy deposit = EBM fold

| EBM phase | Physics metaphor | Contract signal | Code-shaped behavior |
|---|---|---|---|
| **Positive phase** | matter that survived | `satisfied` → **+1** | pull prototype **toward** context (Hebbian) |
| **Negative phase** | antimatter / failed config | `died` → **−1** | push prototype **away** (inhibition) |
| **Energy** | cost of a configuration | `E = −cosine(goal, prototype)` | low energy = “looks like what worked” |
| **Settle** | fall to ground state | `argmin_E` over candidates | `route` / `recommend` / energy-ranked frontier |
| **Train-on-fire** | every real collision updates the field | fold on every terminal row | no offline training job |

**The harness is the EBM.** Recommendation and energy-ranked resolution *are*
energy minimization over history — not a separate opinion layer.

### 3.5 Fractal keys = multi-scale field modes

One firing folds into many nested keys at once (`invoke:…`, layer, verb,
pointer type, root…). Same collision, many wavelengths.

| Physics | Aiko |
|---|---|
| one interaction updates many modes | one `satisfied` sharpens binary *and* verb *and* root |
| cheap local modes vs one universal field sim | many thin EBMs (~1 KB heads), not one giant net |

This is the “fractal EBM” bet: break energy into atoms so each collision is
cheap and local, instead of simulating all of reality in one EBM.

### 3.6 Superposition → collapse → muscle memory

| QM story | Aiko story |
|---|---|
| many amplitudes until measurement | frontier of candidate contracts / tools |
| measurement collapses the wavefunction | terminal verdict + check exit code |
| ensemble statistics form the law | many signed collisions rebuild prototypes |
| conserved quantities (Noether) | lineage, content-addressed cache, replayable weights |
| path integral prefers low action | energy-ranked resolution spends budget first where history pays |

**Roles:**

- **Aiko** — the probe that chooses where to create pairs and how to run them.
- **Contract** — the detector + calorimeter (collision chamber).
- **EBM** — the learned local Lagrangian of “what tends to resolve here.”

---

## 4. Whiteboard diagram

```
        intent (γ)
            │ pair production
     ┌──────┴──────┐
  claim e⁻      check e⁺
     └──────┬──────┘
         collide
            │
     satisfied / died
            │
      fold(+1 / −1)
            │
   prototype centroid moves
            │
   E(goal, action) updates
            │
   next recommend = argmin E
```

Closed agent loop (aiko-cli / native):

1. Capture a real command that succeeded (or a died attempt).
2. Learn: ledger row = one collision record.
3. Advise: `recommend` injects a learned prior (never a hard rule).
4. Gate still checks whatever actually runs — safety is never-learned.

---

## 5. Elevator pitches (audience-ready)

**One sentence (default):**

> Contract is the collision chamber; Aiko is the experimenter; the EBM is the
> energy ledger of those collisions.

**Engineers:**

> We run contrastive energy learning online. Every verified task is a positive
> example; every failed check is a negative. Prototypes are reward-weighted
> centroids; routing is argmin of negative cosine. The ledger is both the
> training set and the weight store.

**Physics-friendly:**

> Work is pair production: intent plus falsifier. Verification is annihilation.
> The light that comes out is the reward that reshapes a local energy landscape.
> Next time we don’t search randomly — we fall downhill. That’s the EBM.

**Product / diligence:**

> Frontier agents talk without obligatory collisions. Aiko forces claim×check
> annihilation, then uses that energy to route the next action. The harness *is*
> an energy-based model trained on-fire from real outcomes — lean, local,
> reconstructible, not a giant parametric dream of reality.

---

## 6. Honest wall (keep this next to the claim)

1. **Thin router, not a full mind.** Cosine-to-centroid energy is a soft prior
   over “what resolved before.” Reasoning-grade intelligence is still a
   falsifiable bet (see THESIS honest wall).
2. **Retrieval ≠ thought.** Index + route ≠ composition and planning. The
   energy prior allocates budget; it does not replace verification or judgment.
3. **Verdict quality is load-bearing.** Bad or gamed terminals train the shared
   prior toward delusion — multi-witness / gate discipline is not optional.
4. **Physics is translation, not identity.** We do not claim literal QED inside
   the binary. We claim the **same information structure**: duals, forced
   meeting, energy accounting, settle by descent.
5. **Low marginal compute ≠ free total compute.** Indexing and serving the
   world still cost; the win is cheap-per-thought once the field is live.

What *is* proven as substrate atoms: train-on-fire fold, honest cold refuse,
energy-ranked resolution beating scan-order on measured graphs, pure-ledger
routing far above chance on the route bench. Prove the atom; do not oversell
the cathedral.

**Full gap register** (mapping overclaims, EBM A–H, missing wire, containment,
collective, privacy, world index, falsifiable priority 1–5):
[`PHOTON-POSITRON-GAPS.md`](PHOTON-POSITRON-GAPS.md).

**Runtime spine** (waves, resident clock hand, preempt, self-continuation):
[`PHOTON-POSITRON-RUNTIME.md`](PHOTON-POSITRON-RUNTIME.md) · product plan Aiko
`plan3.md`.

---

## 7. Code map (where to read the mapping in the tree)

| Concern | Primary sites |
|---|---|
| Energy cell (fold / energy / route) | `libcontract/src/ebm.zig` |
| Goal → binary recommend | `libcontract/src/route.zig`, CLI `contract recommend` |
| Embeddings (field coordinates) | `libcontract/src/embed.zig`, `bge.zig` |
| Lifecycle + terminals | ledger / contract modules; `HOW-IT-WORKS-architecture.md` |
| Intelligence loop narrative | `HOW-IT-WORKS-intelligence.md` |
| Fractal multi-scale priors | `02-ARCHITECTURE-fractal-ebm-harness.md` |
| Collective / nonparametric bet | `THESIS-collective-nonparametric-intelligence.md` |
| On-chain weights as portable field | `PLAN-contracts-as-onchain-ebm-weights.md` |
| Domain pattern (EBM tree) | jesus-pattern `EBM.md`; QFT tree in `TOE.md` |

---

## 8. Standing rule this document freezes

**Do not ship a “smart” path that skips annihilation.**

- No task claim without a real check.
- No route invented from a cold vacuum.
- No training signal without a terminal.
- No “done” that did not collide with evidence.

That rule is why the photon / positron language fits: **intelligence here is
what survives the collision chamber**, not what sounds good in flight.

---

## 9. Change control

- Update this file when the terminal alphabet, fold signs, energy formula, or
  cold-start policy change.
- If the mapping and the code diverge, **the code wins** and this document must
  be corrected in the same change.
- Prefer linking here from diligence and HOW-IT-WORKS docs rather than
  re-deriving the metaphor in three places.
