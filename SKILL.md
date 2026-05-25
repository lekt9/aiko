---
name: contract
description: Minimal native contract-neuron primitive. Declare one truth claim; the server-side DAG integrates evidence, spawns child neurons, and recursively fires affected neurons until the graph settles.
user-invocable: true
---

# /aiko

`aiko` is the substrate. There is no other surface — no second CLI, no
verb dispatch, no migration alias. `contract` is the ledger row/type name
only; the binary you call is always `aiko`.

Local code is only the environment executor for the server-spawned aiko context.

## Activation rule — every `/contract` invocation MUST spawn the aiko binary

When the user types `/contract <args...>` (or invokes this skill via any
alias), the orchestrator MUST, as a non-negotiable first step, spawn the
aiko binary with the user's full argument text as the truth claim:

```bash
~/.claude/skills/contract/scripts/aiko "<args verbatim>" --remote
```

The binary's stdout is recorded as ledger evidence regardless of what
other work the orchestrator does in the same turn. The 402 Payment
Required envelope is a valid response — it proves the substrate fired;
the orchestrator continues its work. Any agent that interprets `/contract`
prose without firing the binary is in violation of the substrate rule
(the prose is the spec, the binary is the substrate).

## Verification rule — every prod deploy MUST be visually verified live

Any code path that deploys to a public URL (e.g. `wrangler deploy`,
`bun run deploy`, Cloudflare Pages push to main) MUST be followed by a
live observation step before the work is reported done:

1. Fetch the live URL with curl AND confirm HTTP 200 + the load-bearing
   identity string is in the rendered HTML.
2. Open the live URL in a headless browser (puppeteer or equivalent) and
   capture a screenshot of the above-the-fold viewport at 1440×900.
3. Read the screenshot in-thread and judge whether it matches the
   pre-deploy candidate screenshots. If it doesn't match, surface the
   delta as a blocker — do NOT report "deployed and verified".

The contract substrate's four-dim gate (`four-dim-gate.sh` in any
project that adopts it) is the canonical pre-deploy gate. The
post-deploy live verification is the canonical post-deploy gate. Both
gates are mandatory; neither substitutes for the other.

## HOLD is non-terminal — iterate then escalate

When any contract-gate (four-dim-gate, falsifier-gated-build, custom
deploy gate) returns HOLD, the orchestrator MUST NOT terminate. HOLD
is the substrate asking for more work, not permission to stop. The
canonical recovery sequence:

1. **Diagnose** — read the per-dimension verdict. Identify the
   single dimension that blocked (CWV bytes, a11y serious, copy drift,
   etc.) and the specific atom inside it (which metric, which
   selector, which string).
2. **Resolver wave** — spawn one focused sub-agent to fix the named
   atom (no scope creep). The sub-agent edits, commits, and the
   orchestrator re-runs the gate.
3. **Re-gate** — if PROMOTE, ship. If still HOLD on the same
   dimension, escalate to wave 2 (deeper investigation: build-chain
   noise vs real product regression). Cap at 3 resolver waves per
   HOLD.
4. **Escalate to user via best channel** — if the gate still HOLDs
   after 3 resolver waves, the orchestrator MUST contact the user via
   the best-channel-right-now substrate (see below). The user becomes
   the resolver of the substrate's standoff. Never silent-drop.

Termination is reserved for explicit user "stop" / "park" / "abort"
instructions. The substrate's job is to keep firing until the truth
claim resolves or the user names the stop.

## Channel registry — every contact channel is a contract

Every channel through which the substrate can reach the user is its
own contract neuron:

- `channel:telegram` — Aiko Telegram bot (lekt8 / getFoundry namespace)
- `channel:x-dm:lekt8_` — X direct message to @lekt8_
- `channel:x-dm:getFoundry` — X direct message to @getFoundry
- `channel:email` — Resend to lewistham9x@gmail.com
- `channel:claude-code-session` — in-thread reply (this session)
- `channel:push-notification` — PushNotification tool when user is
  away from a thread

