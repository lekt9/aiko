# Contract agency substrate

Contract remains one resolver and one ledger. Agency semantics are a versioned
policy envelope over an existing declaration, not a second orchestration engine.
Rows without an envelope remain explicitly `legacy_ungoverned`; malformed typed
rows fail closed and are never downgraded.

## Roles and control topology

The schema defines `purpose`, `sensor`, `action`, `evaluator`, `governor`, and
`development` roles, plus `legacy` for migration. Every typed node declares its
authority pointer, purpose, cadence, effect scope, evidence policy, validity
window, revocation/supersession links, and schema version.

Legal relationships are checked centrally. Slow owners may change faster-loop
targets; faster nodes can propose changes but cannot apply them. Frozen targets,
evaluator identity, and veto boundaries cannot be weakened by the action being
judged.

## Grounded resolution

A high-risk action follows this enforced sequence:

1. Its capability and declared reach are compared.
2. Explicit approval and a matching consequence sensor are required.
3. The sensor records a fresh terminal reality anchor.
4. An evaluator from a distinct source and failure domain checks the claim.
5. A contradiction vetoes success and bypasses positive cache reuse.
6. Revocation invalidates downstream dependants; rollback selects only a prior,
   unrevoked, policy-compatible champion.

Anchors support executed tests, filesystem observations, HTTP/API observations,
browser state, scoped human attestations, economic receipts, physical
measurements, and adapter measurements. Ledger assertions cannot serve as
terminal anchors. Large or private observations stay behind typed digest
pointers.

## Typed declaration

Local CLI declarations accept a canonical schema-v1 envelope:

```sh
contract declare "verify storefront" \
  --action "shell:./verify-storefront.sh" \
  --agency '{"role":"action","authority_pointer":"governor-1","purpose_id":"storefront","cadence_class":"operational","effect_scope":"deployment","evidence_policy_id":"storefront-policy","valid_from":0,"valid_until":4102444800000,"revokes":null,"supersedes":null,"schema_version":1}'
```

The same semantics are exposed through `contract_declare_agency` in the C ABI,
the `agency_validate` MCP tool, and the library `DeclareOptions.agency_envelope`.
Typed semantics enter the v3 cache key. Untyped declarations keep their exact v2
key and ledger shape.

Remote declaration currently refuses typed envelopes rather than silently
dropping their meaning. That refusal remains until the remote capability
handshake advertises schema v1.

## Observability

`activity.log` remains the small compatibility health log. Causal agency events
are written separately to `.claude/events.jsonl` (or
`~/.contracts/events.jsonl`) with a stable, redacted JSON schema.

```sh
contract events
contract events --trace trace-123
contract explain trace-123
open tools/contract-events.html
```

The HTML renderer reads a dropped JSONL file entirely in the browser. It makes
no network requests. Events expose role, owner, cadence, state, causal parent,
anchor/evidence reference, independence class, counter-metric, reach, blocker,
and timestamp. Controlled identifiers only are accepted; payload-shaped values
are rejected before persistence.

## Keychain boundary

Read-only observability is dispatched before retry, wallet, lineage, ledger, and
network paths. `events`, `explain`, `self`, and help therefore do not request
signing material. Run:

```sh
./tools/audit-readonly-keychain.sh
```

The audit uses an isolated HOME, imposes a five-second blocking budget, rejects
unexpected state creation, and scans output for secret-shaped text.

Routine signing resolves the root from the mode-600 canonical file or recovery
mirror and caches it for the process. Fresh initialization creates those file
tiers without opening or writing Keychain. Native Keychain access remains for
explicit keychain-only import, rotation/maintenance, and recovery when both file
tiers are absent. This is the remaining prompt boundary and is intentionally
visible rather than implicit.

## Topology development and migration

Development proposals contain actor, required authority, rationale, evidence,
predicted impact, operations, and inverse operations. Application is atomic:
any failed operation leaves the caller's snapshot unchanged. Accepted changes
retain the prior topology and can restore it exactly.

The migration bridge produces a shadow verdict of `same`, `stricter`, or
`incompatible`. Missing agency data is legacy; malformed agency data is
incompatible. This prevents rollout from manufacturing roles or weakening
policy to preserve apparent compatibility.
