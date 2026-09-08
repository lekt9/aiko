# Cognitive behavior evaluation

This is the comparison workbench for [the plan](../../../../docs/aiko-cognitive-behavior-plan.md). It currently has 60 authored scenario definitions: 20 each for recovery, procedures and proactive behavior, with 10 development / 5 validation / 5 reserved protected entries in each category. **Fifty drivers are implemented: 20 procedures, 15 recovery and 15 proactive cases.** The five reserved recovery and five reserved proactive definitions still fail explicitly if selected. The [family audit](FAMILY-AUDIT.md) found shared input/mechanism lineage across splits: these are builder-visible cases, not independent unseen families. No protected case was executed during this recovery job.

The procedure and recovery drivers use the real `createAikoActor`, native code tools, the private code sandbox wrapper, independently checked artifacts and AccountStorage. Each case gets isolated synthetic memory, private blobs, native history and an offline scripted inference layer. It sends only to an in-process synthetic sender and runs pure QuickJS programs. No real contacts, account data or paid providers are used.

Procedure arms receive identical task inputs and scripts:

- `current-control`: the current code with the original contract behavior.
- `transfer-contract`: the same code with a trusted minimum-transfer requirement on the fixture contract.

Recovery compares `current-control` with `bounded-recovery` (the existing native recovery decorator enabled). Both receive the same script, including ordinary checked alternate/prerequisite calls when no retained impasse is available. Retry suppression and strategy bounds are mechanism probes, not proof that a model would make those unnecessary calls. The unknown-write case retains the actual synthetic executor result before losing its acknowledgement. Both scripts discover available receipt tools; the candidate can invoke the native reconciler. It requires both no duplicate write and reconciliation through the original independent checker; safely retaining an unknown does not pass the latter. The original unknown witness must remain in lineage. The owner-information case requires returning the receipt for already completed partial work. Recovery validation adds cancellation inside a child executor, the original parent deadline, genuinely concurrent strategy calls, current-context schema revalidation, and two independently checked partial results returned after strategy exhaustion. The synthetic executor records peak child concurrency; `Promise.all` starts both proposals before awaiting either result. These requirements may fail in the candidate and are retained in the report.

Proactive comparison mounts the actual foreground and reflection actors, AccountStorage, native waits, coordinator and outbox. `direct-notify-silent` uses the existing legacy reflection contract; `retained-contributions` uses v2. Both receive supplied offline decisions, not a judged model policy. Direct questions execute an actual native read through the private code sandbox. Cases check busy-owner retention, correction, older support, withdrawal, capacity, quiet hours/DST, native work deadlines and replay. Calendar time is substituted inside each isolated child; `AlarmFired` drives the actual native wait. Work cases declare initial synthetic work/receipt state, not verified real correspondence. Every non-work case requires a valid native reflection terminal so a crashed model cannot earn a silence pass. No subjective precision/recall is inferred from these fixtures.

This control is **not** the preserved pre-change source baseline. The workbench tests mechanism behavior under a supplied program, not an agent's autonomous selection or learning. Searchable-history, direct notify/silent, individual-mechanism and combined provider-backed comparisons remain required by the plan.

From the repository root:

```sh
bun apps/agent/scripts/cognitive-eval/run.ts --list
bun apps/agent/scripts/cognitive-eval/run.ts --category=procedures --split=development --out=artifacts/cognitive-behavior/procedures-development-v1
bun apps/agent/scripts/cognitive-eval/run.ts --category=recovery --split=development --out=artifacts/cognitive-behavior/recovery-development-v1
pnpm --filter @unlock/agent exec tsc --noEmit --project scripts/cognitive-eval/tsconfig.json
```

Use a new output directory for each explicit experiment. `freeze.json` pins the dataset, rubric, source hashes, arms and budgets before execution. `run-started.json` prevents silently reusing a directory to reset its budget. Each case runs in a subprocess with a 30-second ceiling. The default development comparison is 20 executions (ten families × two arms); `--max-runs` may be set up to 120. The whole-run ceiling is two hours and the provider budget is zero. Failures/timeouts are retained rather than omitted from results. Arm order alternates across families.

`--case=procedures/nested-projection` selects one family. `--arm=transfer-contract` selects one arm. Validation is explicitly selected with `--split=validation`. Protected execution additionally requires `--sealed-candidate=PATH`: the JSON must contain `datasetDigest`, `sourceDigest`, `arm` and `validationReport`. The runner verifies an exact current-source/dataset match and a complete passing five-family validation report for that arm. Protected cases are never part of default development runs. Sealing is an evaluation guard, not rollout authorization or proof of unseen-case independence.

Artifacts include per-case native events, deterministic checks, actual execution/model-call counts, complete restart comparisons, stderr logs, partial progress and `report.json`. Source changes during a comparison invalidate comparability. The runner reuses `scripts/telegram-eval/evaluator.py` for receipt-based communication measurements and labels them synthetic host receipts. A final reply alone cannot satisfy task completion. Absent token usage and human quality ratings remain unavailable.

The ordinary agent typecheck excludes scripts; use the dedicated project command above. Source tracking re-enumerates added/deleted agent/server/database-client files, agent assets, workspace sources and existing exported `dist` files, the resolved linked browser runtime, manifests, workbench/grader and dependency lock. Registry dependency bytes remain shared; a hermetic transitive build manifest is still unavailable.

For a shared dirty tree, copy the **current candidate**, not HEAD, before comparison:

```sh
python3 apps/agent/scripts/cognitive-eval/snapshot.py --out=/home/deck/tmp/cognitive-candidate-UNIQUE
# Read snapshot.json; matched must be true. Run from its source directory.
```

The snapshot excludes environment files, private state and old artifacts, redirects workspace/browser source links, records regression-test hashes, and refuses an existing directory. Missing exported dist/server/database-client assets caused early snapshot checks to fail; all those logs remain. A regression also caught a Bun mixed-depth brace glob silently omitting linked source: snapshots v1–v4 and their reports are not isolated-browser-source evidence. The corrected v5 snapshot and source enumeration pass the regression, dedicated script typecheck, native tests and local Bun bundle check. See the [status](../../../../docs/aiko-cognitive-behavior-status.md#recovery-worker-evidence--2026-09-08) for exact results and limits.

Directory budgets do not authorize restarting the plan's overall development allowance. The retained reports now account for 120 recovery, 82 procedure and 80 proactive development executions (including diagnostics). Recovery development is stopped at that ceiling; two cases were not rerun on the final v5 snapshot. A larger budget needs an explicit decision, not a new output directory.

The `--single` entry is internal subprocess plumbing. Do not use it to bypass split/budget controls. These runs cannot establish the plan's 20% warm-call savings, 10-point recovery gain, user usefulness/timing targets or full acceptance.
