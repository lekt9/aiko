---
name: typed-neuron/pipeline
description: Moves independently-keyed items forward one stage at a time under a declared in-flight budget; fires on a pipeline.stage-request/v1 stimulus, writing one progress artifact per admitted item and leaving the overflow queued for the next firing.
probe_input: {"firing_id":"probe-stage","messages":[],"now_ms":0,"permitted_reads":["pipe-req"],"reads":[{"bytes":"{\"in_flight_budget\":2,\"items\":[{\"key\":\"task-0\",\"payload\":\"work-0\"},{\"key\":\"task-1\",\"payload\":\"work-1\"},{\"key\":\"task-2\",\"payload\":\"work-2\"},{\"key\":\"task-3\",\"payload\":\"work-3\"},{\"key\":\"task-4\",\"payload\":\"work-4\"}],\"stage\":\"build\"}","digest":"b6f6257c761cb19d09500516e5e019348334777b91283f27597a47be2a2382eb","id":"pipe-req","schema":"pipeline.stage-request/v1"}],"receptor_schema":"pipeline.stage-request/v1","schema":"neuron.stimulus/v1"}
expect_contains: processed 2 items in stage build
---

# typed-neuron/pipeline

**Status**: reference generative limb (§30)

A pipeline stage that admits work up to a declared in-flight budget and no
further. Items at earlier stages proceed independently of items at later
stages: the stage name is part of every progress artifact's id, so `build` and
`test` never contend for the same key.

## What it does

`neurons/stage.py` reads one `pipeline.stage-request/v1` — a stage name, a list
of keyed items, and an `in_flight_budget`. It walks the items in stimulus order
and, for each one it can admit under the budget, declares

```
write  artifact/pipeline/<stage>/<key>    (pipeline.progress/v1)
```

Items beyond the budget declare nothing and stay queued for the next firing.
An empty queue settles as `terminate stage:<stage>:drained` — a valid
settlement, not a failure. A budget below 1 is a typed `budget_exhausted`
rejection: the limb fails closed rather than quietly admitting everything.

## Why the acceptance is what it is

The probe hands the stage **five** items with an in-flight budget of **two**.
The declared acceptance is the evidence claim `processed 2 items in stage
build` — the count is derived (`min(len(items), budget)`), not echoed. A stage
that ignored its budget would answer `processed 5 items in stage build` and
fail this acceptance while still writing well-formed progress artifacts, which
is exactly the failure a shape check would miss. The two admitted writes land
at `artifact/pipeline/build/task-0` and `artifact/pipeline/build/task-1`.

Reproduce it directly:

```sh
printf '%s' "<probe_input>" | python3 neurons/stage.py
```

## Key invariants

- **Deterministic.** Same stimulus → same progress writes, so a duplicate
  coordinator is harmless and the firing stays on the recompute path
  (invalidation needs a producer that reaches a fixpoint).
- **Grounded.** Every decision cites the stimulus reads it folded; an uncited
  read is a dependency that does not exist as far as staleness is concerned.
- **Budget is policy, not kernel.** The in-flight ceiling arrives in the
  request; the interpreter enforces only the capability grant declared in
  `neuron.json` (`artifact/pipeline/` writes, no sends, no spawns).

## Conformance

```sh
python3 tests/conformance.py
```

Admits the package, fires through the admitted path, and asserts the budget
split (4 of 6, then the remaining 2, then drained), stage independence, the
fail-closed budget rejection, and the revoke → detach → GC lifecycle.
