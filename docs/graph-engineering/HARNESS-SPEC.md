# GraphHarness package specification (`graph-harness/v1`)

**Status:** preparation and external-admission contract.  
**Canonical schema:** [`../../schemas/graph-harness-v1.schema.json`](../../schemas/graph-harness-v1.schema.json).  
**Media type:** `application/vnd.aiko.graph-harness+json;version=1`.

A `GraphHarness` is a prepared or externally admitted reusable declaration of a bounded graph-engineering harness. It says what may cross the package membrane, what bounded nodes exist, which immutable implementations they refer to, and how a position independent of each producer can judge the result. It is deliberately **not** a scheduler, execution log, lease, firing, manifest, or settlement record.

The envelope has five top-level fields:

```json
{
  "api_version": "graph-harness/v1",
  "kind": "GraphHarness",
  "package": { "...": "digest subject" },
  "admission": { "...": "prepared identity or external admission over /package" },
  "registry": { "...": "discovery and compatibility metadata" }
}
```

Unknown fields fail schema validation. Consumers must also apply the semantic admission checks below; JSON Schema alone cannot prove digests, graph acyclicity, implementation independence, or that a command really observes durable behavior.

## 1. What is canonical

The admission subject is exactly the JSON value at `/package`, serialized with RFC 8785 JSON Canonicalization Scheme and hashed with SHA-256. `admission.subject_digest` names those bytes. Keeping `admission` and `registry` outside the digest subject avoids a self-referential digest and allows a registry to add transport indexing without changing the admitted behavior.

Admission must fail unless all of the following hold:

1. the envelope validates against the v1 schema;
2. `SHA-256(JCS(envelope.package))` equals `admission.subject_digest.value`;
3. every referenced implementation, schema, source, witness, judge, and generator resolves to bytes matching its declared digest;
4. node IDs are unique; every dependency names a node in this package; the active declaration is acyclic;
5. `registry.name`, `registry.version`, and `registry.description` equal the corresponding package metadata;
6. every node dependency carries declared data, evidence, authority, or settlement—not merely prose order;
7. a node's independent judge is not the node producer (its admitted implementation digest and authority position must be independent);
8. the north-star judge is independent of every producer whose result it judges;
9. declared reads are bound to membrane inputs, cited sources, or declared products; declared products and writes remain inside the membrane's admitted authority;
10. recursion limits are compatible (`nodes.length <= max_total_nodes`) and no expansion can exceed them.

`build` records only `state: "prepared"`, the subject/transitive digests, canonicalization, and dependency closure. It never executes a witness or creates behavioral admission. Only `admit` may change the state to `"admitted"`, by consuming a separate authenticated `graph-harness-attestation/v1` object owned by Contract. The attestation must bind the exact subject and transitive digests, cover every node and north-star witness ID exactly once, name each package-declared independent judge and its verdict reference, and include a pinned `admitted_by`, RFC 3339 `admitted_at` with the required uppercase `T` separator, evidence references, and mandatory Contract `ledger_ref`. Every verdict reference must occur in `evidence_refs`. The admitted envelope retains those verdict bindings, its authentication object, and the SHA-256 digest of the complete signed attestation. The compiler verifies these bindings and the attester bytes but never invokes witnesses or judges.

### Contract authentication and trust model

`admit` takes no trust-root or key selector. At process bootstrap the deployment must set `AIKO_CONTRACT_VERIFY_KEY` to an absolute path naming the pinned Contract **public** verification key. The MCP service must sanitize and pin this environment before serving requests; it must never copy request, command, attestation, or package data into this variable. The PEM must be a regular non-symlink file of 1 through 65,536 bytes and must contain an Ed25519 public key. Contract alone retains custody of the corresponding **private signing key**; the compiler receives only the public key. Declarations and attestation authors are untrusted and cannot name a verifier key. Rotation is a deployment bootstrap change, not an attestation field or CLI option.

Every attestation has a required `authentication` object: `algorithm` is `ed25519`; `key_id` is `sha256:` followed by the lowercase SHA-256 digest of the DER SubjectPublicKeyInfo produced from the pinned PEM by `/usr/bin/openssl`; and `value` is the 128-character lowercase hexadecimal encoding of the 64-byte Ed25519 signature. The signature input is the RFC 8785 canonical complete attestation after replacing only `authentication.value` with the empty string. Thus it covers `algorithm`, `key_id`, owner, both prepared identities, every verdict/judge/reference, attester, time, evidence, and `ledger_ref`. Verification uses fixed `/usr/bin/openssl pkeyutl -verify -pubin -rawin`, 0600 temporary message/signature files, exit status rather than stdout, and happens before the state transition. Possession of Contract's private signing key, rather than a caller-authored `owner` string, vouches that the cited Contract references exist.

