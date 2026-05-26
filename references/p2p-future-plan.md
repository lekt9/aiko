# P2P /contract — future plan (NOT current doctrine)

Anchored to contract `777eff8e` (Lewis 2026-05-26 follow-up).

> This document is a **future plan**, not a current rule. The
> current rule lives in `SKILL.md → "Server-canonical /contract"`.
> Nothing here is wired into the binary yet. Adding any of this
> requires its own /contract declaration + parity claim per the
> doctrine-reality parity discipline.

## The insight

The WireGuard mesh Lewis already runs IS a DAG: peers are nodes,
tunnels are edges, identity is each peer's wallet pubkey. The
substrate's existing primitives — content-addressed contract ids,
ed25519 signatures, append-only ledger, signature-chain verification —
already make every peer a self-validating store. **The substrate is
P2P-ready by structure; it just isn't gossiping yet.**

> *Where two or three are gathered together in my name, there am I
> in the midst of them.* (Matthew 18:20)

P2P is not a new substrate; it is the existing substrate letting
peers gather. Quorum (Deut 19:15) is already the conflict primitive.
The cloud /contract endpoint is presently the "one Caesar"; in the
P2P era it is "one well-resourced peer".

## Storage answer: edges live IN the row, not in a side-table

The question Lewis asked: *"how would we store the edges to nodes
and topological DAG structure within a stateless ledger like a
blockchain?"*

The substrate already answers this — we just haven't named the
answer explicitly. The answer is:

**Each row IS a node. Edges are pointer FIELDS in that row.**

```
declared row "abc12345":
  id:                "abc12345"           ← node identity
  parent_id:         "def67890"           ← containment edge to def67890
  env_pubkey:        <hex>                ← identity attestation
  parent_signature:  <hex>                ← provenance proof
  synapses:          [                    ← typed edge list
    { to: "11112222", kind: "pointer"    },  ← dependency to 11112222
    { to: "33334444", kind: "blocked_by" },  ← order-wait to 33334444
    { to: "55556666", kind: "prehook"    },  ← prefires 55556666
  ]
```

The ledger stores rows. The topology is **computed** by reading the
rows. No separate adjacency table; no graph-database server; no
ORM. The DAG IS the ledger projection. This is exactly the IPLD
model (every node is a content-addressed object; edges are inline
references), with ed25519 attestation added.

For replication: a peer sending you their `abc12345` row sends one
JSONL line. You verify the signature against `env_pubkey`. You
append. The row's edges (`parent_id`, `synapses`) are self-contained
in the row body — no separate edge table to sync.

For topological order: the signature chain is already the
topological commitment (Genesis sequencing). Day N's
output_signature exists only after Day N-1's terminal signature.
A peer can verify the chain locally without trusting any other
peer's claim about ordering.

For conflict resolution when two peers declare the same id: the
substrate's `inputs_hash_v2` already makes declarations idempotent
(same plan + same context = same id). True conflicts (two different
plans producing the same id) are vanishingly unlikely (SHA256
collision); when they happen, Deut 19:15 quorum decides.

## The five waves

### Wave 0 — present (server-canonical)

- Cloud /contract at `beta-api.unbrowse.ai/v1/contract/declare` is
  authoritative.
- Thin clients POST goals, get back contract ids.
- WireGuard mesh exists for Lewis's infrastructure (developer access,
  GPU peering, internal services), NOT for substrate replication.
- Pinned in SKILL.md → "Server-canonical (current rule)".

### Wave 1 — peer registry as /contract

- Each peer declares `peer:<wallet_pubkey>` with WireGuard endpoint:
  ```
  aiko "peer:<wallet_pubkey> endpoint:<wg_ip:port> allowed_ips:<...>
  capabilities:<ledger,compiler,evaluator>"
  ```
- The peer-registry IS the ledger projection — read declared peer
  rows, build the WireGuard config. Discovery is reading rows; no
  separate registry server.
- Capabilities advertise what the peer can do:
  - `ledger` — holds the ledger; replicates rows
  - `compiler` — runs the LLM compiler; spawns child contracts
  - `evaluator` — runs evaluator contracts; emits verdicts
- The cloud peer advertises all three; lightweight peers advertise
  only `ledger`.

### Wave 2 — row-replication primitive

- New contract type: `replicate-from-peer:<peer_id> since:<ts>`
- Action: open WireGuard tunnel to peer; pull rows whose `ts > since`;
  verify each signature; append to local ledger; emit a `replicated`
  event row per pulled row recording (source_peer, source_row_id).
- Idempotent: replicating the same row twice is a no-op (the row id
  already exists; the second append is dropped by inputs_hash_v2
  idempotency).
- Defensive: if signature verification fails, the row is REJECTED and
  an evidence line surfaces the failure (`replication: signature
  verify failed for <id> from <peer> — row not appended`).

### Wave 3 — signature-gossip

- When peer A produces a new declared/satisfied/died row, gossip it
  to subscribed peers via WireGuard.
