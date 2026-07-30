# Contract

Minimal native Contract-neuron primitive. `contract` is the checked-task,
ledger, inspection, and operator surface. The separate Aiko agent harness owns
the `aiko` command and links the kernel directly through `libcontract`.

```bash
contract task begin "<goal>" --check "<real proof command>"
contract task verify <id>
```

There is no goal-only public persona. Aiko records conversational turns through
the native ABI; actionable work uses checked tasks so completion has evidence.

## The governed graph

Contract still has one resolver and one ledger, but improvement is no longer
modeled as one unqualified loop. Typed rows can carry one of six agency roles:
`purpose`, `sensor`, `action`, `evaluator`, `governor`, and `development`.
Legacy rows remain readable and are reported as `legacy_ungoverned`.

The normal execution path remains:

```text
declare → trigger → resolve dependencies → cache hit or execute → verdict
        ↑                                                   │
        └──────────────── invalidate dependants ────────────┘
```

For governed work, the resolver adds explicit control edges:

```text
purpose → governor → action
                       ↑
                    sensor ← external reality anchor
                       ↓
                   evaluator → veto / promote
```

High-risk typed actions—network mutation, deployment, messaging, payment,
on-chain activity, and human-impacting decisions—cannot execute until their
declared reach has explicit approval and matching consequence-sensor evidence.
Fresh contradiction bypasses a positive cache, invalidates dependants in the
same resolver tick, and can roll back only to a verified, unrevoked,
policy-compatible checkpoint.

Every mutation-facing CLI command enters the same resolver tick. Run it once
with:

```bash
contract tick
```

or keep it resident:

```bash
contract tick --every 5
```

Import an existing root without placing it in argv or logs:

```bash
chmod 600 /path/to/root-seed.hex
contract import-root /path/to/root-seed.hex
```

The file may contain either a 64-character hexadecimal seed or a Base64-encoded
64-byte Ed25519 `seed || public-key` pair. The latter is checked for internal
seed/public-key consistency. The importer writes through Security.framework,
reads the key back for verification, removes managed plaintext root mirrors,
and prints only the derived public identity. It never deletes the source file;
remove that file yourself after the signed build verifies. A Keychain-only root
will not be silently copied back to `~/.contracts/root.key`.

## Building from source (single clone)

This is the recommended way to get a working `contract` binary from source
after the published `typed_neuron` dependency change (Option A).

Requirements: Zig 0.16 or newer.

```bash
# 1. Clone only this repo
git clone git@gitea:Unbrowse/contract.git
cd contract

# 2. Fetch the canonical typed-neuron wire (published on gitea)
#    Replace the commit with the one you want to pin.
zig fetch 'git+ssh://git@100.67.11.99:2222/Unbrowse/neuron.git#1e69ca97462b63502dd24fedbac8aacfb583928b'

# 3. Build the core library (this pulls the neuron dep via the .url in build.zig.zon)
cd libcontract
zig build

# 4. (Optional) Build the full signed pipeline + CLI
cd ..
./scripts/build.sh
```

After step 3 you will have a usable `libcontract`. The `scripts/contract`
wrapper (or the installed binary) is what you use for:

```bash
scripts/contract task begin "<goal>" --check "<real proof command>"
scripts/contract task verify <id>
```

See `libcontract/build.zig.zon` for the exact current URL + hash and the
one-line `zig fetch` command.

Packaged Aiko distributions ship a pre-linked `libcontract` — you do not need
to do the above unless you are doing source development on the kernel.

## On-chain execution

On-chain/Solana submission is disabled by default. The local ledger, signing,
cache, scheduler, and resolver do not require it.

The only value-moving executable is built separately:

```bash
cd libcontract
zig build broadcast-tool
```

Even when built, every submission requires an explicit runtime flag:

```bash
broadcast-tool --onchain <keypair.json> <card.json> <mainnet|devnet|localhost>
```

Without `--onchain` it refuses before loading a keypair or contacting an RPC
endpoint. Transaction construction and card generation remain available as
offline, non-broadcast operations.

The canonical dependency is `contract:<id>`. Existing `blocked_by`, `bind`,
`prehook`, and composition action names remain readable for ledger
compatibility, but new contracts should express ordering with `contract:<id>`.
Truth aggregation defaults to all dependencies; use `quorum:<n>` only when
independent corroboration is actually required.

Schedules are occurrence-keyed:

```text
at:<unix-seconds>
repeat:<N>s
repeat:<N>m
repeat:<N>h
when:contract:<id>
when:event:<name>
```

An occurrence is materialized once. A new occurrence invalidates cached truth
and sends the contract back through the same resolver. There is no separate
cron/pod execution path. Dependency occurrences bind to the dependency's
latest satisfied proof. Named events bind to a workspace-scoped `signal` row.
Native hosts use ABI v12's canonical Neuron firing, immutable Skill admission
lifecycle, worker lineage, typed Skill-graph expansion, dependency-ready node
claim/lease/settle, digest-pinned worker adapters and scripts,
credential-rejecting authoritative evidence plus reconstructible
content-addressed caches, canonical
effect-outbox settlement, bounded tick/lease/settle, and
binary-muscle surfaces. Expired, unsettled leases are delivered again.

The pure firing contract is not duplicated here. `libcontract/build.zig.zon`
imports the `typed_neuron` package. By default this is fetched from the
published git source (Unbrowse/neuron on gitea). The generated
`typed-neuron.lock.json` content-pins the wire for fidelity.