Replay is identity-bound, not time-window policy: a valid statement can be applied only to the prepared envelope with the exact covered subject and transitive digests, while its covered `admitted_at`, evidence, and ledger reference cannot be rewritten. Contract must enforce issuance freshness/revocation and key rotation policy; the packaging compiler has no clock or ledger and does not pretend otherwise.

## 2. Membrane

`package.membrane` is the only public boundary of a reusable harness:

- `inputs` and `outputs` are named ports. Every port pins a JSON Schema by reference and digest.
- `authority` is the maximum declared filesystem, network, process, and secret scope.

Authority declarations are audit and admission inputs. They are not proof that arbitrary Python, shell, or model code is confined. A runner may execute only where its executor can enforce the requested authority or where policy explicitly accepts the residual risk. Empty lists mean no declared authority; they must not be interpreted as proof that ambient effects are impossible.

The membrane is compatible in shape with Cell's typed-port idea, but it is not a Cell declaration. A `cell_v0` registry projection may point to a separately admitted Cell implementation.

## 3. North-star acceptance

`package.north_star` is the package-level falsifiable acceptance. It consists of:

- a non-empty `claim` describing correct observable behavior;
- a structured `witness` with a pinned implementation, argv (not an implicit shell string), timeout, expected exit codes/artifacts, and named evidence;
- an `independent: true` judge with its own pinned implementation, explicit evidence inputs, and a pinned verdict schema.

A process exit alone is not sufficient when the claim concerns an artifact, durable state, or external effect. Witness evidence must identify that artifact/state/read-back. The judge consumes evidence rather than the producer's explanation. `independent: true` is a declaration; admission must verify separation of implementation and authority.

North-star acceptance is stronger than registry `expect_contains`. A compatibility projection may expose a probe for existing skill discovery, but a string that a do-nothing handler could print never admits a GraphHarness.

## 4. Nodes and edges

Every node is a bounded declaration with these mandatory fields:

| Field | Meaning |
|---|---|
| `id` | Package-local stable identity. |
| `depends_on` | Settlement/data edges, never checklist order. |
| `reads` | Declared input/source/product references. |
| `produces` | Named products made available to descendants or outputs. |
| `writes` | Conservative file/object scopes used for collision policy. |
| `resources` | Typed resource scope, access mode, and exclusivity request. |
| `effects` | Effect kind/scope and boundary/read-back/invalidation policy. |
| `implementation` | Portable reference plus SHA-256 of bytes admitted before execution. |
| `grounding` | Installed skills, pinned sources, or an honest capability gap. |
| `acceptance` | Per-node structured witness and independent judge. |

`determinism: required` is appropriate for every producer on a recompute path. Non-deterministic implementations belong at terminal edges (`edge-only`) or behind a pinned cache. A capability gap grounds an honest refusal; it does not make the node executable.

An external-boundary effect is schema-constrained to require independent read-back and `compensate-never-replay` on invalidation. Once read-back establishes that an effect crossed the boundary, a changed source creates a compensation obligation over old and new products. It must not re-enter the stale firing.

The schema records topology but computes no frontier. Contract's analyzer/runtime remains responsible for validating richer durable bindings, planning/leases, and settlement. A caller may map these fields into a Contract walk, but the package itself gives no launch authority.

## 5. Recursion budgets

`package.recursion` bounds generated descendants with:

- maximum depth;
- maximum children per node;
- maximum total nodes;
- wall-time budget;
- tool-call budget;
- mandatory `on_exhaustion: refuse`.

Budgets are transportable ceilings, not counters. Runtime counters and durable exhaustion state belong to the executing/settling layer. Recursive packages must reduce the remaining budget monotonically. A child may receive only the smaller of its own declared ceiling and its parent's remaining budget. Exhaustion refuses expansion; it must not silently truncate a graph and claim the north star passed.

## 6. Grounding and provenance

Grounding is present only when at least one of `skills`, pinned `sources`, or `capability_gaps` is non-empty. A pinned skill is not arbitrary bytes: preparation parses the exact digest-verified `SKILL.md` bytes, requires closed YAML frontmatter containing exactly non-empty `name`, `description`, `probe_input`, and `expect_contains`, and requires its `name` to equal the grounding name. Unsupported YAML constructs, duplicate/unknown/missing fields, invalid UTF-8, digest drift, and free text posing as a skill refuse. Walk diagnostics retain the skill name, reference, and digest so execution adapters do not erase pinned identity.

