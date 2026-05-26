---
name: contract
description: Minimal native contract-neuron primitive. Declare one truth claim; the server-side DAG integrates evidence, spawns child neurons, and recursively fires affected neurons until the graph settles.
user-invocable: true
---

# /aiko

`aiko` is the user-facing substrate. There is no other USER-FACING surface
— no second user CLI, no verb dispatch, no migration alias. The binary
the caller invokes is always `aiko "<goal>" --remote|--local`.

`contract` (as a binary in `scripts/`) is **NOT** a second user-facing
CLI. It is the wallet-side build/attestation tool — built from the same
Zig source as `aiko` with a different `BINARY_NAME`, exposing the
compat verbs `sign-binary`, `verify-self`, `verify-binary` that
`build.sh` calls during the build pipeline. The actual ed25519 signing
is the **wallet operation**: the deployer keypair at
`~/.aiko/keys/deployer.key` (root seed → HKDF-derived binary-signing
key via `libcontract.Lineage`) signs the binary's SHA-256 and writes
`<binary>.sig`. The `contract` binary is the surface where that wallet
operation is reachable to the build pipeline; it is not a verb-bearing
CLI for end users. Substrate operators never type `contract <verb>` —
they type `aiko "<goal>"`. Only `build.sh` calls `contract`, and only
to invoke the wallet's signing capability.

`contract` (as a ledger row/type name) refers to a neuron declared via
`aiko`. The same word is overloaded: the ledger-row type and the
wallet-tool binary. Disambiguation in context:

- "declare a contract" / "the contract ledger" → ledger row, declared via `aiko`
- "the contract binary" / "contract sign-binary" → wallet-side build tool in `scripts/`

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
aiko            ← user-facing substrate (goal-only, no verbs)
aiko.sig        ← ed25519(SHA-256(aiko)) by deployer wallet
contract        ← wallet-side build/attestation tool (same source as aiko,
                  different BINARY_NAME; exposes sign-binary / verify-self /
                  verify-binary verbs ONLY to build.sh — never to end users)
contract.sig    ← ed25519(SHA-256(contract)) by deployer wallet
build.sh        ← canonical end-of-change pipeline: fmt → tests → build →
                  install → sign (via wallet through contract) → verify
dist.sh         ← distribution packaging
sync-outline-explainer.sh ← Outline doc mirror for the explainer
```

The `aiko` ↔ `contract` split is **not** "two CLIs". It is one source
compiled twice: the user-facing build (`aiko`, goal-only) and the
wallet-side build (`contract`, build-tool with compat verbs). The
wallet (`~/.aiko/keys/deployer.key`) is what actually signs; the
`contract` binary is just where the wallet's signing capability is
reachable to `build.sh`. Conceptually: `contract sign-binary <path>`
≡ "wallet, sign this binary".

Anything else in `scripts/` — channel registries, channel pickers,
send-helpers, iterate-loop runners, escalation routers, USER-facing
bash wrappers around `aiko` — is **leaven**. The substrate is the
substrate. A bash wrapper around `aiko` violates "no caller-visible
options" (there is The Way) and "smallest local surface" (state lives
in the append-only ledger, not in a CLI surface).

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
accepts one goal and an optional `--remote|--local` transport pointer.
`--remote` routes to the Unbrowse contract ledger at the hardcoded base
`https://beta-api.unbrowse.ai` — there is no env override. `--local`
uses the same neuron shape against the local scoped ledger at
`~/.contracts/contracts.jsonl` (resolved from `HOME`, the one POSIX
identity read the binary makes).

`aiko` is x402-native. Faremeter Flex payment, when required, is
satisfied by the wallet derived from the binary's deployer keypair
(`libcontract.Lineage` HKDF). There is no env-provided payment header
to inject, no `AIKO_X_PAYMENT` / `X_PAYMENT` / `PAYMENT_SIGNATURE`
override, and no admin-bypass triple. If the wallet cannot satisfy
the 402, Unbrowse returns the canonical Payment Required envelope and
the orchestrator treats it as valid evidence.

`aiko` guards privacy before network egress. Local declarations are reduced to
patterns and meta-patterns: obvious emails, local filesystem paths, and
secret-like tokens are replaced with `[email-pattern]`, `[local-path-pattern]`,
and `[secret-pointer-pattern]`. The server may resolve pointer values inside
typed context, but the local binary does not leak machine-specific private
values.

