---
name: typed-neuron/introspection-trigger
description: 'Counts settled firings and fires the introspection limb when the count reaches the cadence (default 50) or a cited energy score crosses 0.7; fires on every neuron.firing-settled/v1 event.'
probe_input: '{"schema":"neuron.stimulus/v1","firing_id":"probe-t1","receptor_schema":"neuron.firing-settled/v1","now_ms":0,"reads":[{"id":"introspection-trigger/state","schema":"neuron.introspection-trigger-state/v1","bytes":"{\"cadence\":50,\"firings_since_introspection\":5,\"last_introspection_ms\":0,\"no_proposal_streak\":0,\"schema\":\"neuron.introspection-trigger-state/v1\"}","digest":"1e956df35a768b1a52d322d6963a2d676fd168279033e87af5d6dcff3428b247"},{"id":"energy-1","schema":"energy.score/v1","bytes":"{\"energy\":0.85}","digest":"44ecd6de056e2200bed359d98311c5dfa0f2ab63c896482e51f6a46cede22e48"}],"permitted_reads":["introspection-trigger/state","energy-1"],"messages":[]}'
expect_contains: '{"kind":"send","message":{"durable":true,"payload":"{\"energy_score\":0.85,\"firings_since_last\":6,\"schema\":\"neuron.introspection-trigger-fire/v1\",\"trigger\":\"energy\",\"triggered_at_ms\":0}","schema":"neuron.introspection-trigger-fire/v1","to":"neuron/introspection/inspector"}}'
---

# typed-neuron/introspection-trigger

**Status**: reference generative limb (§30)

Reactive trigger that fires the introspection limb on a firing-count cadence or energy threshold.

## What it does

Fires on every `firing-settled` event. Counts firings since last introspection. If the count reaches the cadence (default 50) or energy exceeds a threshold (default 0.7), sends a message to `neuron/introspection/inspector` and resets the counter. Cadence adapts: doubles when no proposals are generated for 3 consecutive runs, halves when proposals are active.

## Key invariants

- §8: An incoming event becomes a stimulus that causes Neurons to fire.
- §26: The counter is the monotonic progress measure. The cadence is the bound.

## Conformance

```sh
python3 tests/conformance.py
```