Package provenance records:

- author identity and timestamp;
- pinned source identities;
- the pinned generator implementation;
- optionally, the parent package digest for recursive generation.

Generated bytes must exist before they are pinned. Generation, preparation, execution/judgment, and admission are separate acts. Compilation emits only `prepared`; the package earns `admitted` only from a complete Contract-owned external attestation covering its structured acceptance and independent judgments.

Provenance is not a Neuron firing. When executed through Neuron, the firing must separately cite actual `evidence[].sources` and attach products with `produced_by`; otherwise invalidation cannot see the dependency.

## 7. Registry compatibility

`registry` is a transport index, not the behavioral authority. It supplies stable name/version/description, the v1 media type, tags, and optional projections:

- `aiko_skill_v1` exposes the current `name`, `description`, `probe_input`, and `expect_contains` shape used by the Aiko/Neuron skill package surface;
- `cell_v0` points by digest to a separately validated Cell implementation.

The projection is intentionally outside `/package`. Registry rewriting cannot alter admitted behavior. A consumer must match registry identity back to `package.metadata` and must use `package.north_star` for admission. Existing registries may discover and route the package without pretending that their legacy probe proves the richer contract.

There is no automatic lossless conversion among GraphHarness, a Contract walk, Cell YAML, and a Neuron firing. Adapters are explicit, pinned implementations and must preserve the membrane and acceptance or refuse.

## 8. Ownership: no fourth graph and no second truth

| Layer | Owns for this package | Does not own |
|---|---|---|
| **Contract** | Pure walk analysis when asked; durable declaration, leases, evidence, invalidation, and settlement in its existing execution substrate. | Package transport, Cell execution, or a second scheduler created by this spec. |
| **Cell** | Typed ports, cell-local deterministic Kahn execution, executor checks, and manifests for a referenced `cell/v0` implementation. | Contract durability, general multi-agent scheduling, or GraphHarness admission truth. |
| **Neuron** | Standalone firing identity, cited derivation provenance, committed products, stale facts, and three-case redrive. | Contract planning, registry admission, or observer-side effect-safety guesses. |
| **Aiko host/registry** | Schema validation, digest/admission membrane, discovery projections, explicit adapters, and composition of the owning layers. | A fifth scheduler, a replacement ledger, or settlement on the producer's word. |

A package can be transported without Contract, executed by an explicit runner, or registered without being run. None of those operations claims durable settlement. If durable work is required, Contract owns that truth. If the implementation is a Cell, Cell owns its local runtime and manifest. If it fires through Neuron, Neuron owns the committed citations and redrive facts. The dependency direction remains one-way: Neuron must remain standalone and must not import Contract or the Rust host.

## 9. Consumer algorithm

A conforming admission consumer performs this fail-closed sequence:

1. Parse JSON and validate v1 schema; do not coerce YAML scalars or unknown fields.
2. Recompute `/package` canonical digest.
3. Fetch references under caller-provided trust/network policy and verify every digest.
4. Validate unique IDs, dependencies, DAG shape, port/product bindings, scopes, and recursion compatibility.
5. Establish witness/judge independence and ensure external effects have authoritative read-back.
6. Emit `state: prepared`; do not run witnesses during build.
7. Outside this compiler, run node/package witnesses in confinement and have the declared independent judges produce durable verdict references.
8. Require Contract to issue and Ed25519-sign a complete attestation bound to both prepared digests, every witness ID and declared judge, evidence, admission identity/time, and ledger row.
9. Apply that attestation with `AIKO_CONTRACT_VERIFY_KEY` pinned in the sanitized process-bootstrap environment and run `admit`; this command authenticates the complete statement and verifies structure and bindings without executing witnesses.
10. Publish only the resulting `state: admitted` envelope; never infer admission from preparation or registry presence.

Any unsupported executor, unresolved reference, digest mismatch, unknown dependency, cycle, scope escape, exhausted budget, missing evidence, or ambiguous verdict is a refusal.

## 10. Versioning

`api_version` and the media-type version identify this contract. Additive registry indexes do not alter `/package`; changes to package behavior create a new package version and digest. A breaking field or semantic change requires a new `api_version` and schema URI. Cached agents should compare both schema version and subject digest before reuse.
