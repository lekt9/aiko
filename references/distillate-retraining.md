# Λ2 — Periodic distillate retraining on RunPod (the KEY-2 LLM gets sharper)

> **The doctrine.** Λ1 made KEY 2 runtime-agnostic — any OpenAI-compat
> endpoint can serve the judging verdict. Λ2 makes that endpoint
> **self-improving on a schedule**. A Ψ4 wall-clock watcher fires
> periodically; the substrate kicks a RunPod training job that
> fine-tunes a small open-weights base model on recent ledger rows as
> instruction-following data; the new checkpoint is evaluated against a
> held-out KEY-2 verdict harness; on PASS the endpoint config is
> atomically swapped (`contract:<id>` pointer flip — pointer-not-payload
> preserved); on regress the swap is reverted via `contract supersede`.
> The user sees no change except KEY 2 gets sharper at /contract-shaped
> reasoning each cycle. The Talker model never has to be retrained
> against synthetic data — the substrate IS the data.

## Why this is load-bearing

Λ1 today routes through codex / Venice / OpenAI / local llama.cpp /
anything that speaks `/v1/chat/completions`. Whichever endpoint
answers, its judging quality is **frozen at the day it was trained**.
A general-purpose model speaks English well but doesn't know what a
`funnel-first` vs `quorum:K` vs `sequence` is, doesn't know to refuse a
`_mark satisfied` on a contract whose action exited 0 but whose proof
string contradicts the plan, doesn't know that a Π3 `=== MACHINE BINARY
MISSING ===` block is FAIL not ERROR. Every KEY-2 call wastes tokens
re-explaining the substrate to a model that should have seen the
substrate's own vocabulary 10× last week.

Λ2 closes that loop. The ledger IS the training corpus; each cycle
distills its most recent reasoning into the next checkpoint; the next
checkpoint judges KEY 2 with substrate-native priors. **Convergence
speed increases monotonically without any agent-side intervention.**

## The reality this reflects (per Cayden's narrow-Talker doctrine)

The Talker (per `talker-reasoner-doctrine-0-8b-serves-the-talker-role-fast.md`)
is **narrow**: instruction-following + pattern recognition for an
in-loop tool-controller. It is NOT a generalist Reasoner. Λ2 trains the
Talker on the *exact* tool-controller surface it serves — the
/contract substrate's iterate / judge / mark / spawn / propagate loop —
using the *exact* ledger rows it will be asked to reason over. The
training distribution = the inference distribution by construction.

Per `before-declaring-hypotheses-about-a-stack-run-an.md`: arxiv check
before declaring hypotheses about training. The relevant priors —
Self-Rewarding LMs (Yuan 2024), Constitutional AI distillation (Bai
2022), STaR (Zelikman 2022), Reflexion (Shinn 2023), Process Reward
Models (Lightman 2023) — all share the same shape: a model's own
in-distribution traces become its next training corpus, gated by a
verifier (the harness, the constitution, the rationale chain). Λ2 is
that exact shape with the ledger as the trace store and the held-out
KEY-2 harness as the verifier. The literature is on side; the binding
work is operational, not research.

Per `deploy-gate-h7-verdict-must-pass-before-runpod-sglang.md`: the
RunPod SGLang deploy is gated on the H7 verdict (peak checkpoint must
beat base by ≥3pp on both axes + sanity-gen coherent). Λ2 inherits that
gate as its `evaluate` stage — no checkpoint promotes without the H7
verdict passing on the held-out harness.

Per `caydenmodel-mistakes-and-guards.md`: five standing guards from the
v13 build apply directly (SFT-mix regresses IFEval → mix-audit on every
build; broken-base ckpt → ckpt-sanity gate; pgrep false-attach → use
runpodctl logs not pgrep; HF gating → mirror model to gitea; bash 3.2
portability → all scripts test against macOS bash). The training stack
is not new ground; the substrate-side wiring is.

## The five-stage cycle (each a sub-contract under the Λ2 organ)

The cycle is a `sequence` (ordered funnel — each stage gates the next):

```
1. trigger     → Ψ4 watcher fires on wall-clock OR ledger-row-count threshold
2. corpus      → extract last N satisfied rows + proofs as JSONL training data
3. train       → kick RunPod job; checkpoint lands at <runpod-uri>
4. evaluate    → H7-style held-out KEY-2 harness on new ckpt; verdict must PASS
5. promote     → atomic swap of llm.json endpoint OR supersede if regression
```

### Stage 1 — trigger (Ψ4 watcher)

```bash
contract watch <Λ2-trigger-id> \
  --probe 'python3 ~/.claude/skills/contract/scripts/should-retrain.py \
             --since-rows 5000 --since-days 7 --min-judged 200' \
  --interval 3600
