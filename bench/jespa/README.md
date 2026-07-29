# Typed Neuron AGENTS benchmark

This benchmark asks a narrow, honest question: does the validator distinguish the intended
architecture contract from documents that retain its vocabulary while deleting invariants
or injecting contradictions?

`benchmark.py` encodes the contract as structural features, predicts the valid-document
latent (zero violations), and scores variants by violation energy. The baseline checks only
topic-keyword presence. The corpus contains two faithful variants and ten labeled
counterfeits. It is always evaluated in full; seeds 17 and 43 verify order independence,
not cherry-picked splits.

This is a specification-discrimination benchmark. It does not claim runtime performance or
biological fidelity. Add every future attempt to `benchmarks-ledger.jsonl`, including
honest negatives.

`runtime_tasks.py` separately evaluates the implemented runtime on six behaviors it
actually claims. It rebuilds and tests the Zig code, probes the compiled CLI, and compares
against an executable sequential validate-as-you-go baseline. The baseline is intentionally
simple but not fake: it passes ordinary multi-effect execution and exposes why whole-
decision validation, deduplication, CAS, grounding, and aggregate budgets matter.

`benchmark.py --suite organism` evaluates the Agentic Organism benchmark itself. The v2
corpus contains 48 tasks across 12 real-world domains, three paired trials, 12 adversarial
stressor families, 12 organism functions, and 13 interface families. The evaluation uses
two faithful and 18 adversarial full-corpus variants. Structural energy measures violations
of scoring arithmetic, evidence, authority, judge independence, trial design, and coverage
relations; the shallow baseline recognizes only benchmark vocabulary. This is benchmark
integrity discrimination, not a claim that an agent has passed the 48 behavioral tasks.

Reproduce it with:

```bash
python3 bench/jespa/benchmark.py \
  --suite organism \
  --seeds 17 43 101 \
  --assert-win
```
