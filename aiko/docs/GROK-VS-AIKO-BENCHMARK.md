# Grok versus Aiko benchmark

> **Historical.** Dated benchmark report. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Generated: `2026-07-30T10:34:54.993Z`

## Fairness boundary

This compares the two installed CLI harnesses, not the intelligence of two models. Both were authenticated during the measured run, but their accessible model catalogs do not overlap: Aiko was explicitly pinned to `mimo-v2.5` and Grok to its only advertised model, `grok-4.5`. The live figures are therefore readiness observations, not a model-quality or apples-to-apples latency race. No credentials or login state were copied.

## Builds

| Harness | Version | Binary size | Authenticated | Commands |
|---|---|---:|---|---:|
| Aiko | aiko 0.2.103 (98c5059) | 161.8 MiB | true | 23 |
| Grok | grok 0.2.114 (0c785038798) | 123.7 MiB | true | 21 |

Aiko adds the `background`, `native`, and `tasks` command surfaces for its Contract runtime. Its installed binary is 30.8% larger.

## Local harness latency

Each cell is a fresh process. One warm-up was discarded, followed by 8 measured runs **interleaved and paired** between the two harnesses, alternating which one runs first. Lower is better.

Read the paired columns, not the medians: `Δ median` is the median of per-rep differences (positive = Aiko slower), and `Aiko slower` counts the paired reps Aiko lost. A near-even split means the two are indistinguishable regardless of the medians.

Host: 6 cores, 1-minute load 11.75→16.87 — **oversubscribed, absolute times inflated**.

| Command | Aiko median ms | Grok median ms | Grok/Aiko | Δ median ms | Aiko slower | Paired verdict |
|---|---:|---:|---:|---:|---:|---|
| version | 108.78 | 32.40 | 0.30× | +76.38 | 8/8 | Grok faster |
| help | 356.61 | 30.91 | 0.09× | +315.86 | 8/8 | Grok faster |
| inspect | 658.87 | 511.73 | 0.78× | +204.78 | 7/8 | Grok faster |
| completions | 112.68 | 46.27 | 0.41× | +66.58 | 8/8 | Grok faster |
| sessions | 1423.03 | 2043.26 | 1.44× | -779.72 | 2/8 | Aiko faster |

## Live readiness

| Harness | Model | Result | Exact response | Elapsed ms |
|---|---|---|---|---:|
| Aiko | mimo-v2.5 | ready | true | 58801.59 |
| Grok | grok-4.5 | ready | true | 35932.25 |

## Interpretation

Differences the paired data supports: `version` (Grok faster by 70.2%, winning 8/8 paired reps); `help` (Grok faster by 91.3%, winning 8/8 paired reps); `inspect` (Grok faster by 22.3%, winning 7/8 paired reps); `completions` (Grok faster by 58.9%, winning 8/8 paired reps); `sessions` (Aiko faster by 30.4%, winning 6/8 paired reps). **This host was oversubscribed during the run** (6 cores, 1-minute load 11.75→16.87). Absolute milliseconds are inflated for both harnesses and must not be compared against numbers from an idle machine; only the paired columns are meaningful here. Local command latency measures CLI startup and command plumbing, not model quality. Live readiness: Aiko ready, Grok ready. A fair model-quality benchmark still requires a backend/model combination accessible to both harnesses and multiple randomized task trials.
