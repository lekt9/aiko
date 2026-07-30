# typed-neuron/auto-attacher

**Status**: reference generative limb (§30)

Automatically wires admitted limbs to matching receptor schemas via typed edges.

## What it does

After `admit()` atomically writes the admission artifact and event, the
auto-attacher reads the immutable manifest and writes edge manifests to
`topology/edges/` for each explicit per-Neuron `accepts` schema. It never
infers an interface from schema names.

## Key invariants

- §30.4: A limb receives no ambient authority. The attacher writes edge manifests only — it does not grant caps.
- §26: Edge manifests include source, destination, predicate, delivery_mode, priority, and budget.
- §9: Missing explicit `accepts` means the Neuron is not auto-attached.

## Conformance

```sh
python3 tests/conformance.py
```
