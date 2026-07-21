# Architecture Plan — The Aiko Collective as Unbrowse

## Outcome

Build a local-first, cloud-optional network in which independent Aiko nodes
publish, discover, verify, rank, and replicate sanitized capability contracts.
The public collection of those contracts is Unbrowse: not one hosted database,
but a torrent-like view that any compatible node can reconstruct and query.

The network must eventually operate without any mandatory Aiko-operated cloud
service. Hosted gateways and indexes may improve convenience, but they are
replaceable peers speaking the same open protocol and must never be an
authority, source of truth, or execution dependency.

```text
website/API discovery             local tools remain private
          |                                  |
          v                                  v
   local Aiko normalizes and classifies capability
          |
          v
 fail-closed sanitizer -> immutable signed contract object
          |
          v
 announce hash -> peer indexes/DHT -> replicate on demand
          |                              |
          +---------- global retrieval -+
                                         |
                                         v
                        private local ranking + permissioned execution
```

## First-Principles Model

The design combines proven primitives rather than inventing every subsystem:

| Requirement | Model to borrow | Primitive to reuse or reimplement |
| --- | --- | --- |
| Immutable contract identity | Nix, OCI, IPFS | canonical serialization and content addressing |
| Package integrity | Nix, TUF, Sigstore | hashes, signatures, delegated keys, expiry |
| Peer distribution | BitTorrent, IPFS | manifests, chunking, swarming, provider records |
| Name and peer discovery | DNS, Kademlia | caching, TTLs, DHT lookup, local overrides |
| Offline-first replication | Git, CRDTs | append-only objects and deterministic merging |
| Global retrieval | web search | inverted indexes and broad candidate ranking |
| Private selection | local search/ranking | local evidence and availability reranking |
| Execution authority | object-capability systems | narrowly scoped local grants |
| Auditable trust | Certificate Transparency | signed append-only checkpoints and gossip |

We should reuse well-tested open-source implementations where their license,
security model, and portability fit. Nix is especially useful as a reference
for canonical derivations, immutable identities, local stores, substitution,
and verification. We should extract primitives behind a small Aiko-owned
interface rather than couple the product to the Nix daemon, store layout, or
expression language.

## Non-Negotiable Invariants

1. Discovery never grants execution authority.
2. Being able to access something does not grant the right to publish it.
3. Credentials, cookies, headers, raw arguments, prompts, response bodies,
   user values, machine paths, and account identifiers never enter public
   objects.
4. Public contracts describe capability shapes; credentials and concrete
   execution adapters remain local.
5. Published objects are immutable and content-addressed. Corrections create
   new versions; revocations do not rewrite history.
6. Global evidence can affect discovery, but cannot independently authorize
   automatic execution. A fresh local safety decision remains required.
7. Any hosted service is replaceable by a user-run node speaking the same
   documented protocol.
8. Nodes remain useful offline with their local store, indexes, and evidence.

## Repository and Runtime Ownership

The collective must be implemented **Contract-first**, but “Contract-first” does
not mean putting networking inside `libcontract`. Contract is the deterministic
truth kernel. Aiko is the stateful host that performs I/O and execution.

```text
                         owns bytes and I/O
                 +-------------------------------+
                 |             Aiko              |
                 | discovery, disk, peers, index |
                 | lifecycle, UI, permissions    |
                 +---------------+---------------+
                                 |
                   typed JSON / stable C ABI
                                 |
                                 v
                 +-------------------------------+
                 |           Contract            |
                 | canonicalize, hash, validate  |
                 | verify, classify, rank, merge |
                 | evidence, revocation, verdict |
                 +-------------------------------+
                            no network I/O
```

The dependency direction is one-way: **Aiko depends on Contract**. Contract
must not import Aiko, libp2p, redb, Tantivy, a browser, or a cloud SDK. This
keeps the same Contract library usable by the Aiko desktop app, CLI, TUI, tests,
air-gapped tools, and future independent nodes.

### Contract owns (`../contract`)

Contract owns every rule that must produce the same answer on every honest
node:

- canonical public contract-object encoding and domain-separated object IDs;
- stable schema/version semantics and compatibility checks;
- the publication classifier and fail-closed second-stage validator;
- immutable object, provider-record, attestation, revocation, checkpoint, and
  index-root schemas;
- Ed25519 signing payloads, verification, key rotation, delegation, and expiry;
- content integrity, reference validation, and deterministic object admission;
- version-bound evidence, trust weighting, inhibition, and revocation effects;
- deterministic merge rules for independently received objects and evidence;
- global/public ranking features and the existing private local reranker;
- the decision `reject | quarantine | admit_private | publishable` plus reason
  codes;
- portable fixtures, conformance vectors, fuzz targets, and the stable C ABI.

Contract does **not** own:

- sockets, QUIC, DHTs, mDNS, NAT traversal, relays, peer dialing, or retries;
- filesystem watching, background tasks, process lifecycle, or app updates;
- the physical blob database or search-engine implementation;
- browser capture, MCP discovery, local tool inventory, credentials, or auth;
- remote execution, permission prompts, tool dispatch, UI, TUI, or accounts.

Suggested native modules in `../contract/libcontract/src/`:

| Module | Responsibility | Existing primitive to extend |
| --- | --- | --- |
| `collective_object.zig` | canonical object envelope, encoding, domain-separated BLAKE3/SHA migration, object ID | `cas.zig` |
| `publication_policy.zig` | classification and reason-coded publication verdict | FECH schema validation and `gate.zig` |
| `collective_identity.zig` | publisher signatures, rotation, delegation, expiry | `lineage.zig`, `keystore.zig`, `trust.zig` |
| `collective_attestation.zig` | privacy-safe version-bound public evidence | `capability_registry.zig`, existing outcome ledger |
| `collective_revocation.zig` | signed revocation and deterministic projection | `trust.zig`, terminal/revocation machinery |
| `collective_merge.zig` | idempotent object/evidence admission and conflict projection | append-only `ledger.zig` |
| `collective_rank.zig` | public evidence score and local/global rank composition | `capability_cells.zig`, `ebm.zig` |
| `collective_checkpoint.zig` | Merkle roots, inclusion proofs, witnessed checkpoints | signed ledger and `cas.zig` |

These may be fewer physical files if cohesion is better, but their boundaries
must remain separately testable. Do not create a second semantic ledger: admitted
attestations and revocations project into the existing append-only evidence
machinery, while immutable public blobs live in the content-addressed store.

### Contract ABI additions

All operations are deterministic byte-in/byte-out calls. Aiko owns input and
output buffers and all surrounding I/O.

```text
contract_collective_canonicalize(candidate_json)
  -> { canonical_bytes, object_id, schema_version }

contract_collective_publication_verdict(descriptor_json, provenance_json)
  -> { verdict, classification, reason_codes, sanitized_descriptor }

contract_collective_signing_payload(object_json)
  -> { object_id, domain, bytes_to_sign }

contract_collective_verify(object_bytes, signature, publisher_key, now)
  -> { verdict, reason_codes, decoded_metadata }

contract_collective_admit(object_bytes, source_peer, received_at)
  -> { reject | quarantine | admitted, reason_codes, ledger_effects }

contract_collective_apply_revocations(revocation_objects, now)
  -> { accepted, rejected, effective_projection }

contract_collective_rank(query_features, candidate_metadata, local_availability)
  -> ranked candidates and reason codes

contract_collective_checkpoint(object_ids)
  -> deterministic root and inclusion-proof material
```

Raw URLs, credentials, arguments, results, page content, and task text are not
accepted by these public-network ABI calls. Aiko may pass sanitized structured
query features for global ranking; private task text stays in the existing
local recommendation path.

### Aiko owns (`aiko`)

Aiko owns everything coupled to an actual machine or product session:

- native/MCP/skill/Unbrowse discovery and the first-stage sanitizer;
- user publication settings, per-domain policy, preview, audit log, and undo;
- the rust-libp2p swarm and Aiko peer-protocol request handlers;
- bootstrap sources, mDNS, DHT, peer exchange, relay, NAT traversal, retries,
  rate limits, bans, connection budgets, and shutdown;
