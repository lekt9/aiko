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