Source builds can use either:
- the published git dependency (preferred for "one clone" experience), or
- a sibling checkout (still supported for local development).

See `libcontract/build.zig.zon` for the current declaration and the exact
`zig fetch` command needed to materialize the content hash.
Packaged Aiko distributions contain the already-linked `libcontract` runtime.

One production Neuron settlement is one append-only `neuron_transaction`.
It contains the canonical firing, authoritative evidence payload, node
settlement, and pending effect-outbox rows. The transaction is the
linearization point: evidence blobs written afterward are reconstructible
caches, not a second truth. Aiko commits a consequential tool effect to this
outbox before dispatch and acknowledges that exact effect through ABI v12
after the adapter returns. Replays do not redispatch; uncertain outcomes remain
parked for reconciliation.

The `contract` invocation of the same binary carries these primary verbs:
`declare <goal> [--action <ptr>] [--parent <id>] [--agency <schema-v1-json>]
[--fast|--resolve|--register]`
(a `--register` declare prints the id on stdout and a briefing on stderr —
the proven route plus open roots), `recommend <goal>` (the learned router),
`status [<id>]`, `tick [--every <s>]` (one resolver pass, or resident with
`--every`), `events [--trace <id>]`, `watch [<trace-id>] [--json]`,
`explain <trace-id>`, and `import-root <seed-file>`. The old `discover` / `search` /
`serve` / `self` names remain accepted as aliases onto status / recommend /
tick / the identity line, but are no longer documented surface.

`contract task verify <id>` emits a linked action → command-result sensor →
exit-policy evaluator trace. Inspect it without touching wallet state:

```bash
contract events --trace "task-<id>"
contract explain "task-<id>"
contract watch "task-<id>" --json
```

The causal stream is written to `.claude/events.jsonl` when the project has a
`.claude` directory, otherwise to `~/.contracts/events.jsonl`. The offline
renderer at `tools/contract-events.html` accepts that JSONL by file drop and
makes no network requests.

Every checked task is a ledger row with an executable proof condition. Aiko's
foreground turns use the same kernel through the native ABI without invoking
the operator CLI.

`parent_id` is the containment edge: each parent wraps the child as a new
environment layer. `contract:<id>` is a cross-edge dependency. The Unbrowse LLM
integrates context server-side and spawns the next child contract environments.

Prehooks and posthooks are also contracts, carried by environment:
`CONTRACT_PREHOOK_ID` / `CONTRACT_PREHOOK` and `CONTRACT_POSTHOOK_ID` /
`CONTRACT_POSTHOOK`. They are breakpoints for API, Telegram, local Mac, VM,
Turbobox, and Unbrowse-spawned environments.

PreTool context is a server-side stateless event bus over ledger contracts:
`CONTRACT_EVENT_BUS_ID` / `CONTRACT_EVENT_BUS`,
`CONTRACT_PRETOOL_EVENT_ID` / `CONTRACT_PRETOOL_EVENT`, and
`CONTRACT_EVENT_KIND` / `CONTRACT_PRETOOL_KIND`.

Adapters are server-side contracts too. Local environments carry only
`CONTRACT_ADAPTER_ID` / `CONTRACT_ADAPTER` and adapter kind pointers. The
Unbrowse LLM compiles the user's prompt text into the root declaration plus the
child contract graph, including adapter, hook, and verifier contracts.

Aiko truth is metric-gated. A node resolves true only when the declared goal is
true against evaluator aikos bound to external metrics, ledger metrics, or API
metrics. When the goal and its evaluators resolve true, the solved neuron is
promoted upward as a parent-layer `contract:<id>` pointer. That pointer is the
child's typed stdout for the parent neuron that requested it. The compiler is
stateless: prompt in, typed tree out; state lives in the append-only ledger.

Posthook webhooks are declared as pointers on the contract. After promotion,
Unbrowse POSTs the full contract context tree to `posthook_pointer` and appends
a `called` row with `call_kind=posthook`. That is how local and remote aikos
call each other after resolution: write the webhook pointer into the contract,
then call the pointer after the contract resolves.

The reduced vocabulary is: `contract` for checked task operations and the row
type, `parent_id` for containment, `contract:<id>` for dependency
pointers, `posthook_pointer` for after-resolution calls, `wallet_identity` for
signing identity, `replicated_from_contract_id` for paid out-of-lineage copies,
and `network_tunnel_contract_id` for WireGuard/Tailscale/WARP-style reachability
adapters.

There are no env knobs: the binary reads only `HOME`, and the Unbrowse
The ledger resolves to
`<cwd>/.claude/contracts.jsonl` when `<cwd>/.claude/` is a directory, else to
the global `~/.contracts/contracts.jsonl`. The public operator command is
`contract`.

## Keychain and signing boundary

Routine signing first resolves the root from mode-600 file mirrors and caches
it for the process. A fresh file-backed initialization does not open or write
Keychain. Help, status, task status, events, watch, explain, and self dispatch
before wallet, retry, and network paths; observing Contract therefore cannot
request signing material. Native Keychain access remains explicit for
keychain-only import, rotation/maintenance, or recovery when both file mirrors
are absent.

Run the regression checks with:

```bash
CONTRACT_BIN="$PWD/scripts/contract" ./tools/audit-readonly-keychain.sh
./tools/scan-runtime-secret-leaks.sh
```

For the complete schema, migration behavior, adversarial evidence, benchmarks,
and release proof, start at `docs/AGENCY-SUBSTRATE.md`.
