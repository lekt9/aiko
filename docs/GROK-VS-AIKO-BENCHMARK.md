# Grok versus Aiko benchmark

Generated: `2026-07-21T18:54:11.950Z`

## Fairness boundary

This compares the two installed CLI harnesses, not the intelligence of two models. Both were authenticated during the measured run, but their accessible model catalogs do not overlap: Aiko was explicitly pinned to `mimo-v2.5` and Grok to its only advertised model, `grok-4.5`. The live figures are therefore readiness observations, not a model-quality or apples-to-apples latency race. No credentials or login state were copied.

## Builds

| Harness | Version | Binary size | Authenticated | Commands |
|---|---|---:|---|---:|
| Aiko | aiko 0.2.102 (8acf895) | 160.6 MiB | true | 23 |
| Grok | grok 0.2.106 (bde89716f679) [stable] | 116.1 MiB | true | 20 |

Aiko adds the `background`, `native`, and `tasks` command surfaces for its Contract runtime. Its installed binary is 38.3% larger.

## Local harness latency

Each cell is a fresh process. One warm-up was discarded, followed by 15 measured runs. Lower is better.

| Command | Aiko median ms | Grok median ms | Grok/Aiko | Aiko p95 ms | Grok p95 ms |
|---|---:|---:|---:|---:|---:|
| version | 40.09 | 10.01 | 0.25× | 41.66 | 12.30 |
| help | 40.96 | 10.28 | 0.25× | 43.70 | 11.89 |
| inspect | 117.42 | 122.05 | 1.04× | 130.85 | 128.29 |
| completions | 42.78 | 13.95 | 0.33× | 52.88 | 15.78 |
| sessions | 692.47 | 1193.72 | 1.72× | 741.07 | 1240.13 |

## Live readiness

| Harness | Model | Result | Exact response | Elapsed ms |
|---|---|---|---|---:|
| Aiko | mimo-v2.5 | ready | true | 11383.66 |
| Grok | grok-4.5 | ready | true | 8242.55 |

## Interpretation

Grok is about 75.0% faster on trivial version startup and 67.4% faster generating completions. Aiko is 42.0% faster listing sessions; configuration inspection is effectively tied. Local command latency measures CLI startup and command plumbing, not model quality. Both live checks completed the exact-response task. A fair model-quality benchmark still requires a backend/model combination accessible to both harnesses and multiple randomized task trials.
