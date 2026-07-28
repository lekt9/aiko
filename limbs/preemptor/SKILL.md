# typed-neuron/preemptor

**Status**: reference generative limb (§30)

Predictive preemption: short-circuits firings equivalent to cached decisions.

## What it is

A pure Neuron that receives a stimulus and a set of cached firing records. It computes a stimulus fingerprint and checks for high-confidence matches against cached firings. If a match is found and the cached decision is replay-safe (no `send` or `spawn` effects), it returns `preempted` with the cached decision's effects.

## Key invariants

- §25: Cache reuse never replays non-idempotent external effects. Only `write` effects to stable prefixes are eligible. `send` and `spawn` effects are never preempted.
- §30: The preemptor is a limb, not a kernel feature. It proposes preemption; the runtime still validates.
- §2: Pure and stateless.

## Conformance

```sh
python3 tests/conformance.py
```