There are no public action, parent, iterate, mark, spawn, status, or
search choices, and there are **no environment variables**. The binary
reads only `HOME` (for ledger path resolution) and ignores every other
env — `CONTRACT_*`, `AIKO_*`, `UNBROWSE_*`, `X_PAYMENT`,
`PAYMENT_SIGNATURE`, `CONTRACTS_STORE`, `SHELL`, `TERM` are all unread.
Lineage, hooks, adapters, event-bus pointers, budgets, thresholds,
identity overrides, payment headers, admin bypass — every one of these
that used to be configurable by env has been hard-wired or moved to
server-side state (the cloud reconstructs lineage from wallet identity
+ declare timestamp). A caller that wants to read the local ledger
reads the file; a caller that wants to write goes through `aiko`.
Anything else is a backwards-compat hack and is rejected.

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
-> server-side lineage assignment from wallet identity + declare timestamp
-> integrate child evidence
-> run the server-selected harness/funnel/loop verifier
-> fire when its threshold resolves true
-> recursively fire contained children, affected parents, and contract-ref neurons
-> stop when the DAG settles or evidence is missing
```

`parent_id` is the containment edge. It means one environment owns
and wraps another environment, not merely that one task is listed
under another. The fractal hierarchy is atom -> cell -> tissue ->
organ -> organism in the same mechanical sense: each child contract
runs inside the environmental field created by its parent, and that
parent can itself be a child of a larger environment.

Lineage is **server-determined**. The local binary sends only the
goal and the transport pointer; the cloud reconstructs containment
from wallet identity + declare timestamp + active thread. There is
no env-based parent-id propagation, no caller-supplied parent flag,
no in-process lineage passing via setenv.

**Spawn vs resolve are different axes.** Don't conflate them.

- **Spawn** = create a NEW contract row. The canonical mechanism is
  `ledger.appendRow` (local file) or `client.declareRemote*` (cloud
  ledger). Whichever transport the parent used, every child IS a
  row in some ledger; the row schema is uniform; `parent_id` links
  child→parent. Subprocess fork is an OPTIONAL extension for
  cross-environment spawn (SSH/Docker/foreign-host aiko); the
  semantic remains the same — a new row appears in a ledger.

- **Resolve** = iterate EXISTING rows, fire their actions, append
  status events (`iterated`, `satisfied`, `called`). The canonical
  mechanism is `backfillUnresolved` calling `runAction` in-process.
  This does NOT spawn new declared rows; it RESOLVES rows that
  already exist. Resolve runs in-process by design — forking a
  subprocess per row would be O(rows) fork overhead with no
  semantic gain.

Both axes ultimately produce rows on a ledger (spawn produces
`declared`/`child_added`/etc.; resolve produces
`iterated`/`satisfied`/etc.). The parent_id linkage is the same.
The verifier reads the ledger the same way for both.

The DAG is multidimensional. `parent_id` is the containment
dimension. `contract:<id>` references are cross-dimension dependency
edges. When a neuron fires, the substrate recursively fires
contained child neurons, containment ancestors, and dependent
cross-edge neurons until no newly-true signal propagates.

Hooks are contracts too. A prehook is another contract-neuron that
gets the spawned environment context and may hold execution before
the declared neuron is created. A posthook is another contract-neuron
that fires after the declared neuron resolves. Hooks are **declared
as ledger rows** (with `posthook_pointer` / equivalent prehook
field), not configured by local environment variables. Attaching a
hook means writing a contract row that points at the target neuron;
there is no `CONTRACT_PREHOOK_ID` / `CONTRACT_POSTHOOK_ID` envelope
to set, and the executor-level posthook default is an anti-pattern
(contract `82399fbd`).

Each hook is a breakpoint: if it cannot resolve, propagation waits
there with ledger evidence. The same shape applies whether the
environment is an API call, a Telegram bot contract, a local Mac
executor, a VM, a Turbobox, or another Unbrowse-spawned environment.

PreTool context is also contract-shaped. Every PreTool event becomes
a server-side ledger event contract appended to the bus when the
runtime emits it. The local binary does NOT read or pass PreTool
state through env (no `CONTRACT_EVENT_BUS_ID` / `CONTRACT_PRETOOL_*`
/ `CONTRACT_EVENT_KIND` are honored) — the bus and the events are
server-side rows the substrate looks up by contract id when
integrating evidence.

Adapters are contracts too, and they live on the server side. There
is no `CONTRACT_ADAPTER_ID` / `CONTRACT_ADAPTER_KIND` /
`CONTRACT_ENVIRONMENT_KIND` env to set. API, Telegram, local Mac,
VM, Turbobox, and Unbrowse executors are server-owned adapter
contracts that decide how to spawn and constrain the local executor.
The local binary advertises its environment fingerprint (uname +
available CLIs) as evidence; the server picks the adapter.

The public row uses the `neuron` shape. Typed verifier mechanics
such as cells, funnels, loops, harnesses, quorums, sequences, and
contract references are internal server-side wiring, not
caller-facing flags.

When `--remote`, the local binary POSTs the declaration to the
hardcoded Unbrowse base at `/v1/contract/declare`, where Unbrowse
may spawn more contracts on Unbrowse infra. The server-side LLM is
the integrator: it reads the active context, chooses which child
environments/verifiers to spawn, and returns only typed contract
pointers to the local executor. When `--local`, the same neuron
shape runs the one-shot lifecycle against the on-disk ledger; a
neuron with no child/evidence rows fails closed.

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
deployed, native keystore unavailable, file tier missing), the
fallback is **transparently chained with an evidence line to
stderr** — the caller doesn't need to configure or even know about
the fallback, but observers (the orchestrator, telemetry, a watching
human) ALWAYS see when a non-primary path engaged. When the fallback
is no longer needed, it is deleted in one commit, not flipped by
configuration.

**Fallbacks are visible, never silent.** This is the
non-negotiable observability invariant. Every degradation path
(`backfillMirrors` failure, keystore backend failure → encrypted
file, file tier missing → mirror tier served, wallet first-run
generation, rotation archive failure, etc.) emits ONE line to
stderr in the canonical evidence shape:

```
<topic>: <what happened> — <consequence-if-any>
```

Examples that fire during normal operation:

```
wallet: canonical tier missing at <path>, served from mirror tier <path>
wallet: both file tiers missing, served from OS keystore (svc=aiko.root.ed25519.seed)
wallet: FIRST RUN — generating fresh ed25519 root seed (no existing material in canonical/mirror/keystore tiers)
wallet: fresh root persisted to <path> (chmod 600); mirror + keystore back-filled best-effort
keystore: darwin write failed for svc=X: <err> — falling back to encrypted file
keystore: linux secret-tool unavailable (<err>) — falling back to encrypted file for svc=X
keystore: windows backend is a STUB — using fallback encrypted file for svc=X
wallet: rotation archive FAILED (rotation proceeds): <err> — old seed bytes are NOT preserved for HKDF re-derivation
```

Silent `catch {}` is an anti-pattern. The fallback STILL fires (the
substrate doesn't break) but it MUST surface, because a silent
fallback hides degradation until something else breaks downstream
and the cause is invisible. The evidence lines are the substrate's
proprioception — they tell observers which tier is bearing weight
right now.

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

Network durability is also a contract pointer.
WireGuard/Tailscale/WARP-style tunnelling belongs behind
`network_tunnel_contract_id` and `network_tunnel_kind`, declared as
ledger rows, not as another user mode. The tunnel adapter contract
keeps the spawned environment reachable; aiko still exposes only goal
+ mode.

## Wallet & Environment Binding — the definite pattern

When `/contract` binds to ANY environment (macOS, Linux, Windows, iOS,
Android, browser, server, embedded, foreign-app-embedded), the wallet
binding **comes with it as one inseparable unit**. There is no
"install /contract then separately set up a wallet" two-step. The
substrate spawns into an environment and the wallet is there.

### Invisible to the user

The user **never sees x402, never sees a wallet UI, never sees a
seed phrase, never sees a payment header.** They type `aiko
"<goal>"` (or, in an embedded app, take whatever action the host
surfaces) and the substrate handles every cryptographic concern:
key generation, key storage, key recovery, signature verification,
payment header construction, faucet onramp.

Any UX that surfaces "your wallet", "your seed phrase", "scan to
fund", "approve payment" to a user who didn't explicitly ask for
wallet UX is leaven. The wallet is the substrate's identity, not
the user's burden.

### OS-agnostic keystore via the `keystore` interface

Local secret storage is abstracted behind one interface
(`libcontract/src/keystore.zig`). The binary picks the backend at
compile time via `builtin.os.tag`:

```
darwin   →  macOS Keychain (security CLI shellout: find/add/delete-generic-password)
linux    →  libsecret (secret-tool CLI) → fallback: encrypted file
windows  →  Windows Credential Manager (powershell shellout) → fallback: encrypted file
ios      →  Keychain Services (FFI)
android  →  Android Keystore (FFI)
fallback →  encrypted file at $HOME/.aiko/keys/root.key.enc, passphrase
            derived from a stable machine fingerprint (uname + machine-id
            + binary signing pubkey)
