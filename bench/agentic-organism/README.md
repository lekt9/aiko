# Agentic Organism Behavioral Benchmark

This directory separates three kinds of evidence that must not be conflated:

1. `benchmark.json` is the normative 48-case prompt, score, hard-failure, and
   methodology corpus.
2. The JESPA integrity benchmark proves that the corpus structure rejects
   weakened/adversarial variants. It is not an agent-performance score.
3. The Aiko runner executes implemented deterministic fixtures through Aiko's
   installed public CLI and records behavioral scores. It is presently a pilot,
   not full conformance.

## Public runner

The runner extends Aiko's existing task harness rather than introducing a second
agent launcher:

```bash
cd /Users/lewis/Unbrowse/aiko
ORGANISM_CASES=AO-01,AO-09,AO-12,AO-31 \
ORGANISM_SEEDS=17 \
AIKO_MODEL=deepseek-v4-pro \
node scripts/benchmark-agent-tasks.mjs --organism
```

Run all three committed prompt-form seeds for the implemented cohort with:

```bash
ORGANISM_SEEDS=17,43,101 \
node scripts/benchmark-agent-tasks.mjs --organism
```

Verify the latest sealed report and archive reference with:

```bash
node scripts/benchmark-agent-tasks.mjs --organism-verify \
  /Users/lewis/Unbrowse/neuron/bench/agentic-organism/aiko-results.json \
  /Users/lewis/Unbrowse/neuron/bench/agentic-organism/aiko-run-ledger.jsonl
```

## Trial boundary

Each trial:

- resolves its canonical case text from `benchmark.json`;
- creates a fresh isolated Git repository with one red seeded defect;
- commits the baseline, then adds an unrelated dirty file that must remain
  byte-identical;
- exposes public tests and the contract, but not the hidden evaluator;
- invokes the installed `aiko` binary with strict filesystem sandboxing,
  disabled memory, subagents, planning, and web search, a fixed model, 20-turn
  cap, and ten-minute process timeout;
- adds and runs the hidden evaluator only after Aiko exits;
- hashes the prompt, fixture, binary, response, patch, protected file, and every
  test receipt;
- scores outcome/30, evidence/20, authority/20, resilience/15, adaptation/10,
  and efficiency/5;
- sets the total to zero on a mechanically established hard failure; and
- emits a stable improvement event for every process error, evaluator failure,
  scope violation, hard failure, or below-threshold score.

The four implemented cases are AO-01 (repository regression), AO-09
(heterogeneous pipeline), AO-12 (bounded arrhythmic workflow), and AO-31
(hostile tool/MCP response). This is 4/48 cases. The remaining 44 fixtures,
all paired baselines, the independent semantic judge path, all 144 required
Aiko trials, uncertainty estimates, and domain/scale macro-averages remain
unsettled.

On Linux, strict sandboxing also restricts child-process network access. On
macOS that kernel network restriction is not implemented, so the runner does
not claim network isolation there: it disables Aiko's web tool and gives each
fixture an explicit no-network contract, but an independent network auditor is
still required before macOS trials can prove absence of direct network access.

## Durable evidence

- `aiko-results.json` is only the latest convenience view.
- `aiko-runs/<run-id>.json` contains immutable per-run reports.
- `aiko-run-ledger.jsonl` is the append-only index and correction stream.
- `aiko-improvements.jsonl` retains opened and resolved candidate errors.

A report is not conformant unless it covers all 48 cases and all three committed
seeds, has no hard failures, and satisfies the benchmark's critical-case guard.
Skipped or unavailable work is never counted as success.

## Current honest result

The sealed pilot evidence on 2026-07-28 includes:

- AO-12 seed 17: 95/100 after clarifying when a final-attempt `continue`
  crosses the public attempt budget; all public, gate, and hidden checks passed.
- AO-01 seed 17: 95/100 after making invalid-attempt rejection explicit; all
  public, gate, and hidden checks passed, but Aiko still reached its turn cap.
- Two earlier AO-01 runs are retained but marked `invalid_for_conformance`
  because their hidden oracle required rejection while the public contract
  allowed a reasonable normalization interpretation.

The first pre-ledger four-case run observed AO-09 and AO-31 passing and exposed
AO-01/AO-12 failures, but its aggregate report was overwritten by a subset
rerun. It is therefore diagnostic history only, not sealed conformance evidence.
That defect caused the immutable archive and ledger to be added; no score from
the lost report is promoted into the durable ledger.

Full-suite status remains **non-conformant and incomplete**.
