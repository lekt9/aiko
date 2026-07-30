# Outbox drainer prototype

Status: partial; not a complete admitted Skill

This directory contains policy Neurons and host plumbing for draining queued
messages through named adapters without moving retry policy into the kernel.

## Present

- `neurons/drainer.py` selects eligible messages from a narrow queued-message
  projection and returns send plus delivery-attempt effects.
- `neurons/reconciler.py` turns adapter acknowledgement or fresh provider
  evidence into an acknowledged, retryable, dead-letter, or
  `reconciliation_required` record.
- `driver.py` folds an append-only JSONL state root, fires the decision scripts
  through `neuron run`, invokes a prefix-matched adapter, and feeds the result
  back to the reconciler.
- `tests/mock_adapter.py` models acknowledged, retryable, permanent, and
  uncertain provider outcomes.

Adapters own credentials. The driver passes only the declared envelope on
stdin. Unknown adapter exits are treated as uncertain, not success.

## Current status (reference policy core delivered)

The package now contains:

- `neuron.json` (manifest for `neuron run --def`)
- `neurons/drainer.py` + `neurons/reconciler.py` (pure policy neurons)
- Versioned schemas for the six outbox types referenced in the code
- `driver.py` + `tests/mock_adapter.py`
- `tests/conformance.py` (runnable witness that creates its own fixtures)

The policy neurons produce correct grounded decisions for the core flows
(drainer writes attempts + sends; reconciler settles acks, retryables, dead-letters,
and reconciliation cases). The witness passes:

```
python3 limbs/outbox-drainer/tests/conformance.py
# → outbox-drainer conformance (policy core): PASS
```

## What remains explicit (not claimed)

- Full end-to-end driver + harness round-trip for all outcome classes (there is
  a remaining effect-shape compatibility gap on certain continue+send paths).
- Complete generative-limb lifecycle: admit by digest, attach via typed edge,
  operate, judge, revoke, detach, garbage-collect.
- Use as a reusable component in production outbox scenarios (Contract/Aiko
  canonical path remains the current production mechanism).

See `../../reference/ROADMAP.md` (R1) for the precise remaining checklist.
The production outbox path is Contract + Aiko; this is the reusable limb
prototype.
