# Agency substrate baseline

> Historical pre-implementation snapshot. The gaps below describe the starting
> state, not the released state. See
> [AGENCY-SUBSTRATE-RELEASE-EVIDENCE.md](AGENCY-SUBSTRATE-RELEASE-EVIDENCE.md)
> for completed behavior and current metrics.

Captured: 2026-07-20
Machine-readable measurements: [`.benchmarks/agency-substrate-baseline.json`](../.benchmarks/agency-substrate-baseline.json)

## Repository state

This effort begins in a dirty working tree. Those changes predate the agency-role work and are treated as user-owned:

- a substantial trust layer in `libcontract/src/trust.zig`;
- resolver, C ABI, MCP, lineage, routing, doctrine, and documentation changes;
- generated binaries and signatures;
- benchmark, trace, and research artifacts.

No baseline step resets, discards, or rewrites those changes.

## Existing capabilities proven by source and tests

| Capability | Authority | Baseline evidence |
|---|---|---|
| Append-only local ledger | `ledger.zig` | included in full build |
| Deterministic declaration/cache key | `contract.zig` | source + contract tests |
| Typed dependency synapses | `contract.zig` | pointer tests |
| Identity, lineage, signatures | `lineage.zig` | round-trip and rotation tests |
| Capability grants | `capability.zig` | signed authorization tests |
| Primary/counter/constraint rules | `trust.zig` | Goodhart veto tests |
| Independence across evaluator/source/failure domain | `trust.zig` | shared-source/domain tests |
| Frozen policy ownership | `trust.zig` | amendment/signature tests |
| Temporal validity and revocation | `trust.zig` | stale/revoked replay tests |
| Circular provenance detection | `trust.zig` | derivation-cycle test |
| Promotion, activation, rollback | `trust.zig`, `contract.zig` | signed history and champion tests |
| Resolver trust enforcement | `zig/src/main.zig` | full build and trust documentation |
| C ABI trust verdict | `c_abi.zig` | ABI tests |
| MCP trust surface | `mcp_server.zig` | full build |
| Operational activity log | `activity_log.zig` | sanitizer test; plain-text events |
| Read-only CLI without Keychain interaction | built binary | observed help/status invocation |

## Known missing or incomplete capabilities

- No typed six-role node envelope in persisted declarations.
- Generic evidence does not yet prove terminal reality-anchor semantics.
- Actions do not declare effect reach with consequence-sensor coverage.
- Cadence and target ownership are not enforced as graph policy.
- Negative evidence has trust revocation paths but no unified priority event model.
- Topology development is not represented as an atomic reversible proposal.
- Activity logs lack stable JSON schema, causal edges, watch/explain, and graph rendering.
- Legacy migration has trust compatibility but no agency-role shadow/absorption report.
- Keychain prompt behavior lacks an automated read-only regression harness.

## Performance baseline

The complete `libcontract` suite passed once cold in 143.36 seconds. Two warm runs passed in 35.166 and 35.102 seconds, a 0.18% difference, satisfying the Phase 0 reproducibility requirement for the full-suite baseline.

The first cold run is retained because it describes developer experience; the
warm median is the guardrail reference for semantic changes. The isolated
already-satisfied task/cache path now measures 2.391 ms and 2.257 ms across two
25-round runs (5.60% variance). Status-by-id measures 2.403 ms and 2.304 ms
(4.12%). The linear agency graph audit measures 0.476–0.490 ms at 1,000 nodes
and 4.028–4.030 ms at 10,000 nodes. Machine-readable results are in
`.benchmarks/task-readonly-runtime.json` and
`.benchmarks/agency-graph-audit.json`.

## Compatibility matrix

| Surface | Must remain compatible | Baseline |
|---|---|---|
| `aiko "<goal>" [--private]` | public declaration persona | present |
| `contract declare` | legacy untyped declaration | present |
| `contract task begin/status/verify` | check-backed task workflow | present |
| `contract status` | ledger inspection | present |
| `contract tick` | resolver and schedules | present |
| `contract recommend` | learned routing | present |
| `contract import-root` | Keychain root import | present |
| Legacy JSONL rows | byte-readable without migration | present |
| ABI v2 symbols | existing callers | present |
| MCP tools | existing names and schemas | present |

New agency functionality must be additive during the bridge. An untyped declaration must continue to use the v2 cache key and legacy row shape.

## Executable invariants

The implementation must turn these into tests:

1. A role-bearing row uses a distinct cache key from an otherwise identical legacy row.
2. An operational node cannot amend its own evaluator, governor, or target.
3. A grounded resolution terminates in a non-ledger reality anchor.
4. Shared source, failure domain, or copied observation remains one witness.
5. High-risk effect scope requires a consequence sensor and explicit approval.
6. Fresh contradiction outranks cached satisfaction.
7. Purpose/frozen-policy changes require slower explicit authority.
8. A topology patch is previewable, atomic, and reversible.
9. Read-only status/watch/explain never requests a signing key.
10. Secret fixtures never appear in ledger, activity events, traces, or rendered HTML.

## Phase 0 status

- Existing suite: passed.
- Reproducible warm baseline: passed.
- Compatibility inventory: captured.
- Preexisting changes: documented and preserved.
- Isolated status/task-cache benchmarks: passed twice within 10%.
- 1/100/1k/10k graph audit: passed twice within 10%.
- Automated read-only Keychain fixture: passed.
- Runtime secret fixture scanner: passed.
