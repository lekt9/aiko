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