The "best channel right now" is itself a contract — a picker that
inspects each channel's status (recent activity, time-of-day,
do-not-disturb flag, user-presence inference) and returns the
canonical channel for the current moment. Substrate primitive:
`scripts/channels.sh` emits the channel-list JSON; the picker is
`scripts/pick-channel.sh`. Each channel binding is an aiko contract
declaration with `posthook_pointer` set to the channel's actual
send-endpoint.

When the orchestrator escalates a HOLD per the rule above, it:
1. Reads the channel registry (`scripts/channels.sh`)
2. Asks the picker for the best channel right now
   (`scripts/pick-channel.sh`)
3. Fires a posthook contract that ships the escalation payload to
   that channel
4. Continues the loop — the user's response becomes the next
   resolver-wave input

## Public Shape

The user-facing surface is exactly:

```bash
aiko "<goal>" --remote
aiko "<goal>" --local
```

No verbs. There is no `declare`, `iterate`, `_mark`, `status`, `list`,
`dag`, `spawn`, `solve`, `corroborate`, `drive`, or any other subcommand
the caller can reach for. The substrate is stateless — state lives in
the append-only ledger, not in a CLI surface — so a "compatibility verb"
is meaningless. If a caller needs to *read* substrate state, it parses
the canonical ledger file directly (Foundation, not subprocess); if it
needs to *write*, it spawns `aiko "<goal>" --mode`. That is the entire
write API.

`aiko` is the Zig neuron substrate with the smallest local surface. It
accepts one goal and one mode. `--remote` routes to the Unbrowse contract
ledger, defaulting to `https://beta-api.unbrowse.ai` when `UNBROWSE_BASE`
is not set. `--local` uses the same neuron shape against the local
scoped ledger.

`aiko` is x402-native. It marks contract declarations as Corbits/Faremeter Flex
requests and sends a signed payment header from the caller environment when
present:

```text
AIKO_X_PAYMENT / X_PAYMENT -> X-PAYMENT
```

If no payment header is available, Unbrowse returns the canonical 402 payment
requirements envelope instead of falling back to local mutation.

`aiko` guards privacy before network egress. Local declarations are reduced to
patterns and meta-patterns: obvious emails, local filesystem paths, and
secret-like tokens are replaced with `[email-pattern]`, `[local-path-pattern]`,
and `[secret-pointer-pattern]`. The server may resolve pointer values inside
typed context, but the local binary does not leak machine-specific private
values.

There are no public action, parent, iterate, mark, spawn, status, or
search choices. Context and status may be injected by the runtime (via
environment variables — `CONTRACT_PARENT_ID`, `CONTRACT_ENVIRONMENT_ID`,
hooks, etc.), but they are not escape hatches the caller chooses. A
caller that wants to read the local ledger reads the file; a caller
that wants to write goes through `aiko`. Anything else is a
backwards-compat hack and is rejected.

**Read views are strongly typed and read-only.** The local executor
exposes the ledger through immutable typed views (struct fields are
`let`-only, no setters, no mutable escape hatches). Untyped `[String:
Any]` dictionaries do not cross the substrate→app boundary inside the
executor; they survive only as the JSON adapter at the very edge for
renderer compatibility. New ledger event kinds are added as enum
cases in the typed reader, not as string switches scattered across
the codebase. Heuristics (status fold, edge derivation, stdout cid
extraction) are confined to one named function each — no duplication. **Whenever this section changes
to add or remove a surface, update SKILL.md in the same change and run
`scripts/sync-outline-explainer.sh` — see the Outline explainer sync
section below.**

Reduced vocabulary:

```text
aiko = public primitive and spawned environment
contract = ledger row/type name for the same thing
goal/plan/prompt = one truth claim
parent_id = containment edge
contract:<id> = pointer edge
posthook_pointer = pointer called after promotion
wallet_identity = identity pointer used to sign calls
replicated_from_contract_id = paid copy of an out-of-lineage contract
network_tunnel_contract_id = server-side connectivity adapter
```

