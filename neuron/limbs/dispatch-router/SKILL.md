---
name: typed-neuron/dispatch-router
description: Energy-minimizing dispatch — scores every admitted limb matching a receptor schema against the model path by structural energy and routes the stimulus to the lowest-energy candidate. Fires on a neuron.dispatch-request/v1 whenever a receptor could be served either by an admitted limb or by falling through to the model.
probe_input: {"schema":"neuron.stimulus/v1","firing_id":"probe-1","receptor_schema":"test.echo/v1","reads":[{"id":"edge-0","schema":"neuron.edge-manifest/v1","digest":"0","bytes":"{\"source\":\"receptor/other.schema/v1\",\"destination\":\"neuron/limb/decoy0/neuron-9\",\"admission_digest\":\"decoy0\"}"},{"id":"edge-1","schema":"neuron.edge-manifest/v1","digest":"1","bytes":"{\"source\":\"receptor/test.echo/v1\",\"destination\":\"neuron/limb/abc123/neuron-1\",\"admission_digest\":\"abc123\"}"}],"messages":[]}
expect_contains: dispatched to limb neuron/limb/abc123/neuron-1: energy 0.8 < model 10.0
---

# typed-neuron/dispatch-router

**Status**: reference generative limb (§30)

Energy-minimizing dispatch: scores admitted limbs + model path by structural energy, fires the lowest-energy candidate.

## What it does

Before falling through to the model, the dispatch-router scores all admitted limbs matching the receptor schema using the `firingEnergy` function. The model path always has energy ≥ 2.0 (no grounding, highest cost). Any matched limb with grounding and confidence has energy ≤ 1.0. The lowest-energy candidate wins.

## Key invariants

- §30.5: The dispatcher sends a message that the topology routes to the limb. It doesn't fire the limb directly.
- §25: The dispatcher's decision is itself a firing, recorded in the substrate. Future dispatches can be preempted.

## Conformance

```sh
python3 tests/conformance.py
```
