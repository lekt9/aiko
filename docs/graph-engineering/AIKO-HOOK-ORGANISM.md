# Aiko hook organism covenant

Status: **implemented native ingress and hermetic provider path; not a claim of
live Cloudflare/provider deployment**. The native Rust `VerifiedIngress`, shared
Contract choke, and public composition faces are implemented. The Cloudflare
Worker raw-byte verification and Gateway path are implemented and tested
hermetically. No scoped provider credentials were supplied, so no live deployment
or provider read-back is claimed. This document deliberately adds no ledger
beside Contract.

## Authority enters once

Only a transport authentication boundary may construct `VerifiedIngress`, and it
must do so after checking the original transport bytes and credentials. Its
closed fields are: authenticated subject, verified tenant, transport and
intended audience, granted scopes, SHA-256 digest of the canonical request
bytes, provider nonce/idempotency namespace and key, and verification evidence
(key/credential generation plus verifier and signature result). Downstream code
may narrow this object but may neither manufacture nor widen it.

`HookEventEnvelope` is an invocation-format DTO, not an authority object. Any
caller-supplied tenant, role, Contract root/parent/occurrence, account, endpoint,
or requested effect in it is an **untrusted hint** until joined to
`VerifiedIngress` and a Contract declaration. `sessionId`, `timestamp`,
`transcriptPath`, `cwd`, and `workspaceRoot` are likewise narrative/context;
they grant nothing.

This follows the existing refusal rather than inventing a second truth system:
`contract/libcontract/src/w6h.zig` makes who/what/when/where/why/how a checked
projection, while `contract/libcontract/src/event_schema.zig` describes its
causal events as redacted control/evidence records. The current Rust
`HookEventEnvelope` in `aiko/crates/codegen/xai-grok-hooks/src/event.rs` does
carry timestamp/transcript/session metadata. That is evidence for why it must
not be treated as verified ingress.

## Identities that must never collapse

| Identity | Source and purpose |
|---|---|
| principal | authenticated subject plus credential generation |
| tenant | verified tenant, independent of principal |
| Contract lineage | root, parent, and occurrence are three distinct values |
| execution | execution, run, and session remain distinct |
| lease | lease id plus monotonic fence |
| firing | immutable firing id |
| logical effect | stable effect id used for read-back/idempotence |
| credential generation | pins the verifier/key generation used at admission |

Canonical Contract hook occurrence identity is
`SHA256(verified nonce namespace || idempotency key || Contract root)`.
The payload digest is pinned separately. Thus an identical verified tuple and
digest is replay; the same namespace/key/root with different raw bytes,
authenticated subject, tenant, audience, scope set, credential generation, or
endpoint generation is a conflict—not a new occurrence and never a replay.
Timestamps are journal facts only. They do not participate in identity,
authority, nonce choice, or replay classification.

For webhooks, verify the signature against the **raw received body bytes**, not
parsed or reserialized JSON. Bind admission to endpoint generation, verified
tenant and principal, provider namespace, provider delivery id, raw-body
digest, audience, scopes, and credential generation. Endpoint IDs are allocated
or adopted as the output of an authorized Contract occurrence; callers cannot
choose them. This prevents changed-body and cross-endpoint replay.

## Choke points and ordering

The only allowed critical order is:

1. normalize/confine
2. authenticate (emit `VerifiedIngress`)
3. declare/adopt Contract occurrence
4. scope/authorize
5. acquire fenced lease
6. invoke
7. independent read-back/evidence
8. settle or invalidate

Contract declaration/projection, authority, and effect hooks are synchronous
and fail closed. If any mandatory projection, authentication, authorization,
lease, invocation admission, or evidence/read-back step fails, no launch or
settlement follows. Only observational telemetry hooks may fail open. The
current `dispatcher.rs` explicitly makes `pre_tool_use` hook failures fail open;
therefore that dispatcher is observational/protected-environment compatibility
machinery and **must not be reused as a critical authority/effect choke point**.

Cloudflare endpoint creation, deployment, promotion, and credential rotation
are effects. Each requires an authorized Contract occurrence whose verified
principal has the deployment scope, whose verified tenant/account/audience and
artifact digest are pinned, and whose provider read-back is cited before
settlement. A prompt can request this occurrence; prompt text alone supplies no
ambient Cloudflare account, endpoint, or deployment authority.

## Projection, not new ledgers

