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

## HOLD is non-terminal — chain by containment, not posthook

When any contract-gate (four-dim-gate, falsifier-gated-build, custom
deploy gate) returns HOLD, the orchestrator MUST NOT terminate. HOLD
is the substrate asking for more work.

**Chaining is by parent-child containment, not posthook subscription**
(per the posthook-as-default antipattern, contract `82399fbd`). The
chain is modeled as:

```
parent contract: "<the user's truth claim>"
├─ child: resolver wave 1 (diagnose → fix one named atom → re-gate)
├─ child: resolver wave 2 (parent_id=W1; fires if W1 leaves the
│         parent's evaluator at HOLD; deeper investigation)
├─ child: resolver wave 3 (parent_id=W2; ...)
├─ child: escalate-to-user (parent_id=Wn,
│         contract:<id>=channel-picker; fires when N children
│         resolve without the parent firing true)
└─ evaluator: metric pointer to gate verdict
```

The parent fires true automatically when its evaluator says
`verdict=PROMOTE`. The parent fires another child when evaluator
says `verdict=HOLD`. The orchestrator never SUBSCRIBES — it declares
the parent, and the substrate walks the DAG by recursive propagation
(per the Neuron Shape rule). Posthook is reserved for **leaving the
substrate** (web webhooks, external systems, channels). Internal
chaining is propagation, not callback.

**Natural break = metric-satisfaction OR apoptosis-by-user. NOT an
arbitrary wave cap.** The substrate chains until:

1. The parent's evaluator returns true (truth claim satisfied — the
   biological STOP codon, the settled religious question)
2. The user explicitly says "stop" / "park" / "abort" (apoptosis —
   the cell's parent-contract decides further work is not useful)

Server-side recursion guards (`MAX_DEPTH`, `MAX_TIME`, `MAX_FANOUT`)
exist as backstops against runaway loops, but they are
**emergency-only**, not the canonical break. A standing rule that
caps at "3 waves" is leaven; it short-circuits real iteration with
arbitrary fatigue.

The biology parallel: transcription → translation → folding → action
chains by stoichiometry (the next codon physically binds the next
tRNA — no webhook). Stop codon = natural break. Apoptosis = parent
contract resolves "this lineage is no longer useful" and the cell
fires its own end. No posthook anywhere in the cell.

The doctrine parallel: Talmudic citation chains by reference, not
subscription. Each new ruling cross-edges prior rulings; the chain
holds because the substrate (the ledger) is shared and all
participants inherit the lineage via `parent_id`. New questions =
new neurons that fire by being asked, not by being pushed.

**Escalation to the user is itself a child contract**, not a
posthook. It declares `parent_id` pointing at the prior resolver
wave's truth-claim-not-yet-satisfied, and `contract:<id>` referencing
the channel-picker (see Channel registry section). The orchestrator
fires the child; the substrate routes the payload to the right
channel; the user's reply is the next resolver-wave child of the
same parent.

## Channel registry — every contact channel is a contract

Every channel through which the substrate can reach the user is its
own contract neuron declared via aiko, never a script. The canonical
set (one declaration per row on the ledger):

- `channel:telegram:lekt8` — Aiko Telegram bot
- `channel:telegram:getfoundry` — Foundry Telegram bot
- `channel:x-dm:lekt8_` — X direct message to @lekt8_
- `channel:x-dm:getfoundry` — X direct message to @getFoundry
- `channel:email:lewistham9x` — Resend to lewistham9x@gmail.com
- `channel:claude-code-session` — in-thread reply
- `channel:push-notification` — orchestrator-side PushNotification

Each channel is declared with `aiko "channel:<id> <metadata>"
--remote`. The ledger row IS the registry. Future reads parse the
ledger file directly (Foundation, not subprocess).

The "best channel right now" is **another aiko declaration**, not a
script: `aiko "channel:pick urgency=<u> kind=<k> ts=<now>" --remote`.
The cloud aiko's compiler reads the channel-ledger rows in context,
scores them per the urgency/kind/time-of-day evaluator-aikos pinned
in the ledger, and returns the chosen `channel:<id>` as the promoted
stdout pointer of the pick neuron.

Escalation ship: the escalation child contract carries
`posthook_pointer` resolved by the picker's stdout pointer. When the
child's evaluator threshold trips, the substrate fires the posthook
to the channel's send-binding (`/v1/contract/posthook` on Unbrowse
routes the body to Telegram / X DM / email per the channel
declaration's send-endpoint).

The orchestrator never wraps any of this in bash. It declares neurons
via aiko; the substrate fires the chain.

## No scripts in the contract substrate — collapse to binary + contracts

The `scripts/` folder of this skill contains ONLY the canonical
signed-binary set:

```
aiko aiko.sig contract contract.sig build.sh dist.sh sync-outline-explainer.sh
```

Anything else — channel registries, channel pickers, send-helpers,
iterate-loop runners, escalation routers — is **leaven**. The
substrate is the substrate. A bash wrapper around `aiko` violates
"no caller-visible options" (there is The Way) and "smallest local
surface" (state lives in the append-only ledger, not in a CLI
surface).

**Folder guard contract** — declared on the ledger, evaluated on
every aiko build:

> "scripts/ folder of ~/.claude/skills/contract/ contains exactly
> {aiko, aiko.sig, contract, contract.sig, build.sh, dist.sh,
> sync-outline-explainer.sh}. Any additional file = HOLD; the build
> refuses to sign; the offending file is rejected before it can be
> invoked."

Pinned as `contract guard:scripts-allowlist`. The build.sh checks
this contract before signing the binary; on drift, sign fails. The
guard is mechanical (a contract evaluator firing on a file-listing
metric) — not a shell script of its own.

How functionality lands without scripts:

- **Channel registry**: each contact channel is one aiko declaration
  on the ledger (see section above).
- **Picker**: another aiko declaration; cloud aiko picks + promotes.
- **Iterate loop**: parent contract's recursive DAG propagation IS
  the loop (per the HOLD-non-terminal rule above). Declare parent
  + N child resolver-wave contracts with chained `parent_id`. The
  substrate fires the chain automatically on each child's evidence
  resolution. No wrapper.
- **Escalation ship**: the child carries `posthook_pointer` resolved
  by the picker contract; substrate fires the posthook to the
  channel's send-endpoint when the child's evaluator trips.

When a piece of functionality WOULD be a script, ask: *is this a
truth claim I can declare?* Almost always yes. The script melts
into the ledger.

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

**Posthooks are opt-in per call. Setting `CONTRACT_POSTHOOK_ID` as an
executor-level default is an anti-pattern:** non-applicable spawns
(executor declarations, identity rows, auto-chain meta-contracts) have
no shape-matched output for the hook to consume, so propagation hangs
at the breakpoint forever; the hook's own handler chain spawning
`aiko` inherits the same id, risking infinite recursion. A caller
sets `CONTRACT_POSTHOOK_ID` in its own scope only when its spawn's
output shape matches what the hook handles. Break mechanisms when a
hook misbehaves: (a) per-call opt-out — the default; don't set it;
(b) declare a contract that `contract merge`s the misbehaving hook
into a no-op, superseding it without violating append-only; (c)
server-side posthook resolver enforces a deadline and a recursion
guard (strip `CONTRACT_POSTHOOK_ID` before spawning the handler
chain). Rule is contract `82399fbd`.

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
