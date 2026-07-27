# Typed Neuron roadmap

Status: unsettled work as of 2026-07-27

`AGENTS.md` defines the target. `IMPLEMENTATION.md` records what exists. This
file contains only gaps that still need a runnable witness. Implementation
antipatterns found in review on 2026-07-27 are planned in
`reference/ANTIPATTERN_REMEDIATION.md` (durable substrate, per-peer ceilings,
wire symmetry, clock honesty, bounded reads, typed proxy payload, hygiene).

## Settled since the previous roadmap

The following items are implemented and must not be planned again:

- Script-Neuron deadlines are enforced by the interpreter. A hung child is
  killed, recorded as `timed_out`, and commits no effects.
- The standalone runtime imports all canonical runtime types and identity
  algorithms from `typed_neuron`; it no longer owns a parallel contract.
- The transport schema generates Zig and Rust codecs, fixed vectors, and a
  Contract content lock.
- Production Aiko returns a canonical decision at node settlement.
- Contract atomically appends canonical firing, authoritative evidence, node
  settlement, and pending outbox effects in one transaction.
- Aiko admits consequential tool effects before adapter dispatch and settles
  the exact outbox effect afterward.
- The reference Meta-Agent demonstrates generated-limb admission, attachment,
  operation, judgment, retirement, and garbage collection.

These claims are gated by `tests/runtime-gate.sh`,
`tests/meta-agent-gate.sh`, and `tests/check-production-neuron.sh`.

## R1. Complete the outbox-drainer limb

Status: reference policy core + manifest + full-driver conformance witness delivered; generative-limb lifecycle (admit/attach/operate/judge/retire) remains explicit.

`limbs/outbox-drainer/` now contains:

- `neuron.json` (manifest consumable by `neuron run --def`)
- `neurons/drainer.py` and `neurons/reconciler.py` (pure policy neurons)
- Versioned schemas for all six outbox types used by the code:
  `outbox.drain-request/v1`, `outbox.queued-messages/v1`,
  `outbox.delivery-attempt/v1`, `outbox.delivery-record/v1`,
  `outbox.ack/v1`, `outbox.settle-request/v1`
- `driver.py` + `tests/mock_adapter.py`
- `tests/conformance.py` (runnable witness that creates its own fixtures and drives the full driver + harness path)

The policy neurons produce correct grounded decisions for the core flows
(drainer emits attempt records + sends; reconciler settles acks, retryables,
permanents, and reconciliation cases).

Current status (fresh evidence 2026-07-27):

The full driver + manifest + neuron round-trip now succeeds for the core
outcome classes when exercised end-to-end via the checked-in manifest:

- ack → acknowledged
- permanent → dead_letter
- retryable → dead_letter (after max attempts)
- uncertain → reconciliation_required + fresh reconcile settles to acknowledged

Reproducible witness (single command, creates temp fixtures, uses real manifest + adapter override + reconciler):

```
python3 limbs/outbox-drainer/tests/conformance.py
# → outbox-drainer full-driver conformance: PASS
# drain statuses: { ... 'acknowledged', ... 'dead_letter', ... 'reconciliation_required' }
# reconciler settled the uncertain case
```

Gate evidence:
- `python3 limbs/outbox-drainer/tests/conformance.py` → exit 0
- `python3 tests/check_agents.py` → PASS
- `bash tests/gate.sh` → agents PASS + jespa WIN reproduced + neuron PASS

Remaining work (do not claim settled):

- Complete generative-limb lifecycle witness: admit by digest, attach via
  typed edge with narrow grant, operate through ordinary firings, judge,
  revoke, detach, and garbage-collect.
- Honest benchmark / conformance rows that cover duplicate suppression,
  bounded retry, dead-letter, uncertain delivery, fresh reconciliation, and
  secret absence under the admitted-limb path (not only the driver script).
- Integration of the limb as a reusable component for production outbox
  scenarios (the Contract/Aiko canonical path remains the current production
  mechanism).

The reusable policy core, manifest, driver, and a single-command full-driver
conformance witness now exist. The package is no longer "missing the manifest
and conformance suite". The "admitted standalone limb that replaces production
outbox" claim is not yet witnessed.

## R2. Turn the energy router into an admitted limb

Status: reference generative limb package delivered (Python path via `neuron run --def`); remaining integration work explicit.

`limbs/energy-router/` now contains a complete reference Skill package:

