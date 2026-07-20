# Contract trust layer

Status: implemented and enforced. The pure decision core lives in
`libcontract/src/trust.zig`; canonical ledger encoding, replay, resolver
promotion checks, revocation closure, cache invalidation, and compatible
rollback are active. Agency reach and anchor semantics build on this boundary
without changing legacy row interpretation.

## Purpose

The append-only ledger and signatures prove that a claim, observation, or
verdict was recorded by a particular identity. They do not prove that the
claim corresponds to reality. The trust layer is the promotion boundary that
turns typed observations into a grounded verdict.

No contract may promote through this boundary merely because an action exited
successfully, children marked themselves satisfied, or several wallets repeated
an observation derived from the same source.

## Canonical types

### EvidenceEnvelope

Every observation used for promotion carries:

- `id` and `claim_id`
- `metric_id` and its `primary`, `counter`, or `constraint` role
- `source_kind` and concrete `source_id`
- `evaluator_identity`
- `failure_domain`
- `observed_at` and `expires_at`
- numeric `value`
- zero or more `derivation_ids`
- `active` or `revoked` status
- an Ed25519 evaluator signature binding every field above

The three independence axes are intentionally distinct. Different evaluators
using one source are not independent; different sources hosted in one failure
domain are not independent either. Evidence revocation must be signed by the
same evaluator identity that signed the observation.

### EvaluationPolicy

Every governed promotion carries:

- stable policy and claim IDs
- cryptographically verified policy-owner authority and monotonic version
- builder identity and mandatory builder/evaluator separation
- deployment slot for champion activation and rollback
- whether the policy is frozen against optimizer amendment
- minimum independent witness count
- explicit `counter_veto` arbitration
- primary, counter, and constraint metric rules

A frozen policy can only be amended with an Ed25519 signature from its current
owner. The signature binds every policy field and ordered metric rule. Policy
replacement must preserve a visible version chain; silently substituting an
easier evaluator is forbidden.

## Promotion algorithm

For each evaluation:

1. Require at least one primary, counter, and constraint rule.
2. Reject cycles in evidence derivation, even when the contract DAG is acyclic.
3. Reject malformed, revoked, not-yet-valid, or expired observations.
4. Apply every metric threshold.
5. Reject evidence produced by the builder when evaluator separation is set.
6. For every rule, select witnesses that are pairwise distinct across
   evaluator identity, source ID, and failure domain.
7. Promote only when every rule reaches its independent-witness threshold.

The initial implementation is fail-closed. Missing trust metadata produces
HOLD at the trust boundary; it is not silently treated as legacy evidence.
Legacy contracts remain readable and replayable, but cannot claim a grounded
promotion without new evidence.

## Revocation and rollback

Revocation is append-only:

1. Append an evidence-revoked event identifying the observation and cause.
2. Compute the transitive consumer closure from recorded dependency edges.
3. Append verdict-revoked events for the affected accepted claims.
4. Invalidate their pointer-keyed truth.
5. Suspend their posthooks or mutations.
6. If a prior accepted champion exists under the same policy, restore it;
   otherwise leave the claim in HOLD.

History is never rewritten. Rollback changes the active revision, not the
record of what previously happened. Promotion, activation, and rollback rows
are authority-signed; replay rejects activation history modified after signing.

## Required adversarial tests

- [x] Two evaluator identities reading the same source do not form a quorum.
- [x] Shared failure domains do not form a quorum.
- [x] Circular evidence derivation is rejected.
- [x] Expired evidence is rejected.
- [x] Revoked evidence is rejected.
- [x] Counter-metric regression blocks primary-metric improvement.
- [x] A frozen policy rejects optimizer amendment.
- [x] A signed policy rejects field changes made after signing.
- [x] Signed evidence rejects provenance changes made after signing.
- [x] Evidence rejects revocation signed by a different evaluator.
- [x] A builder cannot act as its own evaluator.
- [x] Revocation closure reaches transitive consumers without duplicates.
- [x] Ledger rows round-trip without losing trust fields.
- [x] Legacy rows remain readable but cannot impersonate trust events.
- [x] Resolver cannot mark a governed contract satisfied without a promotion.
- [x] Revocation invalidates cached downstream truth.
- [x] Rollback restores only a previously accepted compatible policy version.
- [x] Rollback rejects activation history changed after signing.
- [x] Rollback rejects activation signed by a non-owner wallet.
- [x] Builder and evaluator identities cannot collapse when separation is
      required.

## Rollout gates

- [x] Pure schema validation and evaluation module.
- [x] Focused module tests.
- [x] Append-only trust event writers and validators.
- [x] Resolver enforcement.
- [x] Cache invalidation and rollback integration.
- [x] C ABI and MCP exposure over the same implementation.
- [x] Full `zig build test`.
- [x] Doctrine-reality parity claim and build check.

The trust layer is not complete while any unchecked rollout gate remains.
All rollout gates above are currently checked. Future schema changes must
preserve these gates and add equivalent replay, adversarial, and
resolver-enforcement tests.
