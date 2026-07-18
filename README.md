# /aiko

Minimal native aiko/contract-neuron primitive. `aiko` is the public binary;
`contract` is the ledger row/type name and compatibility alias for the same
shape.

```bash
aiko "<goal>"             # shared (default) — declared toward the Unbrowse cloud ledger
aiko "<goal>" --private   # local-only — never leaves this machine
```

The binary is the public verb. Invoked as `aiko` it accepts one goal and the
single optional visibility flag `--private`; any other flag is refused. The
verb surface (`declare`, `status`, `tick`, `serve`, …) rides on the `contract`
invocation of the same binary (argv[0] selects the persona).

## The reduced closed loop

There is one execution path:

```text
declare → trigger → resolve dependencies → cache hit or execute → verdict
        ↑                                                   │
        └──────────────── invalidate dependants ────────────┘
```

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
```

An occurrence is materialized once. A new occurrence invalidates cached truth
and sends the contract back through the same resolver. There is no separate
cron/pod execution path.

The `contract` invocation of the same binary carries five verbs:
`declare <goal> [--action <ptr>] [--parent <id>] [--fast|--resolve|--register]`
(a `--register` declare prints the id on stdout and a briefing on stderr —
the proven route plus open roots), `recommend <goal>` (the learned router),
`status [<id>]`, `tick [--every <s>]` (one resolver pass, or resident with
`--every`), and `import-root <seed-file>`. The old `discover` / `search` /
`serve` / `self` names remain accepted as aliases onto status / recommend /
tick / the identity line, but are no longer documented surface.

The shared (default) aiko path is bound to Unbrowse and x402-native:
declarations POST to the hardcoded `https://beta-api.unbrowse.ai` — no env
override remains. Without payment the server returns a 402
payment-requirements envelope; that is a valid result proving the substrate
fired, and unpaid declares queue visibly under `~/.contracts/pending-declares/`
for retry. `--private` uses the same neuron shape against the local scoped
ledger.

`aiko` guards privacy before network egress. Local declarations are reduced to
patterns and meta-patterns: obvious emails, local filesystem paths, and
secret-like tokens are replaced with `[email-pattern]`, `[local-path-pattern]`,
and `[secret-pointer-pattern]`. The server may resolve pointer values inside
typed context, but the local binary does not leak machine-specific private
values.

Every declaration is a `neuron` row. The server-side DAG owns verifier
selection, child spawning, evidence integration, threshold firing, and recursive
propagation to parent and contract-ref neurons.

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

For `aiko`, the compiler is recursive and same-shaped: one shared
`aiko "<goal>"` prompt becomes a root aiko contract, and the Unbrowse LLM emits child
prompts as more aiko contracts that may themselves carry child prompts. The
local binary still sends only one sanitized goal; every child is appended server-side as a
`neuron` row with a `parent_id` edge.

Aiko truth is metric-gated. A node resolves true only when the declared goal is
true against evaluator aikos bound to external metrics, ledger metrics, or API
metrics. When the goal and its evaluators resolve true, the solved aiko is
promoted upward as a parent-layer `contract:<id>` pointer. That pointer is the
child's typed stdout for the parent aiko that requested it. The compiler is
stateless: prompt in, typed tree out; state lives in the append-only ledger.

Posthook webhooks are declared as pointers on the contract. After promotion,
Unbrowse POSTs the full contract context tree to `posthook_pointer` and appends
a `called` row with `call_kind=posthook`. That is how local and remote aikos
call each other after resolution: write the webhook pointer into the contract,
then call the pointer after the contract resolves.

The reduced vocabulary is: `aiko` for the primitive/environment, `contract` for
the row type, `parent_id` for containment, `contract:<id>` for dependency
pointers, `posthook_pointer` for after-resolution calls, `wallet_identity` for
signing identity, `replicated_from_contract_id` for paid out-of-lineage copies,
and `network_tunnel_contract_id` for WireGuard/Tailscale/WARP-style reachability
adapters.

There are no env knobs: the binary reads only `HOME`, and the Unbrowse
endpoint is a hardcoded constant. The ledger resolves to
`<cwd>/.claude/contracts.jsonl` when `<cwd>/.claude/` is a directory, else to
the global `~/.contracts/contracts.jsonl`. The public command stays
`aiko "<goal>" [--private]`.