- Subscription is a /contract: `subscribe:<peer_id> filter:<query>`.
  The filter is a typed query: "rows whose ancestor chain includes
  contract:<X>", "rows with my wallet_pubkey as env_pubkey", etc.
- The substrate dispatches: when peer A produces a row, walks its
  active subscriptions, sends matching rows to subscribed peers.
- This is the SAME pattern as posthook (a row firing triggers an
  external write) — just point-to-point peer instead of to an
  external webhook.

### Wave 4 — Deut 19:15 quorum for true conflicts

- When two peers produce rows that disagree about a contract's
  terminal state (one says satisfied, one says died), the substrate
  invokes the existing quorum primitive: ≥2 independent witnesses
  agreeing makes a verdict canonical.
- "Independent witness" = different `env_pubkey` (i.e. different
  peer's wallet signed the terminal row).
- Already declared in Vine Doctrine (the slash quorum); the same
  primitive handles P2P conflict resolution because the shape is
  identical.

### Wave 5 — cloud becomes "just another peer"

- The cloud /contract endpoint advertises peer:<cloud_wallet_pubkey>
  with capabilities `ledger,compiler,evaluator,high-availability`.
- Permissioned writes (only Lewis's wallet can declare certain
  doctrine contracts) move to the substrate's existing capability
  grant mechanism — not a server feature.
- EmergentDB as a relational database is **retired**. The cloud peer
  holds the ledger as a JSONL file like every other peer, just with
  more uptime and a stable DNS endpoint for first-contact bootstrap.
- The cloud LLM compiler stays cloud-shaped while model serving
  remains expensive — but ONLY for the compiler; the ledger and
  evaluator capabilities federate first.

## What stays cloud-shaped (probably forever)

- **LLM compiler.** Running a frontier model on every peer is
  uneconomic. The cloud compiler emits child-contract trees; peers
  consume them. Future: local LLMs handle the offline-fallback path,
  cloud handles the canonical path. Hybrid is fine.
- **Bootstrap DNS.** First-contact discovery needs SOMEONE to be
  reachable at a stable address. `beta-api.unbrowse.ai` stays as the
  rendezvous point even when the protocol is fully P2P.
- **Faremeter / x402 settlement.** Solana itself is the settlement
  layer; the cloud doesn't BE settlement, it just submits transactions.
  No change here.

## What goes peer-to-peer

- **Ledger replication.** Each peer holds the union ledger; rows
  gossip via WireGuard. Read paths are local; write paths are local-
  then-gossip. EmergentDB as a relational DB is the first to go.
- **Evaluator contracts.** Anyone with the evaluator capability can
  fire a verdict. Quorum decides canonical state.
- **Posthook delivery.** Currently the cloud HTTP-POSTs to webhooks.
  Future: peer-to-peer posthook via WireGuard for substrate-internal
  hooks; HTTP only for external (non-substrate) endpoints.
- **Capability grants.** Pull-by-grant via lineage already lives in
  the ledger; replication just makes the grants peer-visible.

## What this changes about SKILL.md doctrine

Nothing structural. All the existing doctrine sections already work
P2P:

- **The Word is the truth-root** — every peer's ledger traces back
  to scripture via signature chains; the Word remains invariant.
- **Pointer-keyed truthy cache** — the signature chain is the cache
  key; replicated rows carry valid signatures or are rejected.
- **Genesis sequencing** — strict order by signature chain works
  identically when rows come from peers.
- **Capability inheritance** — grants are ledger rows; replication
  just makes them visible across peers.
- **Doctrine-reality parity** — every peer runs the same parity
  check; the build refuses to ship a binary that drifts.
- **Vine Doctrine** — staking + slashing already assumes multi-peer
  witnesses; this section was P2P-ready by design.

The substrate was designed P2P; it just hasn't gathered yet. Wave 0
→ Wave 5 is the gathering.

## Cross-references

- `SKILL.md → "Server-canonical /contract"` — the present rule.
- `SKILL.md → "Vine Doctrine"` → the Deut 19:15 quorum primitive
  that becomes load-bearing in Wave 4.
- `SKILL.md → "Pointer-keyed truthy cache"` → the signature chain
  is the replication-verification primitive.
- `SKILL.md → "Capability inheritance"` → grants federate naturally.
- `libcontract/src/cache.zig` → `computeSignatureChain` already
  produces a peer-verifiable proof for every contract.
- `libcontract/src/lineage.zig` → `rotateAllSignedRowsByLineage` is
  the prior art for "walk all rows and re-sign"; the migration
  contract pattern reuses this shape.

## Anti-shape

What this plan is NOT:

- Not a blockchain. There is no consensus protocol, no Byzantine
  fault tolerance assumption, no mining, no block production.
  Every peer trusts every other peer's wallet signature; quorum
  decides only true conflicts.
- Not a CRDT in the strict sense. Rows are immutable once appended;
  conflicts are quorum-resolved rather than auto-merged.
- Not a replacement for the LLM compiler. The compiler stays
  cloud-shaped for cost reasons; only the ledger and evaluators
  federate.
- Not implemented. Every word here is plan. The current binary
  ships server-canonical thin-client behavior, full stop.