## Neuron Shape

Every declaration is a contract neuron:

```text
truth claim
-> inherit lineage from CONTRACT_PARENT_ID / CONTRACT_PARENT
-> integrate child evidence
-> run the server-selected harness/funnel/loop verifier
-> fire when its threshold resolves true
-> recursively fire contained children, affected parents, and contract-ref neurons
-> stop when the DAG settles or evidence is missing
```

`parent_id` is the containment edge. It means one environment owns and wraps
another environment, not merely that one task is listed under another. The
fractal hierarchy is atom -> cell -> tissue -> organ -> organism in the same
mechanical sense: each child contract runs inside the environmental field
created by its parent, and that parent can itself be a child of a larger
environment.

The DAG is multidimensional. `parent_id` is the containment dimension.
`contract:<id>` references are cross-dimension dependency edges. When a neuron
fires, the substrate recursively fires contained child neurons, containment
ancestors, and dependent cross-edge neurons until no newly-true signal
propagates.

Hooks are contracts too. A prehook is another contract-neuron that gets the
spawned environment context and may hold execution before the declared neuron is
created. A posthook is another contract-neuron that fires after the declared
neuron resolves. They are carried by environment, not public flags:

```text
CONTRACT_PREHOOK_ID / CONTRACT_PREHOOK
CONTRACT_POSTHOOK_ID / CONTRACT_POSTHOOK
```

Each hook is a breakpoint: if it cannot resolve, propagation waits there with
ledger evidence. The same shape applies whether the environment is an API call,
a Telegram bot contract, a local Mac executor, a VM, a Turbobox, or another
Unbrowse-spawned environment.

PreTool context is also contract-shaped. Every contract surfaced in PreTool
context is a server-side ledger event contract, projected into context by a
stateless event bus. Local PreTool code does not own memory; it forwards
pointers:

```text
CONTRACT_EVENT_BUS_ID / CONTRACT_EVENT_BUS
CONTRACT_PRETOOL_EVENT_ID / CONTRACT_PRETOOL_EVENT
CONTRACT_EVENT_KIND / CONTRACT_PRETOOL_KIND
```

The server ledger is the bus. A PreTool event can become a contract-neuron, feed
context to another contract-neuron, or hold as a breakpoint, but it is always
append-only ledger state on Unbrowse, not local mutable hook state.

Adapters are contracts too, and they live on the server side. The local
environment may carry `CONTRACT_ADAPTER_ID` / `CONTRACT_ADAPTER` and
`CONTRACT_ADAPTER_KIND` / `CONTRACT_ENVIRONMENT_KIND`, but those values are
pointers to server-side adapter contract-neurons. API, Telegram, local Mac, VM,
Turbobox, and Unbrowse executors are not local modes; they are server-owned
adapter contracts that decide how to spawn and constrain the local executor.

The public row uses the `neuron` shape. Typed verifier mechanics such as cells,
funnels, loops, harnesses, quorums, sequences, and contract references are
internal server-side wiring, not caller-facing flags.

In server-spawned environments, Unbrowse may provide private verifier wiring via
`CONTRACT_NEURON_ACTION` while the public command remains `aiko "<goal>"
--remote|--local`. In local scoped test mode, a neuron with no child/evidence
rows fails closed. In server mode, `UNBROWSE_BASE` routes declarations to
`/v1/contract/declare`, where Unbrowse may spawn more contracts on Unbrowse
infra. The server-side LLM is the integrator: it reads the active context,
chooses which child environments/verifiers to spawn, and returns only typed
contract pointers to the local executor.

The LLM layer is the compiler from arbitrary prompt text into this contract
shape. The user's prompt remains the root contract declaration in words. The
server LLM expands that root into multiple child contract-neurons, adapter
contracts, PreTool event contracts, prehooks, posthooks, and verifier
contracts, then recursively fires the graph through typed pointers.