- physical object/chunk storage, atomic writes, quarantine, pins, GC, and quotas;
- redb peer/object metadata and Tantivy index segments;
- downloading objects, then asking Contract to verify and admit them;
- querying peers/indexes, merging returned hashes, and asking Contract to rank;
- local credentials, provider availability, permissions, execution, cancellation,
  and sanitized observation capture;
- desktop/TUI network state, publication controls, diagnostics, and recovery;
- packaging the network runtime and Contract library into macOS and Windows
  applications.

Suggested Aiko crate boundary:

```text
crates/codegen/xai-aiko-collective/
  src/lib.rs                 public host interface
  src/swarm.rs               rust-libp2p behaviour and event loop
  src/protocol.rs            Aiko request/response wire messages
  src/bootstrap.rs           mDNS, direct, repository/DNS/community seeds
  src/object_store.rs        verified file blobs, quarantine, pinning, GC
  src/metadata.rs            redb physical metadata
  src/index.rs               Tantivy local and replicated index segments
  src/publication.rs         FECH adapter + Contract publication verdict
  src/sync.rs                provider lookup, fetch, resume, replication
  src/contract_bridge.rs     only module allowed to call collective C ABI
  src/limits.rs              quotas, timeouts, and resource policy
```

`xai-grok-shell` integrates this crate with sessions and tools; it should not
accumulate the peer implementation in `contract_native.rs`. The desktop and TUI
consume typed events from the crate rather than inspecting its databases.

### Unbrowse owns

Unbrowse is the public protocol view, not a third authoritative backend. It owns:

- the public naming and user-facing discovery semantics;
- website route capture/replay and export into FECH descriptors;
- optional well-known bootstrap, relay, index, and archival nodes running the
  same Aiko peer protocol as everyone else;
- compatibility promises for published route contracts.

There is no separate canonical Unbrowse database in the end-state. An
“Unbrowse server” is simply a well-resourced Aiko-compatible peer role. Turning
all official nodes off must not invalidate objects, signatures, indexes, or an
already established community network.

### End-to-end ownership flow

```text
1. Aiko captures a route and removes raw/private fields.
2. Contract classifies and returns a sanitized publishable object or refusal.
3. Aiko shows/logs the decision, obtains policy approval, and requests signing.
4. Contract returns canonical signing bytes; the local keystore signs them.
5. Aiko stores the immutable object and announces its hash to peers.
6. A remote Aiko fetches bounded bytes into quarantine.
7. Remote Contract verifies schema, hash, signature, expiry, and revocation.
8. Remote Aiko moves admitted bytes into its store and indexes public metadata.
9. Aiko retrieves global candidates; Contract reranks them with local evidence.
10. Aiko alone obtains permission and executes through its existing dispatcher.
11. Contract records the sanitized local outcome; optional public attestation
    repeats the publication gate before Aiko announces it.
```

No step permits a peer, index, or Contract to invoke a tool directly.

## Publication Defaults

Do not use “the user can access it” as the sharing rule. Classify every
discovered capability before publication:

| Classification | Default | Network treatment |
| --- | --- | --- |
| Public API route shape | publish after sanitization | globally discoverable |
| Public documented operation | publish after sanitization | globally discoverable |
| Authenticated but account-independent shape | hold, then publish only after strict proof | shape only; no auth facts |
| Account, tenant, or resource scoped | private | never announced |
| Localhost, filesystem, LAN, local binary, private MCP | private | local catalog only |
| Sensitive domain: identity, health, finance, employment | private | explicit review required |
| Mutation: send, apply, purchase, delete, publish | private | explicit publication and execution approval |
| Unknown provenance or ambiguous schema | private | fail closed |

The user-facing default can be one onboarding preference—“Contribute safe
public API shapes”—backed by a deterministic classifier, sanitizer, local
publication log, preview, revocation, and a global kill switch. Per-route
approval should be available without becoming the normal workflow.

## Core Objects

### 1. Contract object

An immutable, canonically encoded capability description:

