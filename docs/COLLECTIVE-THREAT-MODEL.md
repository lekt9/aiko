# Aiko Collective Threat Model v1

This threat model covers the public contract-object and trust kernel implemented
by Contract. Transport mitigations are requirements on Aiko, not dependencies
of `libcontract`.

## Protected assets

- local credentials, prompts, arguments, results, paths, account identifiers,
  browser state, and private capability inventory;
- the integrity of content IDs, publisher identities, attestations,
  revocations, checkpoints, ranking evidence, and local execution decisions;
- bounded CPU, memory, disk, sockets, and background work on each Aiko node;
- the ability to operate, verify, search, and execute while offline.

## Trust boundaries

1. Capture and local discovery are private and untrusted until Aiko sanitizes.
2. Contract's publication verdict is the final gate before signing or announce.
3. Every received network byte is hostile and enters bounded quarantine.
4. A Contract admission verdict is required before indexing or ranking.
5. Global ranking is advisory; local availability, evidence, and permissions
   remain authoritative for execution.
6. Publisher signatures prove origin, not correctness or safety.

## Normative parser and resource bounds

| Resource | Limit |
| --- | ---: |
| signed object envelope | 256 KiB |
| canonical unsigned payload | 192 KiB |
| JSON nesting depth | 16 |
| object properties | 128 per object |
| arrays | schema-specific, never more than 4096 items |
| string | 512 bytes unless a stricter schema limit applies |
| peer address | 256 bytes |
| objects in one provider record | 256 |
| index shards in one root | 4096 |
| integer range | 0 through 2^53-1 |
| signature/public key | exact encoded length |
| clock skew accepted for creation | 10 minutes into the future |
| provider-record lifetime | at most 24 hours |
| capability lifetime | at most 90 days |
| attestation lifetime | at most 30 days |

Unknown schema versions and security-critical enum values fail closed. Duplicate
JSON keys, non-integer numbers, invalid UTF-8, unpaired surrogates, trailing
data, and noncanonical timestamps are rejected.

## Canonicalization and identity

V1 canonicalization is `aiko-jcs-subset/1`: RFC 8785-style JSON with
lexicographically ordered ASCII schema keys, minimal JSON string escaping,
UTF-8 string bytes preserved exactly, no duplicate keys, and integers only.
Every schema key is ASCII, so byte and Unicode code-point ordering agree.

```text
object_digest = BLAKE3(
  "aiko.collective.object.v1" || 0x00 || canonical(unsigned)
)

object_id = "blake3:" || lowercase_hex(object_digest)

signature_message = BLAKE3(
  "aiko.collective.signature.v1" || 0x00 || object_digest
)
```

The envelope's `object_id` and `signature` are excluded from `unsigned`.
Publisher identity, sequence, timestamps, kind, and payload are included.
Signatures are Ed25519 over `signature_message`.

## Threats and mitigations

### Privacy leakage

An attacker or accidental publisher may embed secrets in names, summaries,
schemas, examples, URLs, identifiers, or nested unknown fields.

- Closed schemas reject unknown fields.
- Public shape schemas exclude defaults, examples, descriptions, formats, and
  concrete values.
- Contract recursively rejects forbidden field-name and value patterns.
- Sensitive, account-scoped, mutating, local, and ambiguous capabilities remain
  private regardless of user access.
- Public attestations contain categorical outcomes and buckets only.

### Object poisoning and schema confusion

- Kind-to-payload matching is closed and versioned.
- IDs are recomputed from canonical bytes before signature verification.
- Exact capability versions bind all evidence.
- Unknown kinds, algorithms, effects, permissions, and protocol versions fail
  closed rather than degrade to a legacy interpretation.

### Replay, rollback, and freeze

- Objects carry publisher sequence, creation, expiry, and exact version.
- Provider records and attestations are short-lived.
- TUF-style signed roots protect bootstrap/update channels.
- A newer trusted sequence cannot be replaced by an older one.
- Expired metadata never makes a capability automatic.

### Key compromise and equivocation

- Rotation and delegation are signed, ordered objects.
- Revocations are append-only and effective by timestamp/sequence.
- Merkle checkpoints allow witnesses to detect inconsistent views.
- A publisher can revoke future trust but cannot erase already replicated data.

### Sybil and ranking manipulation

- Raw observation count is never reputation.
- Contract weights independent publisher history, environment diversity,
  freshness, reproducibility, and local evidence.
- New global evidence affects discovery only; it cannot authorize execution.
- Same-key and known same-failure-domain observations do not add independence.

### Eclipse and omission

- Aiko supports multiple bootstrap paths and index roots.
- Nodes retain peers and pinned index segments locally.
- Independent index results are merged; signed roots expose divergence.
- Witness checkpoint gossip detects equivocation but does not require global
  consensus.

### Resource exhaustion

- Contract applies byte/depth/count bounds before allocation-heavy work.
- Aiko applies connection, request, bandwidth, quarantine, disk, and concurrency
  quotas before passing bounded objects across the ABI.
- Hash and signature work occurs only after structural limits pass.
- Malformed peers are rate-limited or banned by Aiko.

### Malicious capability execution

- Network objects contain descriptions and shapes, never credentials or an
  executable authority grant.
- Contract never invokes tools.
- Aiko resolves a public contract to a locally installed adapter, checks live
  availability, asks for permission, and executes locally.
- Public v1 capabilities are limited to read/network-read effects.

## Required adversarial tests

- forbidden fields at every nesting position;
- secrets in keys and string values;
- duplicate keys, invalid UTF-8, deep nesting, oversized arrays and strings;
- wrong kind/payload pairs and unknown security enums;
- content-ID mismatch and valid signature over altered payload;
- expired, future-dated, replayed, and decreasing-sequence objects;
- compromised-key rotation and revocation ordering;
- stale success versus fresh failure and exact-version invalidation;
- same-publisher Sybil observations and checkpoint equivocation;
- network-disabled three-node LAN operation with corrupt-piece injection.