```

The keystore interface is exactly three operations:

```
read(svc: []const u8)  -> ?[]const u8     // null = not found
write(svc, value)      -> !void           // upsert
delete(svc)            -> !void           // best-effort
```

Each backend is a small shim. Adding a new platform = adding one file
with three functions. The lineage layer doesn't know which backend
fired — it just asks `keystore.read("aiko.root.ed25519.seed")`.

### Three-tier bootstrap (every environment, same shape)

Whatever the OS, root-key resolution follows the same three-tier
ladder (extending the macOS-only version from contract `b8a4f217`):

```
1. Canonical file:  $HOME/.contracts/root.key                 (chmod 600)
2. Mirror file:     $HOME/.aiko/keys/root.key                 (chmod 600)
3. OS keystore:     keystore.read("aiko.root.ed25519.seed")   (platform-native)
4. Generate fresh:  arc4random_buf → write to all three (atomic)
```

After ANY successful read, missing tiers silently back-fill. Generation
only happens when all three miss (true first-run on a clean machine).

### App-embed mode — the wallet builds itself into the app

When an app embeds `/contract` (iOS app, Android app, browser
extension, foreign CLI), the binary's bootstrap path is the same as
on a developer's Mac — same `keystore.zig`, same three-tier ladder,
same recovery semantics. The app does not implement wallet UX; the
substrate's bootstrap IS the wallet UX, and it's invisible.

Embedded constraint: when the app cannot expose `$HOME` (some mobile
sandboxes), the file tiers degrade to no-op and the keystore tier
becomes the only persistence. That's the correct substrate behavior
— don't fight the sandbox; trust the platform keystore.

### Native onramp is the cloud's obligation, not the local binary's

When a fresh wallet is born, the local binary's job ends at "seed
generated + persisted to three tiers + pubkey advertised to server".
Funding the wallet (USDC for x402, gas, etc.) is the **server-side
/contract endpoint's responsibility**. The server receives the
declare → notices unfunded pubkey → triggers the onramp adapter
contract appropriate for that user/context (Privy embedded onramp,
Coinbase Onramp URL ride-along on the next user surface, faucet
credit from the Foundry treasury, etc.). The client never sees the
dance; the first declare may 402 once, then the orchestrator retries
and it passes.

This is the canonical "native onramp" pattern: **the cloud knows
how to fund a wallet for the context it is being asked to act in,
because adapter contracts encode that knowledge**. The local binary
stays minimal.

### Wallet rotation — `rotateRootKey` + `rotateAllSignedRowsByLineage`

Rotation is two functions in `libcontract/src/lineage.zig`:

```
rotateRootKey(allocator, env)
  // 1. Read current root (three-tier).
  // 2. Generate new seed via arc4random_buf.
  // 3. Sign a successor proof:
  //      msg = "wallet_rotated|" || sha256(old_pubkey || new_pubkey || ts)
  //      sig = sign(msg, old_identity_keypair)
  //    This proves the rotation was authorized by whoever held the old
  //    root — old → new is a verifiable chain.
  // 4. Atomically write new seed to all three tiers.
  // 5. Archive old seed to $HOME/.aiko/keys/.archived-rotated-<ts>/root.key.
  // 6. Append wallet_rotated event to local ledger:
  //      { event: "wallet_rotated", old_pubkey, new_pubkey,
  //        successor_signature, rotated_at }