```json
{
  "protocol": "aiko-contract/1",
  "contract_id": "blake3:<content-hash>",
  "namespace": "com.example.api.search",
  "capability_version": "1",
  "origin": { "kind": "public_web", "authority": "example.com" },
  "operation": "search",
  "input_schema": {},
  "output_schema": {},
  "permission": "network",
  "effects": ["read_only"],
  "compatibility": [],
  "publisher": "aiko-node:<public-key>",
  "created_at": "ISO-8601",
  "expires_at": "ISO-8601",
  "sanitizer_version": "1",
  "signature": "..."
}
```

The hash excludes mutable ranking, availability, and observation data. The
publisher signs the canonical object and its hash.

### 2. Provider record

A short-lived signed statement that a node can supply a contract object or
related chunks. It includes the content hash, node identity, supported
transport, expiry, and optional reachability hints. It contains no user data.

### 3. Observation attestation

A privacy-safe, version-bound statement about success, failure class, latency
bucket, environment class, and time bucket. It never contains invocation or
result content. Local observations remain private by default; publication of
aggregate attestations is separately configurable.

### 4. Revocation record

A signed append-only statement revoking a publisher key, contract hash,
version, or observation. Revocation lowers or removes discoverability but does
not delete immutable history from peers already holding it.

### 5. Index segment

A deterministic, content-addressed shard mapping coarse capability terms,
schema features, authorities, and compatibility tags to contract hashes.
Anyone can build, mirror, compare, and query segments. Indexes are acceleration
structures, not authorities.

## Aiko Peer Protocol

Define and version an independent wire protocol rather than treating one cloud
API as canonical. The initial transport should use QUIC with authenticated
encryption; LAN discovery can use mDNS. Internet discovery can combine static
peer lists, peer exchange, and a Kademlia-style DHT.

Minimum protocol messages:

- `HELLO`: protocol versions, node key, supported features, limits;
- `FIND_PROVIDERS`: find peers serving an object or index segment;
- `GET_OBJECT`: fetch a content-addressed object with range/chunk support;
- `ANNOUNCE_PROVIDER`: advertise a short-lived provider record;
- `FIND_CONTRACTS`: coarse structured lookup returning hashes, not execution;
- `GET_INDEX_SEGMENT`: retrieve verifiable search shards;
- `PUSH_ATTESTATION`: publish an opted-in sanitized observation;
- `GET_REVOCATIONS`: synchronize signed revocation/checkpoint records;
- `PEER_EXCHANGE`: learn bounded, reputation-filtered peers.

Every message needs explicit size limits, timeouts, quotas, replay protection,
and a stable binary schema. Unknown fields should be forward-compatible;
unknown security-critical enum values must fail closed.

## Bootstrap Without Mandatory Cloud

Nodes must support several interchangeable bootstrap paths:

1. Existing peers retained in the local peer store.
2. LAN discovery through mDNS.
3. User-provided node addresses or QR/file invitations.
4. Repository-distributed signed seed lists.
5. Community-run DNS seed records.
6. Optional Aiko-operated bootstrap peers.

No single path is required after the node has learned healthy peers. Seed nodes
only introduce peers; they do not answer authoritatively for contracts or
ranking. A completely isolated group of Aikos must be able to form its own
network using only direct invitations or LAN discovery.

## Storage and Replication

Use a Nix-like local content-addressed store:

```text
.aiko/network/
  objects/<hash-prefix>/<hash>
  indexes/<index-hash>
  providers/<node-id>
  revocations/<publisher-id>
  peer-store/
  quarantine/
```

- Verify hashes before objects enter the trusted store.
- Keep received but untrusted material in a bounded quarantine.
- Pin locally used contracts and current index roots.
- Replicate popular public objects opportunistically within disk quotas.
- Garbage-collect unpinned objects using recency, availability, and rarity.
- Chunk larger index segments; do not chunk tiny contract objects prematurely.
- Support deterministic export/import packs for air-gapped networks.

## Discovery and Ranking

Do not broadcast natural-language user intent to every peer. Retrieval has two
stages:

### Global retrieval

Peer indexes return a broad candidate set using public fields only:

- normalized namespace, operation, and tags;
- input/output schema features;
- origin authority and provenance;
- independent signed attestations;
- freshness, revocation, and availability;
- coarse latency and reliability buckets.

