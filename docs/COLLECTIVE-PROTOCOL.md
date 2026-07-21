# Contract Collective Protocol Boundary

Status: architecture contract for the Contract-first implementation. The
network itself is not implemented by this document.

The full product and delivery plan lives in `../aiko/plan-arch.md`. This file is
the Contract-side authority for what `libcontract` must and must not own.

## Rule

Contract is the deterministic trust and ranking kernel. Aiko is the stateful
host. Aiko depends on Contract through a stable byte-in/byte-out C ABI; Contract
never depends on Aiko or a network implementation.

```text
Aiko: discover -> sanitize -> fetch/quarantine -> persist/index -> execute
                              |
                              v
Contract: canonicalize -> classify -> verify -> admit -> rank -> record evidence
```

## Contract owns

- canonical collective object schemas and encoding;
- domain-separated content identity and exact version semantics;
- publication classification and fail-closed validation;
- signing payloads, signature verification, rotation, delegation, and expiry;
- provider records, privacy-safe attestations, revocations, and checkpoints;
- deterministic admission, merge, inhibition, and conflict projection;
- public evidence scoring and composition with local FECH ranking;
- projection into the existing append-only evidence ledger;
- cross-language fixtures, reason codes, fuzz corpus, and the stable ABI.

## Contract never owns

- sockets, QUIC, DHT, mDNS, NAT traversal, relays, peer dialing, or retries;
- physical peer/blob databases, filesystem watchers, GC scheduling, or quotas;
- browser capture, MCP/tool discovery, credentials, or authentication;
- remote execution, permission prompts, UI, TUI, accounts, or cloud services;
- raw prompts, URLs, arguments, response bodies, command output, or user values.

## Aiko owns

- first-stage normalization and secret removal;
- publication settings, previews, audit history, and user revocation controls;
- peer networking and every protocol transport concern;
- quarantine, physical blob storage, metadata, indexing, pinning, and GC;
- bootstrap, connection policy, rate limits, bans, and lifecycle;
- local availability, private intent, permissions, execution, and cancellation;
- asking Contract to verify every received object before admission;
- packaging and UI/TUI diagnostics.

## Native modules

The implementation should extend existing Contract primitives rather than
create a parallel substrate:

| New concern | Extend |
| --- | --- |
| canonical objects and IDs | `cas.zig` |
| publication classification | FECH validation and `gate.zig` |
| publisher identity | `lineage.zig`, `keystore.zig`, `trust.zig` |
| public observations | `capability_registry.zig` and the outcome ledger |
| revocation | existing trust and terminal projections |
| deterministic merge | `ledger.zig` idempotency |
| collective ranking | `capability_cells.zig`, `ebm.zig` |
| native boundary | `c_abi.zig` |

Immutable public object bytes may live in a content-addressed blob store, but
their admitted attestations and revocations must project into the one existing
semantic ledger. A second outcome or trust ledger is prohibited.

## Planned ABI

Names are provisional until Phase 0 freezes them, but the ownership shape is
binding:

```text
contract_collective_canonicalize(candidate_json)
contract_collective_publication_verdict(descriptor_json, provenance_json)
contract_collective_signing_payload(object_json)
contract_collective_verify(object_bytes, signature, publisher_key, now)
contract_collective_admit(object_bytes, source_peer, received_at)
contract_collective_apply_revocations(revocation_objects_with_target_owners, now)
contract_collective_rank(query_features, candidate_metadata, local_availability)
contract_collective_checkpoint(object_ids)
contract_collective_inclusion_proof(object_ids, target_object_id)
contract_collective_verify_inclusion_proof(proof)
```

Each operation is deterministic and uses caller-owned buffers. No collective
ABI operation performs network I/O, invokes a tool, or persists availability.

Revocation projection deliberately separates signature validity from
authority. Each object or delegation revocation is supplied as
`{"envelope": <signed-revocation>, "target_publisher": <publisher>}` after the
caller resolves the owner from its Contract-admitted catalog. Contract accepts
the effect only when the revocation signer equals that owner. A bare envelope
can revoke only its own publisher key. This prevents any valid but unrelated
key from suppressing another publisher's object.

## Contract-first order

1. Freeze schemas, bounds, canonical encoding, object domains, and vectors.
2. Implement pure Zig canonicalization, classification, signing payloads,
   verification, admission, revocation, merge, ranking, and checkpoints.
3. Export the additive C ABI without breaking the existing FECH ABI.
4. Prove identical results through a standalone Contract conformance tool.
5. Only then add Aiko storage and networking against those frozen vectors.

## Admission invariant

Remote bytes are hostile until this sequence succeeds:

```text
bounded parse
  -> schema/version validation
  -> canonical bytes and content ID
  -> signature/delegation/expiry verification
  -> revocation projection
  -> privacy/publication policy
  -> admitted verdict with reason codes
```

Aiko may store failed input only in a bounded quarantine. It must not index,
rank, announce, or execute an object that Contract has not admitted.

## Identity transitions

Publisher identity changes are ordinary immutable signed objects, never an
out-of-band database edit. A `key_rotation` is signed by `previous_publisher`,
names exactly one distinct `new_publisher`, and becomes valid at
`effective_at`. A `delegation` is signed by its publisher, names one distinct
delegate, a closed list of object-kind scopes, and an explicit
`[not_before, not_after)` interval. Rotations and delegations are ordered by
publisher sequence; same-sequence conflicts are equivocation and quarantine
all conflicting objects. Signed revocations can inhibit either publisher or
delegation identities without deleting history.

## Completion gate for the Contract phase

- Zig is the normative first implementation.
- Repeated canonicalization is byte-identical and idempotent.
- Secret-bearing and ambiguous objects fail closed.
- Sign/verify, rotation, expiry, revocation, merge, and checkpoint vectors pass.
- Exact descriptor versions cannot inherit incompatible evidence.
- Existing Contract and FECH suites remain green.
- The conformance harness requires no network, cloud service, Aiko process, or
  filesystem beyond caller-supplied test fixtures.