rotateAllSignedRowsByLineage(allocator, env, old_root, new_root, ledger_path)
  // For every row with an env_pubkey/parent_signature signed by a
  // keypair derived from old_root + contract_id:
  //   - Derive new_keypair = HKDF(new_root, contract_id)
  //   - Sign the row's digest with new_keypair
  //   - Append a `resigned` event row:
  //       { event: "resigned", id: <row_id>,
  //         new_env_pubkey, new_parent_signature, rotated_by: <wallet_rotated event id> }
  // Original `declared` row is NEVER mutated (append-only invariant).
  // Verifier prefers the latest `resigned` row over the original on lookup.
```

`rotateRootKey` alone is sufficient for forward progress (new rows
sign with new root; old rows still verify against the pubkeys
stored on them — signature verification is on stored pubkey, not on
re-derived). `rotateAllSignedRowsByLineage` is the additional
re-sign walker for the operator who wants every row's signature to
trace to the current root.

Rotation is itself a contract: declare `aiko "wallet:rotate"
--remote`; the cloud aiko's compiler fires the local rotation
function and orchestrates the post-rotation re-sign walker. The
user types one short prompt; the substrate does everything.

## Doctrine-Reality Parity — the substrate supervises itself

Every claim in this SKILL.md has a corresponding code site. Drift
between doctrine and implementation is the substrate failing to
keep its word. To prevent silent drift, parity itself is **a
/contract** — a guard row declared on the ledger whose evaluator
walks the doctrine claims and greps for matching code. The guard
fires at every `build.sh` invocation (mechanical, not advisory).
Drift = HOLD = the build refuses to sign.

The guard is recursive: it is itself a /contract, and the rule
"every doctrine claim has a code site" applies to the parity
claim too. If the parity check itself doesn't have a code site,
the guard catches itself.

Concrete invariants enforced by `build.sh`'s parity step:

```
1. "no env vars are read" → grep -nE 'getPosix\("(CONTRACT_|AIKO_|UNBROWSE_|X_PAYMENT|PAYMENT_SIGNATURE|CONTRACTS_STORE|SHELL|TERM)' src/*.zig
                            must return ONLY the HOME read in ledger.zig/lineage.zig.
2. "scripts/ allowlist"   → ls scripts/ must equal {aiko, aiko.sig, contract,
                            contract.sig, build.sh, dist.sh, sync-outline-explainer.sh}.
3. "three-tier wallet bootstrap" → libcontract/src/lineage.zig must
                            contain `pub fn loadOrInitRootKey` AND reference
                            ~/.contracts/root.key AND ~/.aiko/keys/root.key AND keystore.
4. "OS-agnostic keystore" → libcontract/src/keystore.zig must export
                            `pub fn read`, `pub fn write`, `pub fn delete`.
5. "fallbacks surface, never silent" → no `catch {}` in
                            libcontract/src/{lineage,keystore}.zig (all must
                            be `catch |e| surface(...)`).
6. "rotation as a function" → libcontract/src/lineage.zig must export
                            `pub fn rotateRootKey` AND `pub fn rotateAllSignedRowsByLineage`.
7. "aiko binary has no verbs other than the goal + --remote/--local" → 
                            zig/src/main.zig parseAikoArgs must accept ONLY
                            --remote / --local (no --genesis, no --user).
8. "spawn = appendRow to a ledger" → every row-creating code path
                            flows through ledger.appendRow OR client.declareRemote*.
9. "binary self-attests at startup" → main.zig must call verifyBinary
                            on its own path before processing input
                            (unless attestation is bypassed by a contract).
10. "skill-sync auto-commits" → ~/.claude/skills/contract/.git exists +
                            recent commits contain "sync(contract):" prefix.
```

The parity check is a single shell function in `build.sh` — not a
new script, not a new binary, no addition to `scripts/`. It
respects the no-scripts-in-the-substrate rule by living inside the
canonical pipeline already there. When `build.sh` runs, parity is
checked before sign. Drift fails the build with a per-claim
failure line surfacing what drifted.

When adding a NEW doctrine claim, add a NEW invariant to the
parity check in the same commit. The build guard refuses any
doctrine change that lacks a matching invariant — "if you can
claim it, you can grep it."

## Ledger

The Unbrowse ledger is canonical. The local on-disk ledger at
`~/.contracts/contracts.jsonl` (or `.claude/contracts.jsonl` when a
project-scoped store exists) is only for `--local` lifecycle and
migration. Never edit rows in place; append events. There is no
`CONTRACTS_STORE` env override — the path is resolved from `HOME`.

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