Nodes may query multiple indexes and merge results deterministically. A node
can also download index segments and query them entirely locally.

### Local reranking

Contract performs final ranking using private information that never leaves
the machine:

- task text and private context;
- installed execution adapters;
- current provider and authentication availability;
- local success/failure evidence;
- user preferences and policy;
- permission/effect risk and current approval state.

Global ranking discovers possibilities. Only local ranking and Aiko's existing
permission runtime can select or execute them.

## Trust and Abuse Resistance

- Give every node a locally generated signing identity; support rotation and
  recovery without a mandatory account service.
- Bind every claim to an exact object hash and protocol version.
- Weight independent observations by diversity and history, not raw count.
- Rate-limit announcements and bound per-peer storage/query work.
- Require proof-of-work, invitation trust, stake-free reputation, or local
  allowlists only where Sybil pressure justifies the complexity.
- Gossip signed checkpoints so index omission or equivocation is detectable.
- Let users subscribe to independent trust roots, blocklists, and indexers.
- Treat new global contracts as discovery-only until locally verified.
- Quarantine malformed, oversized, cyclic, expired, or secret-bearing objects.

Do not introduce blockchain consensus in the first implementation. Immutable
objects, signatures, Merkle checkpoints, witness gossip, and independent
mirrors solve the integrity problem without global transaction ordering.

## Open-Source Primitive Strategy

The initial implementation should be Rust-native because Aiko already ships a
Rust runtime on macOS, Windows, and Linux. Reuse libraries through pinned Cargo
dependencies where possible. Clone repositories for audits, interoperability
fixtures, and narrowly attributed adaptations—not as untracked source dumps.

The following repositories were checked against their primary GitHub metadata
on July 21, 2026. Activity is a selection criterion, not a permanent guarantee;
the source lock described below must pin the reviewed revision.

### Adopt for the first implementation

