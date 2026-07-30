# `/contract` A/B benchmark — async DAG scheduler

Date: 2026-07-19

## Design

- Same starter repository and task prompt.
- Same Codex CLI, default model/config isolation, workspace sandbox, and
  autonomous stopping rule.
- Control was explicitly prohibited from invoking `/contract`.
- Treatment was required to declare the task, consult its briefing/status, and
  check status after tests.
- Three visible tests were available to both agents.
- Nine hidden acceptance tests lived outside both workspaces.
- Runs were sequential to avoid CPU/network contention.

## Results

| Metric | Without `/contract` | With `/contract` |
|---|---:|---:|
| Visible tests after agent changes | 6/6 | 8/8 |
| Hidden acceptance tests | 9/9 | 9/9 |
| Wall time | 105.83 s | 160.12 s |
| Command executions | 6 | 11 |
| Input tokens | 177,069 | 259,317 |
| Cached input tokens | 150,528 | 222,464 |
| Output tokens | 3,667 | 4,987 |
| Reasoning tokens | 936 | 1,269 |

The treatment took 51.3% longer, used 46.5% more total input tokens, 38.9%
more uncached input tokens, 36.0% more output tokens, and 83.3% more command
executions. Both arms achieved the same hidden-test correctness.

## Observations

- The treatment added more visible edge-case tests (five versus three new
  tests), including explicit invalid-concurrency and cycle-path cases.
- Both implementations were structurally sound and passed every hidden test.
- The treatment agent initially tried `contract --help`,
  `contract declare --help`, and a misplaced `--register`; the CLI interpreted
  one help attempt as a real declaration with plan `--help`.
- The eventual task contract (`7818cadc`) remained `pending` after successful
  code verification. The control layer recorded the goal but did not close the
  evidence loop.
- The project-local contract ledger proves treatment use, but the global
  `~/.contracts/activity.log` did not receive these sandboxed invocations
  because the workspace-write sandbox could not write outside the benchmark
  workspace.

## Conclusion

For this single bounded coding task, `/contract` provided no measurable
correctness gain and imposed material coordination overhead. The trial is not
large enough for a general product claim. It does expose concrete product work:
make help non-mutating, make invocation syntax harder to misuse, support a
clear verified-completion transition, and place operational logs somewhere
writable inside sandboxed project contexts.

## Trial 2 — explicit task lifecycle

The four exposed issues were implemented before repeating the experiment:

- all help forms return before any mutation;
- `contract task begin "<task>" --check "<command>"` registers one task;
- `contract task verify <id>` runs the declared check, records an iteration,
  and satisfies only on exit 0;
- project-scoped runs write `.claude/activity.log`, which remains writable in
  a workspace sandbox.

Both agents were rerun from fresh copies of the original starter repository.

| Metric | Without `/contract` v2 | With `/contract` v2 |
|---|---:|---:|
| Visible tests after agent changes | 7/7 | 8/8 |
| Hidden acceptance tests | 9/9 | 9/9 |
| Wall time | 141.89 s | 159.09 s |
| Command executions | 6 | 9 |
| Input tokens | 165,335 | 217,284 |
| Cached input tokens | 137,984 | 185,344 |
| Uncached input tokens | 27,351 | 31,940 |
| Output tokens | 4,372 | 4,355 |
| Reasoning tokens | 1,155 | 920 |

The upgraded treatment was 12.1% slower, used 31.4% more total input tokens
but only 16.8% more uncached input, produced essentially the same output-token
count, and used 20.3% fewer reasoning tokens. It executed three more commands
overall. Four calls belonged to the contract lifecycle—begin, initial status,
verify, and final status—while the treatment needed one fewer non-contract
command elsewhere.

The task `609f9b43` followed the intended ledger lifecycle:

```text
declared -> iterated -> satisfied
```

The activity log independently recorded `task.verify.start` and
`task.verify.satisfied`. The final status was `satisfied`.

### Updated conclusion

The usability and grounding fixes removed the failure modes and reduced the
relative time penalty substantially. This task still shows no correctness
uplift because both control agents already achieved 9/9. The improved
`/contract` now buys durable, independently replayable proof that the declared
check ran and passed. Whether that proof improves correctness requires a task
set where the unaided baseline sometimes fails, not another repetition of this
now-saturated scheduler benchmark.
