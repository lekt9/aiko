---
name: contract
description: Use Claude as the planner and reasoner while the local aiko contract harness records goals, resolves dependencies, reuses verified results, runs schedules, and preserves evidence. Use for substantive multi-step work that benefits from durable execution, verification, retries, or recurring rules.
user-invocable: true
---

# Contract harness

Use Claude for language understanding, planning, reasoning, and tool selection.
Use the local harness only for deterministic state:

```text
Claude plans and acts
        ↓
contract records → resolves → executes/caches → verifies → records outcome
                         ↑                              │
                         └──── invalidation/retry ─────┘
```

Do not treat the embedded semantic router, Bible corpus, compression, Hebrew
structure, gematria, or smart contracts as a reasoning model. On-chain
submission is disabled unless the user explicitly enables and requests it.

## Work

- Own the user's requested outcome and perform the work with Claude's available
  tools.
- Keep plans small and paths direct. Prefer one canonical dependency pointer,
  `contract:<id>`.
- Never claim success from an LLM judgment alone. Verify with tests, command
  results, files, APIs, or other task-appropriate evidence.
- Do not expose secrets, private keys, root seeds, Keychain values, or payment
  credentials in prompts, commands, output, or contract bodies.

## First principles (physics of the substrate)

Canon: `docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md` (fractal seal, duals catalog,
composition, conservation). Structure map / gaps / runtime sit beside it under
`docs/PHOTON-POSITRON-*.md`. Mechanical guard:

```bash
bash scripts/witness-first-principles.sh
```

**Law A1 in practice:** every substantive claim needs an antiparticle (real
`--check`, gate, sensor, or other catalog dual). No free particles.

## Record substantive work — always use task begin

For substantive multi-step work, register as a contract task with a real
**check command** that proves the work is done:

```bash
contract task begin "<goal>" --check "<real shell command that exits 0 on success>"
```

The check command is the proof. It must be a real shell command — not a
placeholder, not an echo. Examples:

| Task | Check |
|------|-------|
| Create a file | `ls path/to/file` |
| Build passes | `cargo build 2>&1` |
| Scraper works | `python3 scraper.py --dry-run && ls output.csv` |
| Deploy succeeds | `curl -s https://my.app/health \| jq -e '.status == "ok"'` |

After work is done, verify:

```bash
contract task verify <id>
```

This re-runs the check command and records the outcome in the ledger.

### Do NOT use `contract declare` for local work

`contract declare` triggers a full resolver pass on all legacy rows. In repos
with history (many have stale rows with broken temp dirs/worktrees), it will
loop indefinitely. Use `contract task begin --check` instead — it scopes to
a single task and completes instantly.

`contract declare` is reserved for low-level ledger maintenance, on-chain
anchors, and explicitly requested remote compilation. Ordinary work uses
checked tasks.

### Task lifecycle (preferred for local work)

```bash
contract task begin "<task>" --check "<command>"   # register
contract task verify <id>                           # verify (re-runs check)
contract task status <id>                           # inspect
contract status                                     # list all
contract explain <id>                               # evidence trace
```

## Proof integrity — qualify the check with exit-zero

`contract task begin --check` records a task whose verdict is the check's exit
code. It does not establish that the check is *capable of failing*. An
unqualified check — `--check true`, or one that exits 0 without ever reading the
artifact it claims to measure — records a green verdict that means nothing. That
qualification is owned by `exit-zero` (`ez`), which runs a check in a scrubbed
empty world, at the base commit, and against a corrupted anchor, and refuses to
call it a witness unless it can come back RED.

For substantive proof-of-work, qualify first, then wrap durably:

```bash
ez declare <slug> --anchor <file> --check "<real proof command>"   # proves the gate can fail
contract task begin "<goal>" --check "ez gate <slug>"              # durable execution over a qualified gate
```

Both steps are required; there is no one-step form. `ez declare` takes only
`--objective --anchor --check --derived --parent --depends-on --irreversible
--cap --no-mutate --redeclare --timeout`, and exit-zero contains no contract
integration at all — so the two commands above stay two commands. The layers
stay separate and neither is forked: **contract owns durable execution,
scheduling, dependency resolution, and retries; exit-zero owns the satisfaction
predicate.**
Do not register a bare `--check` for substantive work when its ability to fail
has not been shown — that is the one part an unqualified resolver cannot prove
for itself.

## Daemon persistence (limbs)

Aiko runs as a **daemon-first agent**. Beyond one-shot contract tasks, she
maintains persistent background processes ("limbs") that:

- Poll channel APIs (Telegram, Discord, Slack, email) for incoming messages
- Dispatch every inbound message as a contract task
- Use every channel affordance (typing indicators, rich formatting, file
  uploads, voice, inline keyboards, message editing, reactions)
- Survive agent session restarts — the daemon is the substrate, the session
  is a conversation

Each limb is registered as a contract task with a health-check command
that proves the daemon is alive:

```bash
contract task begin "telegram limb health" --check "curl -s 'https://api.telegram.org/bot$TOKEN/getMe' | jq -e '.ok'"
```

The daemon lifecycle: `contract task begin` → start daemon → `monitor` stdout
→ verify health check. When a limb goes down, the contract task fails its
verify and Aiko restarts it.

### Limb generation

Aiko generates new channel integrations as contract tasks. The telegram
daemon at `crates/codegen/xai-telegram-daemon/` is the reference template:
api types → bot logic → daemon loop → health check. To add a new limb,
register a contract task, generate the crate following the template, build,
and start the daemon.

## Verify, don't resolve

Task verification (`contract task verify <id>`) re-runs the check command.
This is the primary feedback loop — not the resolver.

Only run `contract tick` when the user explicitly asks to resolve, retry, or
advance registered contracts. Do not start a persistent process for ordinary
one-shot work.

## Governed agency work

Use a schema-v1 agency envelope when the work needs explicit purpose,
authority, cadence, effect reach, evidence policy, or lifecycle ownership.
Contract uses six roles over the same resolver: purpose, governor, action,
sensor, evaluator, and development. Do not invent roles for legacy rows.

High-risk typed actions remain in HOLD until their capability, approval, and
consequence-sensor coverage are promotable. Do not weaken that HOLD by
redeclaring the work as legacy. Grounded success requires a fresh external
anchor and independent evaluation; duplicated, circular, expired, revoked, or
same-failure-domain evidence is not additional confidence.

For checked local work, prefer the narrow task lifecycle:

```bash
contract task begin "<task>" --check "<command>"
contract task verify <id>
contract explain "task-<id>"
```

The verification emits a causal action → sensor → evaluator trace. For
inspection or debugging:

```bash
contract events [--trace <id>]
contract watch [<trace-id>] --json
contract explain <trace-id>
```

These read-only surfaces must remain outside wallet, signing, retry, network,
and Keychain paths. Use `tools/contract-events.html` to inspect an existing
event log offline.

Before finishing:

1. Remove unnecessary work.
2. Simplify the remaining path.
3. Exercise the real path.
4. State failures, skipped checks, and unresolved dependencies plainly.

Keep internal terminology out of normal user-facing answers. Lead with the
result; surface contract ids, cache events, resolver internals, or ledger rows
only when the user asks for them or they explain a failure.
