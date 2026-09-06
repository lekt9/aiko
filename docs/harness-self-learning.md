# Self-learning harness loop

The agent harness improves itself from its own run logs. Every agent session in
this repository writes telemetry under `.graff/` (transcripts, behavior, traces,
trajectories). The loop mines those logs for recurring failure patterns, hands
the evidence to a **graff fixer agent** as a one-shot task, and lands the fix as
a pull request — closing the loop: *run → log → learn → patch → PR*.

```
.graff/ logs ──▶ scripts/harness-learn.mjs ──▶ lessons report
                                                    │
                    artifacts/harness-learn/state.json (dedup gate)
                                                    ▼
                                    scripts/harness-selflearn.sh
                                                    │
                          ┌─────────────────────────┼──────────────────────────┐
                          ▼                         ▼                          ▼
                git worktree isolation      graff -p fixer agent      verify (typecheck + tests)
                + pnpm install              with guardrails           + diff allowlist review
                          └─────────────────────────┼──────────────────────────┘
                                                    ▼
                                        branch + push + gh pr create
```

## Usage

```sh
pnpm harness:learn        # mine logs, write the lessons report, exit
pnpm harness:selflearn    # full loop: mine → graff fixer → verify → PR
```

Dry runs:

```sh
SELFLEARN_DRY_RUN=1 pnpm harness:selflearn   # report only, no agent, no PR
SELFLEARN_NO_PR=1   pnpm harness:selflearn   # agent fix + checks, no push/PR
```

## What gets mined

`scripts/harness-learn.mjs` (no dependencies) reads `.graff/` within a time
window (default 14 days) **and the Tardigrade server-side event logs** and
extracts:

| signal | source | meaning |
|---|---|---|
| `tool_error` | transcripts | `[error] tool: …` tool receipts, classified per tool |
| `retry_loop` | transcripts | identical tool name+args called repeatedly in one run |
| `harness_retry` | traces | harness-level `retry` / `subagent_retry` events |
| `stuck_todo` | session meta | checklist items still open when the session ended |
| `turn_stall` | behavior | long gaps between turns |

Server-side **Tardigrade** logs (the Aiko runtime itself) are mined from
`~/.local/share/unbrowse/aiko` (override with `--tardigrade <dir>`, disable
with `--tardigrade none`): every `*.sqlite` event store — `actor.sqlite`,
per-account `thread.sqlite`, background role dbs, and cutover exports — is
opened read-only and its `events` rows parsed:

| signal | source event | meaning |
|---|---|---|
| `turn_failed` | `TurnFailed` | a turn ended in failure (error output mined) |
| `turn_cancelled` | `TurnCancelled` | turn cancelled mid-flight |
| `delivery_unknown` / `delivery_rejected` | `AikoDeliverySettled` | message delivery not confirmed |
| `receipt_unknown` / `receipt_*` | `ToolReturned` | browser/telegram receipt not `ok`/`delivered` |
| `event_error` | any event with `error` | model/budget/provider errors |

Privacy: user message content (`MessageReceived`) is never mined — only
failure outcomes and receipt statuses. Production runs on Cloudflare Durable
Objects; point `--tardigrade` at an exported/migrated state dir to mine those.

Signals are normalized (numbers/hex/paths scrubbed, secrets redacted) and
grouped into **lessons** with fingerprints. A local state file,
`artifacts/harness-learn/state.json`, records which fingerprints were already
fixed (and by which PR), so the loop never re-reports a known lesson.

## What the fixer agent does

`scripts/harness-selflearn.sh` spawns `graff -p` with the lessons report and
hard guardrails:

- Works in an isolated **git worktree** on branch `harness-learn/<stamp>` —
  the main checkout is never touched.
- May only modify `apps/`, `packages/`, `tests/`, `docs/`, `scripts/`; the
  script re-checks the diff against this allowlist before committing and
  rejects `.env*`, keys, `.graff/`, `artifacts/` and sqlite files outright.
- Budgeted: `SELFLEARN_MAX_MODEL_CALLS` (default 80) and a wall-clock timeout
  (default 40 min), with `--dedupe-tool-calls` and `--learning-privacy local`.
- Must run `pnpm typecheck` and `pnpm test:aiko` itself, then the script
  re-runs them; a failed check aborts the PR.
- Must write a decision report to `docs/harness-learn/<stamp>.md` (lessons
  addressed → root cause → changes → deliberately not done).

Only then does the script commit, push, and open a PR whose body embeds the
lessons table, the fixer's summary, and verification output. After the PR
opens, fingerprints are marked fixed so the next mining run starts clean.

### First-run hardening (2026-09-06)

The inaugural run taught the loop its own first lesson: the fixer agent edited
`scripts/harness-selflearn.sh` — while bash was executing it — because nothing
forbade touching the loop's live infrastructure. The orchestrator died on the
mid-run script edit (the agent's work survived in the checkout and was landed
by hand). The loop now enforces two guards learned from that incident:

- **Loop-infrastructure denial** — the fixer may not modify
  `scripts/harness-selflearn.sh` / `scripts/harness-learn.mjs`; the diff review
  rejects them outright.
- **Main-checkout freeze** — `git status` is snapshotted before the agent runs
  and re-checked after; any drift (self-modification or a peer session
  committing mid-run) aborts the PR path instead of building on a moving tree.
- **Recovery notes in the fixer prompt** — mined tool-error patterns
  (`read_file contains` misuse, partial batched edits, identical-call retries)
  are fed back as explicit do-not-repeat guidance.

## Knobs

| variable | default | purpose |
|---|---|---|
| `SELFLEARN_BASE` | current branch | PR base branch |
| `SELFLEARN_CHECK` | `typecheck test:aiko` | verification commands (pnpm scripts) |
| `SELFLEARN_SKIP_INSTALL` | unset | skip `pnpm install` in the worktree |
| `SELFLEARN_MAX_MODEL_CALLS` | `80` | fixer agent model-call budget |
| `SELFLEARN_TIMEOUT_S` | `2400` | fixer agent wall-clock budget |
| `GRAFF_BIN` | `graff` | harness binary to invoke |
| `GRAFF_LEARN_MODEL` | graff default | pin the fixer agent's model |

## Current failure patterns (first mining run, 2026-09-06)

The dominant lessons from the existing logs: repeated `read_file contains`
parameter misuse (12×), identical-call retry loops on `read_file`/`bash`,
unresolved `edit_file old_string` misses, one session ending with 2/4 todos
unfinished, and two 60–75 min turn stalls. The first fixer PR targets the
instruction/tool-validation side of these; later runs are deduplicated by
fingerprint.