- `neuron.json` (manifest consumable by the harness)
- `SKILL.md`
- `neurons/energy_router.py` (main Neuron: `firingEnergy` scoring + `EnergyScore` write + conditional spawn of sub-EBM)
- `neurons/registry_lookup.py` (EBM-ranked discovery over `PackageOffer` + `Candidate`)
- versioned schemas: `energy.candidate/v1`, `energy.score/v1`, `energy.package-offer/v1`, `energy.usage/v1`, `energy.settlement-claim/v1`
- `index/seed.json` (tiny publishable public index seed)
- `examples/route_request.json`
- Pure scorers (`scorer.py`, `energy.zig`) remain for cross-language fidelity

Harness witness (real validate + commit):

```
neuron run --def limbs/energy-router/neuron.json --neuron energy-router \
  --stimulus limbs/energy-router/examples/route_request.json --json
# → {"status":"committed", "effects_committed":1, "artifacts":1, "digest":"..."}
```

The package supports the EBM-native public paid commons shape:
- lowest-energy routing + explicit sub-EBM spawn for unresolved work
- `PackageOffer` + price + energy witnesses for discovery
- `UsageRecord` + `SettlementClaim` as normal effects

Completion work that remains (do not claim settled):

1. Wire `registry-lookup` + EnergyRouter into the reference meta-agent router slot (currently still uses FixedNeuron stubs).
2. Full end-to-end benchmark deltas on held-out settlement tasks (energy reduction + settlement speed) with honest negatives in the ledger.
3. Zig `EnergyRouterNeuron` (src/energy_router.zig) promoted to first-class build-integrated path with allocator safety and the same schemas.
4. A Registry Neuron that can actually read remote indexes over the mesh + a live admission + attach + remote stimulation + payment flow witness.
5. Clean revoke/detach + garbage collection exercised on this specific limb.

The limb is a real, runnable, documented reference. It is not yet "the" production router inside the meta-agent, nor has it produced published benchmark wins. The package itself is the settled lever.

## R3. Reusable fan-out and pipeline limbs

Status: not implemented as packages

The runtime already has spawn budgets, joins, partitions, and progress guards.
Reusable `fanout` and `pipeline` packages remain absent.

The fan-out limb should use deterministic child identities, narrowed
delegations, a parameterized quorum join, and a deterministic reducer. The
pipeline limb should keep independently keyed items moving between ordinary
stage Neurons with a declared in-flight budget.

Required witnesses:

- duplicate coordinator delivery does not duplicate children;
- a rejecting child is contained according to the declared quorum;
- an item can reach a later pipeline stage while another remains earlier;
- fan-out, depth, and in-flight limits fail closed;
- both packages can be admitted, attached, exercised, and retired without
  kernel changes.

## R4. Closed telemetry and policy-advisor loop

Status: metrics exist; closed loop does not

`src/observability.zig` exposes metrics and replay, but no admitted limb
projects firing records into durable rollups and proposes governed topology or
grant changes.

Completion requires:

- a narrow, versioned firing-record projection;
- deterministic per-graph rollup artifacts;
- an advisor that emits inert topology/grant proposals within its Caps;
- independent admission or human approval for high-impact changes;
- a witness that an admitted proposal changes a later dispatch;
- proof that no feedback path mutates historical firing records.

The loop must be receptor-driven by new record digests and expose monotonic
progress. It may not be an unbounded polling loop.

## R5. Reproducible source dependency pin

Status: content-pinned locally, not revision-pinned

Contract checks `typed-neuron.lock.json` against the sibling package content.
That prevents silent local drift, but the Neuron directory is not currently an
independent Git repository, so there is no immutable upstream revision pin.

Completion requires choosing a reproducible distribution boundary—an
independent repository, vendored release artifact, or monorepo revision—and
making the content lock derivable from that immutable source. The existing
generated-binding and compatibility-vector checks must remain.

## R6. Standalone durability and isolation

Status: intentionally outside the reference runtime

The standalone interpreter is in-memory. A production-grade alternative would
need crash-safe transactions, multi-process concurrency, schema migration,
outbox recovery, and platform sandbox enforcement. Contract/Aiko already
supply the current production profile; do not duplicate them without a
specific deployment need.

If a second durable adapter is built, it must import the same canonical module
or generated schema, pass the production drift guard, and publish its own
atomicity/crash/reconciliation witnesses.

## Priority order

1. Complete the outbox-drainer package because it converts an existing partial
   prototype into a reusable limb.
2. Package and benchmark the energy router honestly.
3. Add reusable fan-out/pipeline limbs.
4. Close the telemetry/advisor loop.
5. Establish an immutable source distribution pin when repository ownership is
   decided.

Every item settles through a runnable witness. File presence, prose, and a
green document validator are not completion.
