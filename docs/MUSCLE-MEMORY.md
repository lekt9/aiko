# Binary muscle memory

Contract ABI v4+ adds a native usage-learning loop. It does not pretend that the
embedded router is a general reasoner. The host supplies sanitized state descriptions
and an externally grounded reward after a real binary invocation.

```text
goal + machine state
        |
        v
context EBM recalls a binary
transition JEPA predicts its state delta
        |
        v
host executes the real binary
        |
        v
external sensor/evaluator supplies reward
        |
        +--> binary context prototype
        +--> binary transition-delta weights
```

The native calls are:

- `contract_muscle_observe(context, binary, before, after, reward)`
- `contract_muscle_recall(context)`
- `contract_muscle_predict(before, target)`

The existing append-only capability outcome ledger remains the durable cross-process
context-to-binary memory. ABI v4+'s muscle bank is the hot in-process transition model.
Only externally verified outcomes should receive positive reward. Activity, visual
change, command exit, or child self-report alone are not sufficient evidence.

## Fractal composition

`muscle.schedule` expands a root pointer recursively into topological waves:

```text
root
 |-- inspect ----+
 |-- test -------+-- run together
 `-- judge (after inspect + test)
       `-- report (after judge)
```

Expansion rejects pointer cycles, dependency cycles, excessive depth, and excessive
fan-out. Nodes in one wave are dependency-independent and may run concurrently. A
parent receives positive feedback only when every child has a grounded successful
outcome; an unknown child keeps it neutral and a failed child inhibits it.

This gives pointers recursive composition without allowing unbounded self-spawning or
circular self-confirmation.
