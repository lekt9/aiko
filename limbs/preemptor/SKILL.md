# typed-neuron/preemptor

**Status**: reference generative limb (§30)

Safe preemption proposal: finds exact replay-safe cache candidates.

## What it is

A pure Neuron that receives a stimulus and cached firing records. It proposes an
exact identity match only when the recorded decision is replay-safe. It never
replays effects. The canonical Zig cache independently recomputes the complete
identity and revalidates policy, reachability, and idempotency before reuse.

## Key invariants

- §25: The limb emits an inert candidate record and replays zero effects.
- §30: Learned prediction may rank candidates but cannot become a second cache authority.
- §2: Pure and stateless.

## Conformance

```sh
python3 tests/conformance.py
```