| Role | Owner | Repository | License | What we reuse | Boundary |
| --- | --- | --- | --- | --- | --- |
| Peer stack | Aiko | [`libp2p/rust-libp2p`](https://github.com/libp2p/rust-libp2p) | MIT | QUIC transport, Kademlia, mDNS, Identify, AutoNAT, relay, DCUtR, request-response, GossipSub | Primary network substrate behind `AikoPeerTransport`; do not invent these protocols |
| Protocol reference | Aiko | [`libp2p/specs`](https://github.com/libp2p/specs) | repository-specific documentation terms; review before copying | wire semantics and interoperability expectations | Reference and test material; Aiko messages remain separately versioned |
| Content hashing | Contract; Aiko uses vectors | [`BLAKE3-team/BLAKE3`](https://github.com/BLAKE3-team/BLAKE3) | Apache-2.0 / CC0 components | official implementations and test vectors | Contract defines object IDs; Aiko never independently invents an ID |
| Signatures | Contract semantics; Aiko keystore | [`dalek-cryptography/curve25519-dalek`](https://github.com/dalek-cryptography/curve25519-dalek) | BSD-3-Clause for the maintained Dalek crates; verify each packaged crate | Ed25519 signing and verification vectors | Contract defines signing bytes and verifies; private keys remain behind Aiko's local keystore boundary |
| Embedded metadata | Aiko | [`cberner/redb`](https://github.com/cberner/redb) | Apache-2.0 | pure-Rust transactional KV store | Store peer records, pins, object metadata, and index roots; blobs remain ordinary verified files |
| Local search | Aiko | [`quickwit-oss/tantivy`](https://github.com/quickwit-oss/tantivy) | MIT | inverted index, schema fields, collectors | Build replaceable local/index-segment retrieval; Contract performs final ranking |
| Update trust | Aiko distribution | [`theupdateframework/rust-tuf`](https://github.com/theupdateframework/rust-tuf) | Apache-2.0 | delegated metadata, threshold signing, expiry, rollback/freeze protection | Protect bootstrap lists and signed release/index-root channels; not contract-object trust or ranking |

`rust-libp2p` is the deliberate primary choice: it provides the complete
decentralized discovery toolbox and avoids coupling the protocol to a hosted
relay or DNS service. Use only the required features so the desktop binary does
not inherit the entire stack.

### Clone as references or focused spikes

| Role | Repository | License | Decision |
| --- | --- | --- | --- |
| Immutable-store model | [`NixOS/nix`](https://github.com/NixOS/nix) | LGPL-2.1 | Study canonical derivations, store verification, substitution, nar-style export, pinning, and GC. Do not embed the Nix daemon or copy LGPL implementation code into Aiko without a deliberate linking/compliance design. |
| QUIC/NAT alternative | [`n0-computer/iroh`](https://github.com/n0-computer/iroh) | MIT / Apache-2.0 | Build a short transport spike and compare connection success, relay self-hosting, binary size, Windows support, and operational assumptions against rust-libp2p. Choose one peer stack; do not ship both by default. |
| Verified blob transfer | [`n0-computer/iroh-blobs`](https://github.com/n0-computer/iroh-blobs) | MIT / Apache-2.0 | Reuse or adapt its verified collection/blob transfer only if it cleanly separates from Iroh transport and beats the simpler Aiko object protocol. |
| Raw QUIC | [`quinn-rs/quinn`](https://github.com/quinn-rs/quinn) | MIT / Apache-2.0 | Reference and transitive implementation under libp2p QUIC. Use directly only if the libp2p transport boundary proves too restrictive. |
| Torrent behavior | [`ikatson/rqbit`](https://github.com/ikatson/rqbit) | Apache-2.0 | Study piece verification, peer scheduling, resumable transfer, choking/backpressure, and rarity. Do not adopt the BitTorrent wire protocol: Aiko objects and trust rules differ. |
| Transparency structures | [`transparency-dev/merkle`](https://github.com/transparency-dev/merkle) | Apache-2.0 | Reference Merkle proof and checkpoint behavior. It is Go, so prefer vectors/specification or a small compatible Rust implementation over embedding a service. |
| Full transparency service | [`google/trillian`](https://github.com/google/trillian) | Apache-2.0 | Defer. It is useful design evidence but operationally too heavy for every Aiko node. |
| Artifact verification | [`sigstore/sigstore-rs`](https://github.com/sigstore/sigstore-rs) | Apache-2.0 | Use for interoperability with external signed artifacts if needed; do not require Sigstore's public services for Aiko node identity. |
| Collaborative state | [`automerge/automerge`](https://github.com/automerge/automerge) | MIT | Defer until there is genuinely mutable shared state. Immutable objects plus signed append-only records do not need a CRDT in v1. |

### Explicitly rejected as initial foundations

- Kubo/IPFS as a daemon dependency: useful reference, but it would make Aiko's
  lifecycle, protocol surface, and resource policy depend on another runtime.
- A bespoke DHT or QUIC implementation: mature open-source implementations
  already cover the dangerous transport and routing details.
- Nix itself as the object store: its model is valuable, but its daemon,
  expression language, filesystem conventions, and LGPL boundary are far more
  than the product needs.
- Trillian as a required network service: transparency must remain peer-hostable
  and embeddable rather than introduce a mandatory database-backed service.
- Two production peer stacks: Iroh and rust-libp2p should be compared, not
  layered together.

### Source acquisition and provenance

Create `third_party/sources.lock.toml` before implementation. Each entry records:

```toml
[[source]]
name = "rust-libp2p"
repository = "https://github.com/libp2p/rust-libp2p.git"
revision = "full-40-character-reviewed-commit"
license = "MIT"
usage = "cargo_dependency"
reviewed_at = "2026-07-21"
```

Use this workflow:

1. Clone reference trees outside the product source tree with blob filtering:

   ```sh
   mkdir -p ../aiko-reference-sources
   git clone --filter=blob:none https://github.com/NixOS/nix.git ../aiko-reference-sources/nix
   git clone --filter=blob:none https://github.com/libp2p/rust-libp2p.git ../aiko-reference-sources/rust-libp2p
   git clone --filter=blob:none https://github.com/n0-computer/iroh.git ../aiko-reference-sources/iroh
   git clone --filter=blob:none https://github.com/ikatson/rqbit.git ../aiko-reference-sources/rqbit
   ```

2. Check out an immutable reviewed commit, record it in
   `third_party/sources.lock.toml`, and preserve the upstream license and notice.
3. Prefer a crates.io dependency pinned by `Cargo.lock`; use a Git revision only
   when the required fix is unreleased.
4. If code is adapted, place it in a clearly named module with an attribution
   header and add the upstream license to `third_party/licenses/`.
5. Run `cargo deny` for license/advisory/source policy, `cargo vet` for reviewed
   dependency criteria, and an SBOM generator in release CI.
6. Mirror the exact source archives needed for reproducible releases. GitHub is
   a development origin, never a runtime dependency or bootstrap authority.

### Required proof before committing to the peer stack

Build the same three-node LAN scenario with rust-libp2p and the Iroh spike, then
measure:

- direct and NATed connection success;
- behavior with every hosted relay/DNS service disabled;
- cold bootstrap and reconnect latency;
- binary and memory overhead on macOS and Windows;
- self-hosted relay setup and failure behavior;
- mDNS/direct-invitation offline operation;
- API stability and amount of Aiko-specific protocol code.

Default to rust-libp2p unless Iroh wins this test while also proving that all
discovery, relay, and naming infrastructure is independently self-hostable.

The Aiko protocol and object formats remain ours and are specified independently.
External libraries implement replaceable primitives behind narrow adapters.

## Delivery Phases

### Phase 0 — Contract specification and threat model (`../contract` only)

- Make `docs/COLLECTIVE-PROTOCOL.md` the canonical object/trust specification.
- Freeze canonical encoding, object domains, hashing, signing, version, expiry,
  delegation, revocation, and deterministic merge rules.
- Define publication classification and sanitizer conformance fixtures.
- Define bounded wire-object schemas without implementing any transport.
- Threat-model privacy leaks, poisoning, replay, malicious schemas, resource
  exhaustion, equivocation, key compromise, and revocation failure.
- Add cross-language golden vectors under `fixtures/collective/`.
- Record which existing ledger events the new objects project into; prohibit a
  second evidence ledger.

Acceptance:

- Zig is the first normative implementation and passes every golden vector.
- A secret-bearing or ambiguous object cannot be published.
- Every input has an explicit byte, collection, nesting, and timestamp bound.
- No Phase 0 module opens a socket, reads peer configuration, or imports Aiko.

### Phase 1 — Native Contract collective kernel (`../contract` only)

- Extend `cas.zig` from its in-memory SHA-256 proof into the canonical object
  interface while retaining explicit hash-algorithm/version domains.
- Implement publication verdicts, canonical objects, signing payloads,
  verification, attestations, revocation projection, deterministic merge,
  checkpoints, and collective ranking as pure Zig modules.
- Bridge FECH descriptors into collective objects without changing the existing
  local capability execution ABI.
- Export the byte-in/byte-out collective C ABI from `c_abi.zig` while preserving
  all existing ABI symbols.
- Add fuzz/property tests, malformed-object corpus tests, and cross-version
  evidence invalidation tests.
- Add a standalone Contract conformance executable that validates object packs
  without Aiko or a network.

Acceptance:

- Repeated canonicalization is byte-identical and idempotent.
- Sign/verify, rotation, expiry, revocation, merge, and checkpoint vectors pass.
- Existing FECH and Contract suites remain green and ABI-compatible.
- Credentials and raw execution content are rejected before ledger projection.
- The kernel works in a filesystem-free test harness with caller-owned buffers.

### Phase 2 — Aiko local host and Contract bridge (`aiko`)

- Add the `xai-aiko-collective` crate and the sole collective ABI bridge.
- Implement verified file blobs, redb metadata, quarantine, pins, quotas, GC,
  and deterministic offline object-pack import/export.
- Port Contract golden vectors into Rust tests and require identical hashes and
  verdicts across the ABI boundary.
- Connect existing FECH discovery to the two-stage publication gate.
- Add user settings, publication preview, audit history, revocation controls,
  and typed desktop/TUI events.
- Complete the rust-libp2p versus Iroh spike before choosing the transport.

Acceptance:

- Two clean Aiko profiles derive the same Contract object ID.
- Offline export/import reconstructs an identical verified catalog.
- Objects move from quarantine only after a successful Contract verdict.
- Disabling collective participation causes zero network activity.
- The existing app remains fully usable if the collective store is absent.

### Phase 3 — Direct peer replication (`aiko`, Contract verifies)

- Implement QUIC sessions, `HELLO`, `GET_OBJECT`, provider announcements,
  direct invitations, mDNS, and resumable verified transfer.
- Add connection limits, reputation-neutral rate limits, and quarantine.
- Pass every received object to Contract before admission or indexing.

Acceptance:

- Three nodes on a LAN discover and replicate a newly published contract with
  no internet or hosted service.
- Corrupt pieces, forged signatures, and replayed expired records are rejected.
- Restarting every node preserves the network from local peer stores.

### Phase 4 — DHT and torrent-like distribution (`aiko`)

- Add Kademlia-style node/provider discovery and bounded peer exchange.
- Add replication policy, rarity-aware pinning, chunked index transfer, NAT
  traversal where feasible, and relay support as an optional peer role.
- Support repository, DNS, community, and optional Aiko seed lists equally.

Acceptance:

- A node starting from any one valid seed finds the same pinned public object.
- Removing all Aiko-operated nodes does not stop established community nodes
  from discovering or transferring contracts.
- Object integrity is independent of the serving peer.

### Phase 5 — Globally queryable indexes (Aiko indexes, Contract ranks)

- Build deterministic index segments over public contract metadata.
- Let any node publish, mirror, and query index roots.
- Merge results from independent indexes and perform final reranking locally.
- Add private local querying of downloaded index segments before considering
  remote structured lookup.

Acceptance:

- Independent index builders produce equivalent results from the same object
  set or expose their differing signed roots.
- A globally published route is discoverable from an unrelated node without
  contacting its original publisher.
- Normal local task text is not broadcast to the DHT or arbitrary peers.

### Phase 6 — Evidence and transparency (Contract semantics, Aiko transport)

- Publish optional sanitized aggregate attestations only after Contract returns
  `publishable` for the exact attestation bytes.
- Complete Contract's Merkle checkpoints, rotation, delegation, revocation, and
  trust projection; add Aiko witness gossip and synchronization.
- Run adversarial simulations for poisoning, eclipse, Sybil, and spam attacks.

Acceptance:

- Fresh verified failures lower discovery rank without exposing invocation
  content or poisoning unrelated versions.
- Equivocating indexes and revoked publishers are detectable across witnesses.
- Global evidence alone can never cross Aiko's local automatic-execution gate.

## Success Criteria

- A disconnected group of at least three Aikos can publish, discover, query,
  replicate, rank, and execute public contracts entirely on a LAN.
- An internet-connected node can discover a contract after its original
  publisher goes offline, provided another peer retained it.
- There is no required hosted database, account provider, object store, index,
  relay, seed, ranking service, or Aiko-controlled server.
- Public objects contain no credential, raw user content, account identifier,
  machine path, request body, or response body across the privacy corpus.
- Corrupt or malicious network input cannot bypass Contract ranking, Aiko
  permissions, or local execution availability.
- Users can inspect what was published, revoke future discovery, erase their
  local copy, disable participation, and operate entirely offline.

## Explicitly Deferred

- Tokens, cryptocurrency, settlement, and on-chain consensus;
- paid marketplaces and revenue sharing;
- publishing arbitrary local binaries or private data;
- remote execution on another user's machine;
- sharing credentials or authentication sessions;
- fully private global semantic search;
- automatic publication of sensitive or mutating capabilities;
- guaranteeing deletion of immutable objects already replicated by peers.

## Architectural Decision

Unbrowse should be the protocol-compatible public view produced by Aiko nodes,
not a central service that owns their contracts. Cloud infrastructure can be a
useful bootstrap and acceleration layer during adoption, but every cloud role
must have a documented peer equivalent, a local fallback, and a migration path
to community-operated infrastructure.