There is no `HookOccurrence` ledger and no `ContextEnvelope` ledger. A hook is
projected into existing Contract declaration/occurrence/evidence rows. Context
is a bounded **Contract read projection** reconstructed from those rows and
citations; it is not appended as a second source of truth. Transcripts and
payloads stay outside the causal event schema; only digests/evidence references
are pinned. This is consistent with `event_schema.zig`, whose stated schema
excludes prompts, payloads, credentials, and environment values.

## Hermetic versus live claim

The gate below separates four claims instead of treating implementation as one
boolean. It compiles the production Rust crates and inspects the checked-in
modules which implement `VerifiedIngress`, the shared synchronous Contract
choke, and the CLI/headless/ACP/MCP/plugin/Gateway/webhook/cron composition
faces. It also inspects the Cloudflare Worker path that preserves raw bytes
through signature verification and queues only verified ingress to the fixed
Gateway audience; that provider path is exercised with hermetic bindings.

Those facts do **not** prove a live deployment. The gate makes no provider API
call, consumes no real credential, and cites no deployed-Worker or provider
read-back receipt. Without explicitly supplied scoped Cloudflare/provider
credentials, authorized live deployment remains absent and must fail closed as
a capability gap. A future live claim requires an authorized Contract
occurrence, scoped credentials, immutable deployment receipt, and independent
provider read-back evidence. `HookEventEnvelope` remains an untrusted stimulus,
and Contract remains the only ledger in every status.

## Machine-readable covenant fixture

The gate treats this block as policy, not marketing prose, then deliberately
mutates it to prove each forbidden weakening is rejected.

```json covenant-v1
{
  "version": 1,
  "verified_ingress": {
    "exclusive_emitters": ["transport_auth_boundary"],
    "fields": ["authenticated_subject", "verified_tenant", "transport", "audience", "granted_scopes", "canonical_request_digest", "nonce_namespace", "idempotency_key", "verification_evidence", "credential_generation"],
    "envelope_hints_untrusted": ["tenant", "role", "contract_root", "contract_parent", "contract_occurrence", "account", "endpoint_id", "effect"]
  },
  "identity": {
    "dimensions": ["principal", "tenant", "contract_root", "contract_parent", "contract_occurrence", "execution", "run", "session", "lease", "lease_fence", "firing", "logical_effect", "credential_generation"],
    "occurrence_tuple": ["nonce_namespace", "idempotency_key", "contract_root"],
    "payload_digest_separate": true,
    "timestamps_in_identity": false
  },
  "webhook": {
    "signature_bytes": "raw_received_body",
    "binding": ["endpoint_generation", "verified_tenant", "authenticated_subject", "provider_namespace", "delivery_id", "raw_body_digest", "audience", "granted_scopes", "credential_generation"],
    "same_tuple_same_digest": "replay",
    "same_tuple_changed_bytes_or_authority": "conflict",
    "endpoint_id_source": "authorized_contract_occurrence_output"
  },
  "hooks": {
    "critical": ["contract_declaration_projection", "authority", "effect"],
    "critical_failure": "fail_closed_no_launch",
    "fail_open": ["observational"]
  },
  "order": ["normalize_confine", "authenticate", "declare_adopt", "scope_authorize", "lease", "invoke", "read_back_evidence", "settle_invalidate"],
  "storage": {
    "durable_rows": ["ContractDeclaration", "ContractOccurrence", "ContractEvidence"],
    "forbidden_ledgers": ["HookOccurrence", "ContextEnvelope"],
    "context": "contract_read_projection"
  },
  "cloudflare": {
    "deployment_authority": "authorized_contract_occurrence",
    "required_scope": "cloudflare.deploy",
    "pins": ["verified_tenant", "account", "audience", "artifact_digest", "endpoint_generation"],
    "settlement": "provider_read_back_evidence",
    "prompt_only_authority": false,
    "caller_chosen_endpoint_id": false
  },
  "claims": {
    "hermetic_gate": true,
    "native_verified_ingress_shared_choke": "implemented",
    "public_rust_composition_faces": "implemented",
    "provider_worker_raw_byte_path": "hermetic_implemented",
    "authorized_live_cloudflare_provider_deployment": "absent_without_scoped_credentials",
    "live_missing": ["scoped_provider_credentials", "authorized_cloudflare_deployment_receipt", "provider_read_back_evidence"]
  }
}
```
