# typed-neuron/auto-attacher

**Status**: reference generative limb (§30)

Automatically wires admitted limbs to matching receptor schemas via typed edges.

## What it does

After `admit()` writes the admission artifact, the auto-attacher reads the manifest, extracts receptor schemas, and writes edge manifests to `topology/edges/`. Each edge routes stimuli matching the receptor schema to the admitted limb's neuron.

## Key invariants

- §30.4: A limb receives no ambient authority. The attacher writes edge manifests only — it does not grant caps.
- §26: Edge manifests include source, destination, predicate, delivery_mode, priority, and budget.

## Conformance

```sh
python3 tests/conformance.py
```