```

`should-retrain.py` is the trigger gate. Exits 0 (PASS = fire) when the
ledger has accumulated either 5000+ rows since the last `learned`
event tagged `lambda2-promote`, OR 7 days have passed, AND at least 200
rows carry `agent_verdict` (the supervisable signal). Exits 1 (FAIL =
skip this tick) otherwise.

The Ψ4 watcher fires the next stage by writing a row to
`~/.contracts/inbox/watcher/<Λ2-trigger-id>.jsonl` and auto-iterating
the trigger contract. The propagation wavefront (Ω1) then surfaces the
corpus stage as ready.

### Stage 2 — corpus extraction

`scripts/lambda2-extract-corpus.py` walks `~/.contracts/contracts.jsonl`
and emits JSONL training rows shaped for instruction-following
fine-tuning:

```json
{
  "instruction": "You are judging KEY 2 for /contract. Read the iterate output and the plan. Decide PROMOTE | HOLD | REJECT.",
  "input": "PLAN: <plan text>\n\nACTION RESULT: <stdout from iterate>\n\nEXIT: <code>\n\nPROOF (if marked): <proof string>",
  "output": "<PROMOTE | HOLD | REJECT>\n\nREASON: <agent_verdict text from the row>\nBLOCKED_BY: <ids from judged row>"
}
```

The corpus carries:
- **positive** examples: every `iterated → satisfied --proof <real evidence>` chain (the agent JUDGED genuine, the substrate accepted, the wavefront propagated cleanly with no later supersession)
- **negative** examples: every `iterated → judged HOLD/REJECT` chain with `blocked_by` named (the agent correctly DIDN'T mark; tells the model what fake-green looks like)
- **rejected** examples: every contract that was `_mark satisfied` then later `superseded` with a regression-citing reason (the agent marked WRONG; tells the model what fake-green slipped through)

Filtered by audience — only `--audience team` and `--audience private`
rows are corpus material; `--audience public` rows speak Aiko voice and
are wrong-shape for KEY-2 distillation. Σ2 gating preserved at the
training-data boundary.

Stored at `~/.contracts/training/corpus-<timestamp>.jsonl`. Append-only
across cycles; each train uses the latest N rows.

### Stage 3 — RunPod training

`scripts/lambda2-runpod-train.sh` kicks the job via `runpodctl`
(machine:-resolved per Π3 — never bake the absolute path):

```bash
contract declare "Lambda2 cycle <N> training job" \
  --action 'machine:runpodctl create pod \
              --imageName runpod/sglang-trainer:latest \
              --gpuType "NVIDIA A100 80GB" \
              --env CORPUS_URI=s3://contract-corpus/corpus-<ts>.jsonl \
              --env BASE_MODEL=meta-llama/Llama-3.2-1B-Instruct \
              --env OUTPUT_URI=s3://contract-checkpoints/ckpt-<ts>/' \
  --parent <stage-3-id>
```

The model choice is Cayden's narrow-Talker default: 0.8-1B open weights,
SFT only (no RLHF — the constitution lives in the ledger's
PROMOTE/HOLD/REJECT verdicts, not in a separate reward model). Training
config inherits the v13 stack's standing guards (mix-audit, ckpt-sanity,
bash-3.2-portable wrappers).

Long-running; the contract goes HOLD pending RunPod logs. A Ψ4 watcher
on the RunPod job id flips it to satisfied when `runpodctl logs <pod>`
emits the `TRAINING_COMPLETE` sentinel + the checkpoint S3 URI is
reachable. Stream side: progress written to
`~/.contracts/streams/<train-id>/stdout.log` for live `contract tail`.

### Stage 4 — evaluate (the H7 verdict gate)

The new checkpoint must beat the currently-promoted checkpoint on the
held-out KEY-2 harness — the same shape as Cayden's H7 verdict:

- **Verdict-axis accuracy**: held-out set of 200 ledger triplets
  (plan + iterate output + ground-truth PROMOTE/HOLD/REJECT verdict),
  new ckpt must score ≥3pp higher than current ckpt
- **Sanity-gen coherence**: 20 free-form judging prompts, new ckpt's
  outputs must parse as well-formed verdict blocks (no broken JSON,
  no looping, no degenerate `PROMOTE PROMOTE PROMOTE` tokens)

```bash
contract declare "Lambda2 cycle <N> H7-verdict evaluation" \
  --action 'bash ~/.claude/skills/contract/scripts/lambda2-evaluate.sh \
              --candidate <s3://.../ckpt-<ts>/> \
              --baseline <current-promoted-ckpt> \
              --held-out ~/.contracts/training/held-out.jsonl' \
  --parent <stage-4-id>
