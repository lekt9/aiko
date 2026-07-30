# 03 · On-chain, privacy & the Solana moat

> Confidential DD dossier. Status tags: **BUILT+PROVEN / DESIGNED / RESEARCH-DIRECTION**.
> Companion to `ECONOMICS-cooperative-commons.md` (the token + reward economics).

## Why on-chain at all

Aiko's energy-based design has one honest cost: **it grows storage as it learns.**
Every action trains a prototype and folds new history; run it long enough on one
laptop and the weights + ledger accrue. The design turns that liability into a
feature by **putting the weights on-chain**:

- **Weights become shareable.** A weight is just content-addressed ledger data
  (`cas.zig` — content-addressed store, dedup-for-free, integrity-checked;
  **BUILT+PROVEN**). Anyone with access can reconstruct the same prior from the
  same rows. You can *call your AI* — hand it to another device, fork it, audit it.
- **Storage cost is offloaded.** The machine holds a **frecency cache** — hot,
  frequently/recently used weights persist locally; cold ones live on-chain and
  are pulled on demand. Store **primarily on-chain**, cache locally what's in
  frequent use. **DESIGNED** (the caching policy; `cache.zig` is the local layer;
  the on-chain tier uses the anchoring path below).
- **Shared data stays cheap.** Content-addressing means a weight referenced by
  many contracts is stored (and paid for) **once** — the dedup is a property of
  the addressing, not a special case. **BUILT+PROVEN** (`cas.zig`).

**Status of full on-chain weight storage: DESIGNED, partially proven.** The
primitives are real — content addressing (`cas`), live Solana reads
(`solana_rpc`, devnet-proven), on-chain hash anchoring (`iq_ledger` on `main`,
anchors claim hashes to a deployed Solana program), and a rent model that bounds
what goes on-chain (≤ ~4 KB on-chain, larger = commitment-only + off-chain). The
end-to-end "weights live on-chain, laptop is a cache" loop is assembled from these
but not yet running in production at scale.

## The Solana moat

The strategic bet is distribution + storage, stated plainly:

> Once the EBM approach is shown to work, frontier labs *will* copy it — it's
> proprietary tech, but it's copyable. **The moat is not the algorithm; it's the
> ledger.** No one in AI has a distributed ledger the size of Solana. A ledger
> that can hold all the weights in the world — and a distribution channel already
> in millions of wallets — is the durable asset. Win the distribution and the
> storage substrate before the technology is commoditized.

And the economics close on themselves: **increased Solana transaction volume
means the product pays for itself.** Every weight write, every attestation, every
settlement is on-chain activity; as usage grows, the on-chain volume it generates
funds the substrate it runs on. (The full reward economics — usage fees paid out
to stakers in USDC, FDRY as the security stake, reward-not-slash — are in
`ECONOMICS-cooperative-commons.md`, **BUILT+PROVEN locally**, with the real
mainnet FDRY vault integration in `voltr.zig`, **BUILT+PROVEN**.)

**Honest status of the moat:** this is a *go-to-market and defensibility thesis*,
not a technical lock-in that exists today. Solana gives distribution + cheap
durable storage; it does not by itself prevent a well-funded lab from building the
same harness on their own infrastructure. The moat compounds only if Aiko wins the
network (the commons of shared, corroborated weights) first. See
`05-RISK-honest-wall.md`.

## Privacy — what holds, and what is a bet

The pillar is *"your information stays yours,"* and it decomposes into three
distinct claims with three different maturities. Diligence should not conflate
them:

1. **Local inference + sealed data — BUILT/DESIGNED.** Inference runs *on your
   machine* over your own data plus a shared index. You don't ship your data to
   train someone else's model; you fire locally and contribute **signed,
   capability-gated verdicts** — attestations of *what worked*, not the content.
   Your data at rest is sealed under your key (envelope encryption + the
   **receptor grant** access boundary — `capability.zig`'s opt-in receptor is
   **BUILT+PROVEN**: value is adopted only under a signed grant, measured at 100%
   cross-lineage enforcement).

2. **Zero-knowledge credential binding — RESEARCH-DIRECTION (not built).** The
   pitch says "ZK-proof credential binding creates privacy you can verify." Be
   precise for diligence: **there is no production zero-knowledge system today.**
   The current on-chain identity/attestation layer uses hash commitments and
   signed lineage, *not* a ZK proof system. Real ZK credential binding (e.g.
   Pedersen/Ristretto commitments + Schnorr + KVAC, avoiding SNARK trusted setup)
   is designed on paper and is the intended path — but it is unbuilt. Treat "ZK"
   as a **direction**, not a shipped feature.

3. **Query privacy over a shared index — UNSOLVED.** Your data *at rest* is
   private. But *querying* a shared index can leak what you're asking. True query
   privacy needs PIR / local replicas / ZK — a separate, hard problem, not solved
   by encryption-at-rest. **"Private" holds for your data; not yet for your
   attention.** (Stated identically in the foundation THESIS — this is not new
   caution, it's the standing honest wall.)

## The one-line summary for diligence

On-chain is **real in its primitives** (content-addressing, live reads,
anchoring, a real FDRY vault, the reward loop) and **a designed system** at the
"weights fully live on-chain, laptop is a frecency cache" level. Privacy is
**real for data-at-rest**, **a direction for ZK**, and **an open problem for query
privacy**. The moat is a **distribution/storage thesis**, compelling but not a
technical lock-in yet. Everything here is labelled so the seams are visible.