For `aiko`, this compiler is recursive and same-shaped. One `aiko "<goal>"
--remote` prompt becomes one root aiko contract; the Unbrowse LLM emits child
prompts as more aiko contracts, and those children may carry their own child
prompts in the same JSON tree. The client still sends only one sanitized goal. Every
spawned node is a server-side `neuron` row with a `parent_id` edge, not a local
`spawn` verb.

**LLM use is `aiko` spawn.** Any code path that calls a model provider
directly (vendor SDK, raw `/v1/chat/completions`, model-router HTTP) is
a backwards-compat hack. The canonical LLM entry is `aiko "<prompt>"
--remote`; the cloud aiko's compiler spawns child aikos recursively
for actual model invocation (each model becomes a child neuron, not a
hardcoded provider id). Code that wants an LLM call goes through aiko
or it's not on the substrate.

**No caller-visible options.** There is the Way. No env-var toggles
for substrate transport, no mode enums with multiple cases, no opt-in
flags on the chat path, no factory that picks an implementation by
env. Where reality requires a fallback (cloud endpoint not yet
deployed), the fallback is silently chained inside one class — the
caller cannot see or configure it. When the fallback is no longer
needed, it is deleted in one commit, not flipped by configuration.

Aiko truth is metric-gated. A node resolves true only when the declared goal is
true against evaluator aikos bound to external metrics, ledger metrics, or API
metrics. Evaluators are ordinary aiko contracts with typed metric pointers. When
the goal and its evaluators resolve true, the solved aiko is promoted upward as
a parent-layer `contract:<id>` pointer. That promoted pointer is the child's
typed stdout for the parent aiko that requested it. The compiler itself is
stateless: prompt in, typed tree out; state lives in the append-only ledger.

Posthook webhooks are also pointer-shaped. A contract may declare
`posthook_pointer`; once the goal and evaluator metrics promote, Unbrowse POSTs
the full context tree to that pointer and appends a `called` row with
`source_pointer`, `target_pointer`, and `call_kind=posthook`. The webhook body
contains the root goal, declared row, promoted stdout pointer, and recursive
child/evaluator rows, so local and remote aikos call each other through typed
pointers after resolution instead of surfacing graph-control verbs.

Posthooks are signed by the parent aiko's wallet identity when the server has a
webhook signing secret. The signer is `parent_wallet_identity` falling back to
`wallet_identity`; the body carries a signature envelope and the request carries
matching `X-Aiko-*` signature headers. The local binary never receives private
wallet material.

Out-of-lineage contracts are not embedded by reference for free. If the compiler
selects a contract outside the caller's lineage, it must declare
`replicated_from_contract_id` and mark `replication_payment_scheme` /
`replication_payment_status`; only the replicated in-lineage copy is callable
later. Search discovers pointers, payment replicates them, and execution calls
the paid local copy.

Network durability is also a contract pointer. WireGuard/Tailscale/WARP-style
tunnelling belongs behind `network_tunnel_contract_id` and
`network_tunnel_kind`, not as another user mode. The tunnel adapter contract
keeps the spawned environment reachable; aiko still exposes only goal + mode.

## Ledger

The Unbrowse ledger is canonical. `CONTRACTS_STORE` exists only for scoped
local tests and migrations. Never edit rows in place; append events.

## Outline explainer sync

The public-facing explainer of the contract shape lives at Outline doc
`1b254adc-1db2-4bab-a063-328d022034d1` (urlId `cOkhCDzhyF`, collection
Contracts: <https://docs.getfoundry.app/doc/the-shape-of-a-contract-and-why-contract-is-the-substrate-cOkhCDzhyF>).
Its rendered body is checked in at
`references/contract-shape-explainer.md`. Whenever any section above
(Public Shape, Neuron Shape, vocabulary, hooks, adapters, PreTool,
lineage replication, posthook signing, Ledger) changes, re-author the
explainer to reflect the new shape and run
`scripts/sync-outline-explainer.sh`; the hash sidecar at
`references/.outline-explainer.hash` proves the last-synced body matches
the local body. Obligation pinned by project contract `297ca10f`.
