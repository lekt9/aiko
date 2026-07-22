# Agency substrate release evidence

Date: 2026-07-20
Scope: the local Contract implementation and its committed test/workflow corpus.

## Outcome

Contract now treats improvement as a governed graph of loops while retaining one
resolver and one append-only ledger. Typed actions, sensors, evaluators,
governors, purpose owners, and development proposals share a canonical envelope.
Legacy rows remain explicitly ungoverned and byte-compatible.

The installed production binary was built, installed, signed, and self-verified
through `scripts/build.sh`. The signing phase completed without an interactive
Keychain prompt.

## Metric results

| Metric | Result | Target | Evidence |
|---|---:|---:|---|
| Grounded resolution rate | 100% in typed grounded corpus | 100% | grounded workflow tests; high-reach resolver gate |
| False-green detection | 14/14 scenarios, 100% | ≥95% | `ADVERSARIAL-AGENCY-EVIDENCE.md` |
| Independence inflation | 0 accepted duplicate/derived witnesses | 0 | trust, anchor permutation, and circularity tests |
| Failure propagation latency | same resolver tick in deterministic fixture | <1 tick | `failure.test.fresh bad news…` |
| Reach coverage | 100% of high-risk fixtures gated | 100% | governance tests and executed no-side-effect reach fixture |
| Frozen-rule integrity | 0 unauthorized amendments accepted | 0 | trust and agency authority tests |
| Reversible development | 100% of accepted patch fixtures restore prior graph | 100% | development preview/apply/rollback tests |
| Legacy absorption | supported legacy task/status/declare/build workflows pass | 100% | compatibility workflow and signed build |
| Observability completeness | 10/10 required states encode and render | 100% | event-schema state test and offline renderer |
| Secret leakage | 0 planted marker occurrences in runtime surfaces | 0 | `tools/scan-runtime-secret-leaks.sh` |

The already-satisfied task path measured 2.505 ms and 2.569 ms after causal
observability was enabled. This is a 9.17% mean-median increase over the recorded
baseline, below the 20% guardrail. The 10,000-node graph audit is approximately
4.03 ms. Both graph and task benchmarks have two warm runs within 10% variance;
machine-readable records live in `.benchmarks/`.

## Executed workflows

1. **Legacy checked task:** began and verified a `true` command, then exercised
   its already-satisfied cache and status paths across repeated runs.
2. **Typed storefront declaration:** persisted a schema-v1 action envelope and
   confirmed CLI status exposes role, authority, purpose, cadence, and effect
   scope.
3. **High-reach negative workflow:** declared a typed deployment action whose
   shell command would create `should-not-exist`. With no promotable
   approval/consequence evidence, the resolver emitted
   `hold:reach-governance`; the file was not created.
4. **Grounded storefront failure/recovery:** the committed five-event trace
   connects deployment, browser observation, independent API contradiction,
   rollback, and verified recovery. It renders offline from
   `fixtures/storefront-grounded-trace.jsonl`.

## Verification commands

```sh
cd libcontract && zig build test
cd zig && zig build
BUILD_QUIET_SECONDS=0 ./scripts/build.sh
CONTRACT_BIN="$PWD/scripts/contract" ./tools/audit-readonly-keychain.sh
./tools/scan-runtime-secret-leaks.sh
cd libcontract && zig run src/agency_graph_benchmark.zig -lc
```

The build pipeline reported:

- scripts allowlist guard: pass;
- formatting and tests: pass;
- doctrine/reality parity: 54/54;
- binary signing: pass;
- `verify-self`: pass;
- `verify-self` for the sole `contract` CLI: pass;
- signed smoke declaration: pass.

## Authority boundary

The machinery can validate signatures, topology, temporal validity, reach,
independence, counter-metrics, revocation, and rollback compatibility. External
sensors establish observations. It cannot compute the root purpose or decide
which values deserve to be frozen. Those remain explicit human judgments,
represented by purpose ownership and signed slow-loop authority.

This distinction is intentional: a consistent graph without terminal anchors
is not considered grounded, and a grounded graph still does not manufacture its
own definition of “better.”
