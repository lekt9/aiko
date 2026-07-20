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

## Record substantive work

For substantive multi-step work, register the user's goal without sending it to
another reasoning model:

```bash
contract declare "<goal>" --register
```

Registration answers with a short briefing on stderr — the proven route for
goals shaped like this one and up to three already-open root contracts. Use
it to avoid redoing or colliding with existing work; do not narrate it.

Do this quietly. Do not print or narrate the returned id unless the user asks
about harness state. If registration fails, continue the user's work and report
the harness failure only when it affects durability or verification.

Use the shared cloud compiler only when the user explicitly asks to create or
expand a shared contract graph. Shared is the aiko default — no flag exists
for it:

```bash
aiko "<goal>"
```

Use `--private` when the user explicitly requests a local-only declaration:

```bash
aiko "<goal>" --private
```

Remote failure never authorizes a silent local-model fallback. A payment-required
request may be queued visibly for retry; do not fabricate a successful graph.

## Resolve only when requested

Do not run the resolver merely because goal registration wrote a ledger row.
Claude performs and verifies ordinary work directly; registration is bookkeeping,
not a request for the harness to execute the goal.

Run one resolver pass only when the user explicitly asks to resolve, retry, or
advance registered contracts:

```bash
contract tick
```

Use the resident loop only when the user asks for ongoing schedules, proactive
rules, or monitoring:

```bash
contract tick --every 5
```

Do not start a persistent process for ordinary one-shot work.

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
