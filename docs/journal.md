# Substrate benchmark journal

Goal: measure the contract substrate honestly, find the hot paths, optimize
them in code, and reproduce the improvement. Harness: `docs/bench.sh` —
synthetic ledger, `--private` only (the network is never in the numbers),
percentiles over N runs, and a harness-sanity gate (the binary must see the
seeded rows) before any number is trusted.

## Metrics

| id | name | what it measures |
|---|---|---|
| M1 | cold_declare | declare into a fresh ledger — floor cost of one row |
| M2 | scaled_declare | declare into a ledger seeded with SCALE rows |
| M3 | decalogue_scan | `decalogue:purge:3` over the seeded ledger |
| M4 | eval_close | `satisfied:<id>` closure over the seeded ledger |

## Results (SCALE=500, RUNS=5, nice -19, p50 ms)

| metric | baseline | +read cache | +agent memo | +incremental parse | total |
|---|---|---|---|---|---|
| M1 cold_declare | 206 | 201 | 128 | ~236 (isolated) | +15% (regression, accepted) |
| M2 scaled_declare | 4537 | 4630 | 3255 | **556** | **−88%** |
| M3 decalogue_scan | 8160 | 6893 | 5884 | **1364** | **−83%** |
| M4 eval_close | 7750 | 7204 | 6458 | **1395** | **−82%** |

Kill-scale survival (SCALE=2000, single eval_close, the scenario that OOM-killed
the first baseline attempt): **7.1 s wall, 110 MB peak RSS** vs. observed
~3,282 MB RSS at 98% CPU before being killed — ≈30× memory reduction.
(Exit code 1 on that probe is the resolver's honest HOLD verdict on an
unresolvable synthetic root, not a fault.)

Every round was gated: `zig build test` 137/137, full signed pipeline
(`build.sh`) green with 50/50 doctrine-parity, binaries re-signed and
self-attesting, and the bench harness-sanity check passing.

## Timeline of findings (methodology: measure → profile → fix → re-measure)

### Finding 0 — the benchmark itself can be a denial-of-service
Run 1 (SCALE=2000, RUNS=15) was killed (exit 137) and starved the host.
Observed mid-run: one `satisfied:` closure holding ~3.2 GB RSS at 98% CPU.
Adjustment: SCALE=500, RUNS=5, `nice -n 19`, one metric at a time. The kill
was treated as data, not noise.

### Finding 1 — ledger re-reads were real but NOT dominant (honest negative)
Code reading suggested the storm: `parseRows` leaks the full ledger buffer
per call by design, and the resolver re-parses per pass while the cache
layer's per-id walks re-slurp the file per call (8 sites in cache.zig).
Fix #1: size-keyed read memos (`ledger.currentSize` + parse template cache
in main.zig; `readAllShared` in libcontract). The ledger is APPEND-ONLY, so
file size is a sound invalidation key.
**Honest result: M2 unchanged, M3 −15%, M4 −7%.** The hypothesis was
mostly wrong about magnitude. Lesson re-learned: profile before optimizing.

### Finding 2 — the dominant cost was popen("git config user.email") per append
`sample` profile of a scaled declare: ~33% of all samples under
`contract.getAgent` → `popen`/`fread`, fired from `recordIteration`,
`appendGuardRow`, and every other event append. The resolver appends many
events per invocation → hundreds of subprocess forks, each blocking on
pipe reads. Fix #2: per-process agent memo in contract.zig and cache.zig.
One identity per process is also the *correct* attribution semantics — the
author cannot change mid-invocation. Result: M1 −38%, M2 −28%, M3/M4 −17…28%.

### Finding 3 — the resolver's own appends busted the parse memo per candidate
Second profile: the remaining time sat in `parseRows` inside `resolveOne` —
each candidate's event appends grow the file, invalidating the size-keyed
memo, forcing a FULL re-parse (with per-field JSON decode) for the next
candidate. O(candidates × file). Fix #3: incremental tail parsing —
`ledger.readFrom(offset)` + extend-the-template. Sound because every append
is one whole-line writev, so any previously observed size is a line
boundary. O(new bytes) per resolver step. Result: M2 −83%, M3 −77%,
M4 −78% vs. the previous round; −82…88% vs. baseline.

### Finding 4 — the cold-path tax (accepted regression)
M1 rose ~15% (206→~236 ms isolated; the in-bench 327 ms reading was
contention from the pipeline run that preceded it — re-measured in
isolation before believing it). Cause: the extra size-stat per parse and
template copies. Accepted: ~30 ms once per cold invocation buys multi-second
wins on every warm path. Recorded rather than hidden.

## Why these changes are safe
- Append-only ledger ⇒ file size is a monotone, sound cache key; tail reads
  always start on a line boundary (single writev per row).
- Callers' ownership contracts unchanged: parseRows callers still free the
  slice they receive (strings were already process-lifetime); readAllShared
  is a NEW function — the 8 migrated cache.zig sites dropped their frees,
  unmigrated readAll callers keep theirs.
- Agent identity per process is semantically correct attribution, not just
  faster.
- Witnesses: 137/137 unit tests, doctrine-parity 50/50, signed binaries
  self-attesting, harness sanity (scan must see the seeded fixtures) green
  on every round.

## What was NOT done, and why
- No benchmark-specific special-casing in the substrate: every change is a
  general-path optimization with unchanged semantics; the bench never
  appears in the code.
- The 64 MiB readAll cap, backfill budget (64), and resolver pass caps were
  left untouched — changing limits to flatter the numbers would be gaming,
  not improving.
- macOS `sample` was the profiler (low overhead, no instrumentation build);
  two profiles were taken because the first fix's negative result proved
  the first hypothesis wrong.
