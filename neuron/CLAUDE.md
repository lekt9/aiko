# CLAUDE.md — working instructions for this repo

This directory is the Neuron layer of the published Aiko monorepo
([`github.com/lekt9/aiko`](https://github.com/lekt9/aiko)). Inventory:
[`../docs/SOURCE-OF-TRUTH.md`](../docs/SOURCE-OF-TRUTH.md). From the monorepo
root, `zig build` installs this CLI as `zig-out/bin/aiko`. Building **here**
must still succeed without `../contract`.

Typed Neuron: a fail-closed runtime for typed agent workflows, in Zig 0.16.

`AGENTS.md` (~85KB) is the **normative spec**, not session context. Read the
section you need, not the file. This file is the session context.

## Build and verify

```sh
zig build                       # binary at ./zig-out/bin/neuron
zig build test                  # unit suite (in-memory substrates)
bash tests/<name>-gate.sh       # one runnable witness
bash tests/gate.sh              # master gate (also runs JESPA benchmarks)
python3 tests/check_agents.py   # AGENTS.md conformance
```

**Gates are the acceptance criterion, not the unit tests.** Each
`tests/*-gate.sh` drives the public CLI from an empty directory and asserts
against durable state — never stdout resemblance. If you change behaviour,
the gate is what proves it. Never write a gate that can pass without the
feature working.

## The single commit path

Everything — agent, limb, interface, swarm, MCP, mesh — funnels into
`Runtime.execute` (`src/runtime.zig`). `journalCommit` has exactly one caller.
If you add a way to change durable state that bypasses it, that is a bug.

`src/wire.zig` is the canonical package, exported as `typed_neuron`;
`src/types.zig` is only aliases. Effects are `write | send | spawn` — three,
and adding a fourth is a spec change, not an implementation detail.

## Traps that have cost real time

- **`now_ms` is inside the firing identity.** `cborRuntimeStimulus` hashes it
  into the decision digest, so a wall clock in a stimulus makes every
  redelivery a new identity and turns idempotent replay into `FiringMismatch`.
  The `now_ms = 0` in `agent_ops.zig` is load-bearing. Timing goes on the
  journal record (`committed_at_ms`), outside identity.
- **Numbered subsections in AGENTS.md need catalog rows.** Adding a normative
  `§N.M` requires a matching `| §N.M | SMP-XX, … |` row in
  `reference/SUPER_META_PATTERNS.md`, or `check_agents.py` fails closed.
- **Zig 0.16 has no `std.time.milliTimestamp`.** Use
  `std.Io.Timestamp.now(io, .real).nanoseconds` and divide by
  `std.time.ns_per_ms`. Most of this codebase is duration-based
  (`.clock = .boot`); a wall clock is rare and should stay rare.
- **The codedb hook blocks `grep`/`find`/`head` in this tree.** Use the
  `codedb_*` tools, or prefix with `CODEDB_NO_HOOKS=1` for one-offs.
- **Policy rejections print a Zig stack trace.** A budget or capability
  refusal is correct behaviour, but it looks like a crash on stderr. Check the
  error name before assuming breakage.
- **`neuron compact` drops per-commit records**, so `telemetry trace` and
  `telemetry stale` see only the un-compacted tail.

## Observability

```sh
neuron telemetry project <state_dir> --json   # aggregate counters
neuron telemetry trace   <state_dir> --json   # per firing: when, cited, wrote
neuron telemetry stale   <state_dir> --json   # derivations whose sources moved
```

`stale` reconstructs the derivation graph from `produced_by` plus
`evidence[].sources`. Its `redrivable` flag is the re-derivation gate: a firing
disqualifies itself by sending to `outbox/` (repeating an external boundary
crossing repeats a real effect). Internal `event/` and `neuron/` traffic
re-derives safely. Detection is separate from action — these projections mark
nothing and re-fire nothing.

## House style

Match the surrounding code. Comments here explain *why a refusal exists*, not
what a line does — keep that. Prefer failing closed over degrading. Do not
report work as done without running its gate.