```

The held-out set is **frozen** — never includes any row newer than the
training cutoff for this cycle, never includes rows the agent
hand-curated (which would over-fit). PASS only when both axes clear.

### Stage 5 — promote (atomic swap, supersede on regression)

PASS path:

```bash
# 1. atomic mv of the endpoint config (pointer-not-payload)
mv ~/.config/contract/llm.json ~/.config/contract/llm.json.prev
python3 -c "
import json
with open('~/.config/contract/llm.json','w') as f:
  json.dump({
    'url':'https://<runpod-sglang-host>/v1',
    'key':open('~/.config/contract/runpod-key').read().strip(),
    'model':'lambda2-ckpt-<ts>',
    'lambda2_cycle': <N>,
    'lambda2_promoted_at': '<iso-ts>',
    'previous_config_path': '~/.config/contract/llm.json.prev'
  }, f)
"
# 2. crystallize the learning (memory file + Outline doc + ledger row)
contract learn "Lambda2 cycle <N> promoted ckpt-<ts>: verdict-axis +<X>pp, sanity-gen clean" \
  --source contract:<Λ2-cycle-N-organ>
# 3. mark the cycle satisfied with proof
contract _mark <Λ2-cycle-N-organ> satisfied \
  --proof "H7-verdict PASS (+<X>pp on verdict-axis, sanity-gen 20/20 coherent), atomic swap completed at <ts>, previous config at llm.json.prev for rollback"
```

The `learned` row carries the `lambda2-promote` tag — that's the row
`should-retrain.py` scans to find the last promotion when computing
"have we accumulated 5000 rows since then?"

REGRESSION path:

```bash
# H7 verdict failed → supersede the cycle organ with a "kept previous ckpt" winner
contract declare "Lambda2 cycle <N> regression: previous ckpt remains promoted" \
  --action agent-judges
# returns <regress-id>
contract _mark <regress-id> satisfied \
  --proof "candidate ckpt-<ts> failed H7: verdict-axis +<Y>pp (need +3), sanity-gen <Z>/20 coherent (need 20/20). Previous ckpt remains active; candidate archived at s3://contract-checkpoints/regressed/ckpt-<ts>/"
contract supersede <Λ2-cycle-N-organ> <regress-id> \
  --reason "candidate regressed; current ckpt kept; H7-verdict gate did its job"
