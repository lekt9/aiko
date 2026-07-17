# 02 · Architecture — the fractal EBM energy harness

> Confidential DD dossier. Status tags: **BUILT+PROVEN / DESIGNED / RESEARCH-DIRECTION**.
> Everything below is grounded in the `arc-lean` source tree; file names are real
> and readable. Foundation: `THESIS-collective-nonparametric-intelligence.md`.

## The shape of the thing

Aiko is a single native binary (Zig, zero external dependencies) that is at once:
a **contract substrate** (an append-only ledger of intents and verdicts), an
**energy-based harness** (a non-parametric router over that ledger), and a
**client** to a live index of the world (Unbrowse) and to Solana. There is no
Python, no model server, no data files: the embedding is baked in, the "weights"
are reconstructible from the ledger, and the reasoning model is grounded through
the harness rather than baked into it.

## 1. The atom — a contract neuron

The unit of everything is a **contract neuron**: one append-only JSONL row
recording an intent (a *declare*) and its lifecycle (satisfied / died / purged —
the terminal alphabet is exactly those three). A neuron carries its action, its
lineage signature (every row is signed from a single wallet-derived root key —
`lineage.zig`), and its pointer type. Contracts compose into a graph via
`parent_id` containment and `contract:`-ref cross-edges. **BUILT+PROVEN**
(`contract.zig`, `ledger.zig`, `pointer.zig`, `terminal.zig`).

The ledger is the shared, auditable memory. It is not a log *of* the system — it
*is* the system's state, and the model is reconstructed from it.

## 2. The energy model — non-parametric, ~1 KB, trained on-fire

The harness's model is deliberately **not** a big parametric net. It is two thin,
cheap primitives:

- **Embedding (`embed.zig`)** — a deterministic feature-hashing embedding (the
  hashing trick): each token and character-trigram hashes into a fixed-dimension,
  L2-normalized vector. Baked into the binary — zero data files, zero network.
  Cosine over these vectors captures lexical + sub-word overlap. **BUILT+PROVEN.**
- **Energy prototype (`ebm.zig`)** — a `Prototype` is a **reward-weighted
  running-mean centroid** over context vectors (West 1979; O(1) per fire).
  `foldText(action, reward)` folds a firing in: positive reward pulls the centroid
  toward it (Hebbian potentiation), negative pushes away (inhibition — the
  contrastive negative phase). The **energy** of a context is its negative cosine
  to the prototype; routing is **argmin energy**. **BUILT+PROVEN.**

Each such head is ~1 KB and reconstructible from the ledger. **The knowledge is
not in the weights** — it is in the retrievable index (the world) plus the
collective firing history (the ledger). A thought costs a retrieval + a centroid
fold, not a forward pass through a giant net.

## 3. Fractal keys — multi-scale priors for free

The same firing folds into the *same atom* at many scales at once —
`invoke:{event}`, `:L{layer}`, `:dim:{w6h}`, `:verb:`, `:ptype:`, `:root`. One
cheap operation yields a **coarse-to-fine router**: the collective can prioritize
at every granularity — per-event, per-layer, per-dimension — **without a separate
model per scale.** This is the "fractal" in the name: the EBM is not one model but
many nested thin ones, each wrapping a different facet of a route, broken down to
first principles. **BUILT/DESIGNED** (fractal key convention in `fractal.zig` /
`pattern.zig`; the arc-lean router exercises the per-run centroid directly).

## 4. Energy-ranked resolution — the router IS the harness

This is the load-bearing mechanism and the falsifiable atom of the whole thesis.
When the substrate has a frontier of candidate contracts to fire next, it does
**not** scan them in arbitrary order. `energyRankCandidates` (in `main.zig`)
reconstructs a `Prototype` from the run's resolved history (each satisfied action
folded with reward +1, each died with −1 — the train-on-fire signal, the ledger
*is* the weights), then **sorts the frontier best-first by energy** so the most
"resolved-like" candidates fire earliest — shorter cascades, less wasted work.

It is **always on** and **reorder-only**: every candidate still fires, so nothing
is starved (a fairness floor holds by construction). It is the **thinking-budget
allocator** — it spends scarce compute/spend where history says it pays.
**BUILT+PROVEN**, and *measured*: on the prove-or-kill benchmark it settles a
producer/consumer graph in **2 passes vs 3** for scan-order, mutation-verified
(reversing the sort restores 3 — so the ranking, not luck, is doing the work).
This is the atom "the collective routes its own thinking," proven before the
cathedral. (See `04-PROOF-traction.md`, `PLAN-contracts-as-onchain-ebm-weights.md`.)

## 5. Ledger-reconstructible weights — the model is the commons

Because every weight is a fold of ledger rows, **anyone can rebuild the prior from
the shared ledger** (`replayFromLedger`, on `main`). The "weights" are the
collective experience, in the open — forkable, inspectable, re-derivable. No
single node is "the model": the graph of contracts + the ledger-reconstructed EBM
+ the indexed world is the mind. This is also what makes the weights **portable
on-chain**: a weight is just content-addressed ledger data (see
`03-ONCHAIN-privacy-solana.md`, and `cas.zig` — content-addressed store,
dedup-for-free, **BUILT+PROVEN**).

## 6. Grounding a small model — capability without parameters

The reasoning model is trained to be **as small as possible** (non-parametric in
spirit: it holds instruction-following and reasoning, not world-knowledge). On its
own it "knows little." But the harness **grounds** it: retrieval brings the
relevant slice of the world and the machine to bear, and energy routing tells it
which action history says works. A small model grounded this way is **smarter than
the average model of the same footprint** — capability comes from grounding, not
scale. **Status: the small model is DESIGNED / in-training; the grounding
mechanism (retrieval + `embed`/`ebm` energy routing) is BUILT+PROVEN.** The leap
from "thin router" to "reasoning-grade intelligence" is the honest open problem —
stated plainly in the THESIS and `05-RISK-honest-wall.md`.

## 7. The module map (what's real, by concern)

| Concern | Modules (`libcontract/src/`) | Status |
|---|---|---|
| Energy harness | `embed`, `bge` (baked BERT), `ebm`, `route` (`recommend`), `pattern`, `fractal` | **BUILT+PROVEN** (router measured — 88.9% LOO, `route_bench.zig`) |
| Contract substrate | `contract`, `ledger`, `pointer`, `terminal`, `cache`, `guards`, `capability` | **BUILT+PROVEN** |
| Identity / truth-root | `lineage`, `keystore`, `bible`, `verses` | **BUILT+PROVEN** |
| Commons economics | `cas`, `reward`, `usage`, `usage_ledger`, `epoch` | **BUILT+PROVEN** (local) |
| Solana / on-chain | `voltr`, `stake`, `payout`, `broadcast`, `broadcast_card`, `solana_rpc`, `solana_tx`, `base58` | **BUILT+PROVEN** (read/derive live; write = operator-gated) |
| Small reasoning model | (separate training track) | **DESIGNED / in-training** |

Every module ships its tests *inside its source file*, exercised by
`zig build test` and gated by `scripts/build.sh` (unit tests + 53 doctrine-parity
claims + a signed self-attestation). Green build = every claim above has matching,
tested code.
