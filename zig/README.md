# contract-zig

Native Zig CLI for the Contract substrate. It writes signed append-only intent
and verdict rows, resolves contract graphs, exposes task/role status, and emits a
schema-v1 causal event stream. Typed declarations may carry one of six governed
agency roles: purpose, governor, action, sensor, evaluator, or development.

The CLI preserves the legacy row shape for untyped declarations while adding
typed agency envelopes, reach decisions, evidence/anchor checks, failure
propagation, and attributable graph development. Read-only inspection
(`help`, `status`, `task status`, `events`, `watch`, and `explain`) stays outside
wallet and Keychain paths.

Ledger discovery is deterministic and does not read a `CONTRACTS_STORE`
environment override:

1. `<cwd>/.claude/contracts.jsonl`
2. `~/.contracts/contracts.jsonl`

Build from this directory with `zig build`; the binary is written to
`zig-out/bin/contract-zig`. The repository release gate is
`../scripts/build.sh`.
