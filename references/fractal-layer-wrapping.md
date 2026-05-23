# Ξ1 — Fractal layer wrapping (programmatic, not aspirational)

> **The doctrine.** Server-triggered iterates fire by default — same
> wavefront, same Ψ4 watchers, same Ω1 unblock-rewake, same Π2 autopay
> — but every emit egresses through a **layer-wrap enforcer** that
> strips or translates anything above the receiving audience's
> allowed-layer ceiling. The same way a cell is wrapped by a tissue
> wrapped by an organ wrapped by a system: each layer carries only the
> abstraction the next layer up needs, never the internals beneath.
> The substrate enforces this **mechanically on every emit**, fractally,
> at every depth. No "remember to use Aiko voice" prompts — the
> enforcer does the wrap.

## The reality this reflects

The five abstraction layers (Psychology § L0–L4 + Identity § Aiko-voice
+ Σ2 audience tiers + locality-split server-side default) are not five
independent rules. They're one nested wrapping, exactly like biology:

```
L4 — user-intent       (whole organism — "the agent finished the job")
  L3 — truth-claim     (organ — "the plan held; payment cleared")
    L2 — agent-UX      (tissue — "iterate → judge → mark; wave 2/5")
      L1 — substrate   (cell — funnel, sequence, judged, satisfied)
        L0 — mechanical (molecule — exit codes, paths, contract ids)
```

A neuron's action potential is an L0 event. A reflex arc is L1
(neuron → neuron). A motor sequence is L2 (arc composed for a movement).
The conscious decision to grab a cup is L3. The intent ("I'm thirsty")
is L4. **Nothing about the thirst leaks the molecular details upward;
nothing about the molecule leaks the intent downward.** Each layer
wraps; each layer emits only what the next layer up needs.

Ξ1 binds the substrate to that same discipline by design.

## The audience ceiling (per-tier max-layer)

`Σ2 --audience` already gates **which rows a viewer sees**. Ξ1 extends
this to **which layers within a row are emitted to that viewer**:

| Audience | Allowed layers | What gets stripped at egress |
|---|---|---|
| `private` | L0 + L1 + L2 + L3 + L4 | nothing — full substrate vocabulary |
| `team` | L1 + L2 + L3 + L4 | L0 (exit codes, hashes, raw paths, full 36-char ids) unless `--verbose` |
| `public` | **L4 only** (with optional L3 truth-claim summary) | EVERYTHING ELSE — substrate jargon, ledger event names, shape names, contract ids, paths, exit codes, raw payloads. Translates through Aiko voice. |

The strip is mechanical. A row declared `--audience public` that
emits "cell `7afc6d27` unsatisfied: funnel-first needs ANY child to
fire" reaches the user as Aiko's L4 voice — "I'm still working on
that; one of the three checks needs to pass before I can confirm" —
or doesn't emit at all if no L4 translation is possible.

## How "fractal" makes this mechanical, not aspirational

Every emit point — `contract iterate` output, `_mark` propagation
wavefront, requirement blocks, hook side-effects, Ω1 unblock-rewake,
Ψ4 watcher fires, Φ1 SSE tool_calls — runs through the same wrapper:

```
emit_classified(row, audience):
  for line in row.output_lines:
    layer = classify(line)         # which of L0..L4 is this line?
    if layer > audience.ceiling:   # above the audience's max?
      translate(line, target=audience.ceiling)
        OR drop(line)
        OR group(line, into="rolled-up summary")
  yield only what passes
```

Fractal: the rule fires at every depth — top-level organ output, child
cell output, propagation wavefront, hook log, stream file written to a
public-audience client. Same enforcer, same ceiling check, same
strip/translate. **No emit point bypasses the wrapper.**

## The substrate-side mechanics (what changes)

| Surface | Behavior pre-Ξ1 | Behavior post-Ξ1 |
|---|---|---|
| `contract iterate` stdout | full L0+L1+L2+L3 output to whoever called | classified per `$CONTRACT_AUDIENCE` (env, default `team` for dev, `public` for server-triggered) |
| `_mark` propagation wavefront | full L1+L2 ("parent organ <id> unblocked") | for public viewers: L4 only ("I made progress on related work") or omitted |
| Requirement blocks (PAYMENT REQUIRED / SIGN-IN REQUIRED / ROUTED / INHIBITION REFUSAL / MACHINE BINARY MISSING) | L1 field names verbatim | for public viewers: Aiko-voice rendered per the per-block render-hint catalogue |
| Hook side-effects (drive-advance log) | L0 path + L1 event in dev | for public viewers: never reach them (the hook log is `team`-only by default) |
| Φ1 SSE tool_calls | function names match block kinds verbatim (`payment_required`, etc.) | unchanged — these ARE the L4 surface (the client renders them as native UI), already correct |
| Ω1 UNBLOCK-REWAKE | full L1+L2 ("contract <id> ready, re-judge") | for public viewers: L4 ("something I was waiting on came back; I'm continuing") |
| Ψ4 watcher fires | L0+L1 ("watcher triggered, contract iterated") | for public viewers: silent (the user sees the eventual L4 completion, not the polling) |

The user reading their phone never sees `contract iterate`, never sees
a contract id, never sees a shape name. They see Aiko's L4 voice +
optionally a one-line L3 truth-claim summary. Everything else is wrapped.

## Programmatic, not aspirational — what makes it mechanical

The substrate already has the doctrines (Σ2/Α2/Ψ1/Identity); they
live as agent-judgment surfaces today. Ξ1 makes them mechanical:

1. **`classify_layer(text) → 0|1|2|3|4`** — pure function in
   `scripts/lib/contract_core.py`. Regex + keyword classifier:
   - L0: 36-char UUID, 8-hex contract id in prose, file path,
     `action_exit=`, `pointer(`, hash, hex blob
   - L1: shape names (`cell`, `funnel`, `quorum`, `sequence`,
     `loop-until`, `harness`, `tool-guard`, `judgment`, `funnel-first`),
     event names (`declared`, `iterated`, `satisfied`, `judged`,
     `merged`, `crystallized`, `learned`), KEY 1/2/3, ledger primitives
   - L2: navigation verbs (`iterate`, `mark`, `spawn`, `revise`,
     `wave N/M`), prompt words (`PROMOTE`/`HOLD`/`REJECT`)
   - L3: PASS/FAIL/ERROR results, "plan:" prefix, "result:" prefix
   - L4: default — plain English, no substrate vocabulary

2. **`emit_classified(lines, audience)`** — pre-egress filter in
   `scripts/contract`. Every CLI verb that prints to stdout pipes
   through this. The filter strips lines above audience-ceiling OR
   substitutes them with an L4 translation (Aiko-voice canonical
   strings for the common requirement blocks, "…" for L0 noise).

3. **`$CONTRACT_AUDIENCE` env var** — set by the caller. Defaults:
   - my Mac shell: `team` (I want substrate vocabulary for dev)
   - server-side iterate runner: `public` (user-facing default)
   - explicit `--audience <tier>` flag on any verb overrides

4. **Self-check `self/layer-purity-enforcement`** — runs against a
   synthetic set of mixed-layer test outputs; asserts that
   `emit_classified(text, audience='public')` produces ZERO substrate
   vocabulary tokens (regex sweep against the L0/L1 word lists).

5. **Hook-side audit** — every `_fire_contract_hooks` call records
   the audience of the emit. The `audits/layer-egress/` audit walks
   every recent hook event and asserts no L0/L1 leak to public-audience
   surfaces. Idempotent fixer: re-tag misclassified historical rows
   with the correct audience (which then re-classifies them on next read).

## The locality-split composition

For the user-facing path (`unbrowse` CLI → server-side substrate),
every iterate runs with `CONTRACT_AUDIENCE=public` by default. The
server-side iterate runner pipes every emit through
`emit_classified(line, audience='public')` before returning JSON to
the unbrowse binary. The binary renders Aiko voice to the user; never
sees the substrate vocabulary itself.

For my dev path on this Mac, `CONTRACT_AUDIENCE` is unset, defaulting
to `team`; I get substrate vocabulary so I can build the substrate
itself.

For a `team` row that needs to be surfaced to a `public` client (e.g.
the Telegram bot tailing a shared inbox), the bot adapter sets
`CONTRACT_AUDIENCE=public` at read time; the substrate strips/translates
on render. The row itself doesn't move tiers — the egress filter
adjusts.

## Why this beats "agent remembers to use Aiko voice"

Three reasons:

1. **The agent forgets.** Across sessions, compactions, mood changes,
   the agent drifts. A regex sweep on every emit catches what the agent
   doesn't remember to filter.

2. **The agent reasons; the regex enforces.** Same split as the
   two-key exit (machine + agent): the wrapper is KEY 1 of the voice
   discipline; the agent's translation choice is KEY 2 of the voice
   discipline. Both keys required.

3. **It composes with everything.** A future Φ2 surface, a fifth
   facilitator, a new Ω-something block — all inherit the wrapper
   automatically. The doctrine ages forward without rewrites.

## What stays out

- **No per-line agent prompt** for layer choice. The agent IS the
  L3-or-L4 translator at declare/spawn time; the wrapper is the
  emit-time enforcer. Two different jobs, two different layers.

- **No new ledger event-type.** Layer is a property of EMIT, not of
  a ROW. The same satisfied row reads as L1 to a team viewer and as
  L4 to a public viewer; the substrate stores raw + classifies per
  read.

- **No clock-judgment.** Strip/translate is mechanical at the
  current moment; the agent decides whether the wrap is "fake-green"
  (e.g. translating an honest L3 FAIL into a vague L4 "still working
  on it" is fake honesty, caught by `contract honest`).

## Β1 follow-ons captured

The doctrine ships today; four discrete shipments wait on the
substrate-side wiring:

1. **`classify_layer(text)` pure function** in
   `scripts/lib/contract_core.py` + unit tests for each L0..L4 class.
2. **`emit_classified(lines, audience)` filter** wired into every
   `print` path in `scripts/contract`; `$CONTRACT_AUDIENCE` env read
   at process start.
3. **`self/layer-purity-enforcement` self-check** + verb-gate
   asserting no L0/L1 vocabulary tokens survive a `public`-audience
   emit on a synthetic mixed-layer input.
4. **`audits/layer-egress/` corpus audit** — walks recent hook events
   + ledger rows, asserts no L0/L1 leak to public surfaces, with
   idempotent fixer that re-tags misclassified historical rows.

Each ships as its own contract when wired.

## Self-check

The next `self/no-contradictions` run should look for: any
public-audience emit point in the substrate scripts that bypasses
`emit_classified`. Any hit is a doctrine violation per Ξ1.

Origin: contract `c9de1eb9`, 2026-05-24. Lewis's framing: "is
triggered by default from remote as well but not exposed to the user,
and these information is gated away on the right abstraction with
abstraction layers always reflecting reality of how domains are layered
and cells wrapped by neurons by etc etc in a fractal manner /contract
it to be programmatically done always." The doctrines were already
there in spirit (Σ2 + Α2 + Ψ1 + Identity); Ξ1 makes them load-bearing
by binding them to a mechanical emit-time filter.