```

The cycle organ becomes a fossil (per natural-selection lifecycle); the
NEXT Ψ4 trigger fires a fresh cycle. Promotion is one-directional —
once a checkpoint is fossiled it doesn't auto-revive; the substrate
trusts the gate that rejected it.

## Composition with prior doctrines

| Doctrine | What Λ2 inherits |
|---|---|
| **Λ1** (runtime-agnostic KEY 2) | The endpoint Λ2 swaps IS the Λ1 router's HTTP fallback config. Codex remains the dev-Mac default per the 2026-05-24 amendment; Λ2 hot-swaps the server-side HTTP target. |
| **Ψ4** (async watcher) | Both the cycle trigger AND the RunPod-job-done watcher are plain `contract watch` registrations; no new primitive needed. |
| **Π3** (`machine:` pointer) | `runpodctl` resolved via per-host map; the cycle contract is portable across dev hosts even though the binary path differs. |
| **Ω1** (HOLD auto-rewake) | The "training in progress" HOLD on stage 3 auto-rewakes when the RunPod-finish watcher fires stage 4. Whole-cycle convergence loop closes itself. |
| **Β1** (deferred items become contracts) | The next cycle's corpus naturally includes every Β1-captured DEFERRED row that satisfied between cycles — the substrate's own follow-on work becomes training signal. |
| **Pi6 → locality-split** | Λ2 training + serving live **server-side at unbrowse** (per locality-split), not on Lewis's Mac. The dev Mac only authors the trigger contracts + reads the promotion ledger rows; the corpus/train/serve loop runs entirely remote. |
| **Ξ1** (fractal layer wrap) | Λ2's iterate/mark output for user-facing surfaces stays L4 (Aiko voice — "I got a little faster at understanding the work today"); only team/private rows carry the L1 substrate vocabulary about cycles and verdicts. |

## What stays out

- **No reward model.** The constitution is the ledger's existing
  PROMOTE/HOLD/REJECT verdicts plus the supersede signal for retroactive
  fake-greens. RLHF would smuggle a separate judgment surface into the
  substrate; the ledger IS the judgment surface.
- **No model self-judging its own training data.** The training rows are
  the agent's verdicts (in-thread KEY 2), not the previous model's
  verdicts. Avoids the autophagy failure mode where each cycle
  drifts further into the previous model's biases.
- **No per-call online learning.** Cycles are wall-clock + row-count
  triggered; the active checkpoint is frozen between cycles. KEY 2
  remains a deterministic-on-this-cycle function; non-determinism is
  reserved for the swap event itself.
- **No silent swap.** Every promote writes a `learned` row tagged
  `lambda2-promote` AND a `crystallized` ledger row. The audit trail
  is queryable: `contract search --context "lambda2-promote"` lists
  every cycle that ever shipped.

## Β1 follow-ons captured

The doctrine ships today; six discrete shipments wait on the
deployment-side wiring (each ships as its own contract):

1. **`scripts/should-retrain.py`** — the trigger predicate. Exits 0/1
   based on row-count + wall-clock + judged-row-floor thresholds.
   Configurable via `~/.config/contract/lambda2.json` (cycle interval,
   row floor, judged floor).
2. **`scripts/lambda2-extract-corpus.py`** — ledger → JSONL training
   data, Σ2-audience-filtered, with positive/negative/rejected example
   classes. Held-out set carved off frozen (deterministic split by row
   hash so the same row never enters both train and held-out across
   cycles).
3. **`scripts/lambda2-runpod-train.sh`** — RunPod job orchestration via
   `machine:runpodctl`. SFT-only on Llama-3.2-1B-Instruct (or whichever
   open-weights small model is current); inherits v13 stack guards
   (mix-audit, ckpt-sanity, bash-3.2-portable). Streams progress to
   `~/.contracts/streams/<id>/stdout.log`.
4. **`scripts/lambda2-evaluate.sh`** — held-out H7-verdict harness.
   ≥3pp verdict-axis accuracy AND 20/20 sanity-gen coherence required
   to PASS. Outputs JSON report consumed by stage 5.
5. **`scripts/lambda2-promote.sh`** — atomic mv of `llm.json`,
   crystallizes the `lambda2-promote` learning, with rollback path that
   restores `llm.json.prev` on next-cycle regression detection.
6. **`audits/lambda2-cycle-integrity/`** — corpus audit: every
   `lambda2-promote` learning row must have a satisfied cycle organ as
   its source; every cycle organ must have all five stages either
   satisfied OR superseded; no orphan checkpoints in
   `s3://contract-checkpoints/` without a matching cycle row.

## Self-check

The next `self/no-contradictions` run should look for: any KEY-2 LLM
endpoint config swap that wasn't preceded by a satisfied Λ2 cycle organ
with a passing H7-verdict child. Any hit is a doctrine violation per
Λ2 — the promote stage is the only legitimate path to changing the
active checkpoint, and it requires the held-out verdict gate.

Per `deploy-gate-h7-verdict-must-pass-before-runpod-sglang.md`: the
existing RunPod SGLang deploy already shares this gate. Λ2 wires the
gate INTO the substrate's own training loop so the discipline applies
automatically per cycle, not just at first deploy.

Origin: contract `1c090ac9`, 2026-05-24. Lewis's framing: "trigger a
training of the distillate of the /contract llm agent on remote
occasionally on the /contract for remote llm training for /contract
runpod for the talkie thing type shit so that it swaps out every once
in a while to power the /contract setup we have here on the remote
agent each time." Lambda1 made the endpoint runtime-agnostic; Λ2 makes
the endpoint self-improving on a schedule. The Talker model (per
Cayden's doctrine) is narrow by design — narrow tasks benefit most
from in-distribution distillation, which is exactly what the ledger
provides for free.
