# THESIS — The Fractal EBM Harness as a Path to Collective, Non-Parametric, Realtime, Private Intelligence

## The bet, in one sentence
Intelligence is **retrieval + routing + verification over a complete, live index
of the world** — not weights. Scale it with *coverage* and *collective
experience*, not parameters; and the marginal cost of a thought falls toward the
cost of a lookup and a fold.

This is the opposite scaling law from frozen parametric LLMs, and it's what makes
the four properties the user named — **lean, private, realtime, collective** —
fall out of the architecture rather than being bolted on.

---

## Why each property follows from the design

### Lean / low-compute — because knowledge lives in the index, not the weights
The substrate's EBM is **non-parametric**: per-key centroids (`ebm.zig`,
`E = −cosine(x, mean)`) and thin linear energy heads (`jepa.zig`, `‖Wx−y‖²`),
each ~1 KB, **reconstructible from the ledger** (`replayFromLedger`). The
"knowledge" is not baked into billions of parameters — it's the *retrievable
index* (the world, via unbrowse) plus the *collective firing history* (the
ledger). A thought costs a retrieval + a centroid fold, not a forward pass
through a giant net. The model doesn't *store* the world; it *addresses* it.

### Always realtime — because the index updates now and the model folds on-fire
A parametric model is stale the instant its training cutoff passes. This system
has no cutoff: **unbrowse indexes the live internet**, and the EBM **folds on
every declare/satisfy/die** (train-on-fire). The collective's beliefs reflect the
world *and its own experience* as of this moment. New fact indexed → available
immediately. New verdict fired → the prior sharpens immediately. No retrain lag.

### Private — because inference is local and you contribute verdicts, not data
Intelligence runs **locally** over your own data plus a shared index; your data
stays sealed under your key (envelope encryption + the receptor grant, from the
storage plan). You don't ship your data to train someone else's model — you fire
locally and contribute **signed, capability-gated verdicts** to the commons. The
raw stays yours; only *what worked* (attested, not the content) joins the shared
prior.

### Collective — because the ledger is shared memory and the graph is the mind
The ledger is a shared, append-only memory the whole swarm reads and reconstructs
the EBM from. Every agent's terminal verdicts fold into the same reconstructible
prior; the **independent multi-witness corroboration** requirement keeps that prior
honest. No single node is "the model" — the **graph of contracts + the shared
ledger-EBM + the indexed world** is the mind. Intelligence is a property of the
collective, the way a market or a science is.

---

## How the fractal EBM harness specifically helps
- **Fractal keys → multi-scale priors for free.** The *same* atom folds across
  `invoke:{event}`, `:L{layer}`, `:dim:{w6h}`, `:verb:`, `:ptype:`, `:root`. One
  cheap operation yields a coarse-to-fine router — the collective can prioritize
  at every granularity without a separate model per scale.
- **Train-on-fire → the system's own history is the training signal.** Satisfied
  = good, died = retry. No labels, no pipeline, no training run — the substrate
  learns from doing.
- **Ledger-reconstructible weights → the model is the commons, portable and
  auditable.** Anyone can rebuild the prior from the shared ledger; it can be
  forked, inspected, and re-derived. The "weights" *are* the collective
  experience, in the open.
- **Energy-ranked resolution → a thinking-budget allocator.** It routes scarce
  compute / spend to where history says it pays (the plan's Phase 1). This is the
  mechanism by which a low-compute system stays low-compute *as it scales*: it
  spends attention where the energy gradient is steepest.

## The compounding loop (why it could grow toward "smarter than its parts")
- **Parametric AI:** intelligence ∝ params × data × compute — static,
  centralized, and your data trains their model.
- **This:** intelligence ∝ *index coverage* × *collective firing history* ×
  *routing/verification quality* — live, distributed, and your data stays yours.
- As unbrowse indexes more of the world and more agents fire and corroborate, two
  things widen together: the *retrievable context* (what can be brought to bear)
  and the *sharpness of the prior* (what history says works). Each is cheap per
  step and never goes stale. A system whose knowledge and whose judgment both
  compound with use, at near-zero marginal cost, is a genuine candidate for
  exceeding any individual part.

---

## THE HONEST WALL — what must be true, and where this breaks

*(In the substrate's own tradition: state the limits as loudly as the vision, or
it's marketing.)*

1. **The current energy model is shallow — a router prior, not a mind.** A
   cosine-to-one-centroid and a linear `W` are soft priors over "what resolved
   before." Real reasoning is *not* in this model today. The leap from "thin
   router" to "intelligence" is unbuilt, and it comes from one of two places,
   both unproven at this scale: richer *composed* energy models (compute cost
   returns), or *emergent* collective composition (that many thin routers +
   verification compose into reasoning). Do not mistake the scaffold for the
   building.

2. **Retrieval ≠ reasoning.** Indexing the whole internet gives *knowledge
   access*, not thought. Superintelligence needs composition, planning, and
   verification *over* retrieved knowledge. The energy-descent-as-generation
   primitive (`jepa.plan`) is the seed of this, but it's linear and shallow. The
   reasoning layer is the hard, unsolved core.

3. **"Low compute" is low *marginal*, not low *total*.** Embedding and serving
   retrieval over the live web at scale is real, heavy infrastructure. The
   compute *moves* from training to indexing/serving — it does not vanish. The
   honest claim is cheap-per-thought, not cheap-overall.

4. **Verification is the crux, and the single biggest risk.** A collective that
   learns on-fire from verdicts is only as good as its verdicts. Bad or gamed
   verdicts don't just add noise — they *train the shared prior toward
   delusion*. A canonical reference anchor + independent multi-party corroboration
   is the designed guard, and it is load-bearing: if it fails, the
   collective gets confidently, collectively wrong. This is the difference
   between a wisdom-of-crowds and a madness-of-crowds, and it is not automatic.

5. **Query privacy over a shared index is unsolved by encryption-at-rest.**
   Your data-at-rest is private (sealed). But *querying* a shared index can leak
   what you're asking. True query privacy needs PIR / local replicas / ZK — a
   separate, hard problem. "Private" holds for your data; not yet for your
   attention.

6. **"Superintelligence" is a bet, not a result.** Collective systems — markets,
   evolution, science — *do* exceed any participant, so it isn't crazy. But
   whether *this* reaches "super," and not just "useful," is untested and hinges
   entirely on #1, #2, and #4 holding. Claim it as a *falsifiable direction*, not
   a destination.

---

## The falsifiable first step (this is the discipline)
The entire thesis has a smallest testable version, and it's already the plan's
**Phase 1**: does energy-ranked resolution *measurably* beat scan-order at
choosing what fires next? That single question is the atom of "the collective
routes its own thinking." **If the thin version doesn't help, the grand version
won't** — and we'll have learned it for the cost of a benchmark instead of a
cathedral. Prove the atom before believing the collective. Everything above earns
its right to be built one measured gate at a time.
