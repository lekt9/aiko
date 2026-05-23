# Π5 — Facilitator binding (the four-way payment routing layer)

> **The doctrine.** Every `x402:` action in /contract routes through ONE of four
> officially-supported facilitators, registered as standing-gate contracts in
> the global ledger. The user-side facilitator (their wallet binary — pay.sh,
> lobstercash, or agentcash) signs an `X-PAYMENT`; the merchant-side facilitator
> (Faremeter Flex on our self-hosted Corbits marketplace) verifies, holds,
> settles, and finalizes the on-chain split per `defaultSplits` in basis points.
> Our cut — 5000 bps = 50% — is baked into the facilitator config, not
> negotiated per call. Marketplaces register as first-class DAG nodes; any
> project can `--action contract:<facilitator-id>` to inherit the routing and
> the split through the substrate. **The DAG is the routing layer; Flex is the
> settlement layer; the split is the on-chain finalize.**

## The four facilitators, by role

The substrate doesn't pick one "winning" facilitator. It binds all four as
**parallel pointer-gated standing contracts** so any project can route per its
user's installed binary. The role-split is sharp:

| Facilitator | Side | Binary / install | Where the cut applies |
|---|---|---|---|
| **pay.sh** (`pay` skill) | user / wallet | Pay MCP + TouchID-gated approval; stablecoin rail (USDC/USDT/CASH) | upstream split lives at the merchant Flex; pay.sh just authorizes the X-PAYMENT |
| **lobstercash** (Crossmint) | user / wallet | `npx @crossmint/lobster-cli`; blockchain wallet + virtual cards; human approval | same — wallet-side; the bps cut applies at the merchant facilitator |
| **agentcash** (agentcash.dev) | user / unified balance | `npx agentcash@latest onboard`; "one balance, every API"; 782k+ paid tool calls live; integrates with Claude Code, Codex, Cursor, Gemini CLI, OpenClaw, Hermes | same — the unified-balance abstraction sits in front of any of the merchant facilitators |
| **Faremeter Flex** (x402-llm) | merchant / marketplace operator | `@faremeter/payment-solana/flex/facilitator` on the self-hosted Corbits stack | **HERE.** `defaultSplits` config carries `[{us, 5000}, {merchant, 5000}]` bps; the on-chain finalize after the refund window distributes the funds |

The "binary we are kinda building around unbrowse" Lewis named IS the
`/contract` CLI itself. Every `x402:` pointer it emits in Π1 / Π2 routes
through whichever wallet-side facilitator the user has installed,
landing at our Flex merchant facilitator for settlement.

## The 50/50 split (where it lives, in one paragraph)

Faremeter Flex's `defaultSplits` is the only place the cut is configured.
At facilitator init on our marketplace stack:

```ts
import { mergeSplits } from "@faremeter/flex-solana/facilitator";

const ourTokenAccount     = "<our-USDC-ATA-on-Solana>";          // unbrowse-owned
const merchantTokenAccount = "<merchant-USDC-ATA-on-Solana>";    // per-tenant

defaultSplits: mergeSplits([
  { recipient: ourTokenAccount,     bps: 5000 },   // 50 % to us
  { recipient: merchantTokenAccount, bps: 5000 },  // 50 % to upstream
])
```

`mergeSplits()` is mandatory — Flex rejects duplicate recipients with
`FLEX_ERROR__DUPLICATE_SPLIT_RECIPIENT`. Each split's `bps` is a u16 LE
field in the 158-byte canonical authorization (`x402-llm` SKILL.md
documents the byte layout under "Reference vector").

The split executes at **on-chain finalize**, not at settle. The flow:

```
client signs FlexPaymentPayload → facilitator verify → tryHold(maxAmount)
        → settle(actualAmount ≤ maxAmount) → refund window opens (~150 slots)
        → window closes → finalize is permissionless ("even cranking it forever
          doesn't keep the deadman timer alive") → defaultSplits distributes the
          funds to each recipient's token account per its bps
```

A 5000 bps cut on a $0.10 call = $0.05 to us, on-chain, settled in USDC.
Multiplied across the 782k+ paid tool calls AgentCash has already processed
across the x402 ecosystem in 2026: real volume.

## Why four facilitators, not one

The instinct is to pick one (Lobstercash because it's polished, Faremeter
because it's open) and route everything through it. Wrong, for three reasons:

1. **The user's wallet is already installed.** A user who set up
   `agentcash onboard` doesn't want to install `lobster-cli` to pay our
   marketplace. The wallet-side is determined by the user's existing
   choice; the merchant-side (Flex) is determined by us. Routing through
   their wallet is friction-free; making them switch is churn.

2. **All four implement the same x402 wire protocol.** From the
   merchant's perspective, an `X-PAYMENT` header is an `X-PAYMENT`
   header — pay.sh's, lobstercash's, agentcash's, or a future fifth
   wallet all sign over the same FlexPaymentPayload bytes (the 158-byte
   canonical layout in `x402-llm` SKILL.md). Flex verifies the signature
   regardless of which client signed.

3. **The DAG decouples them by index, not by code.** Each facilitator
   gets a standing-gate contract id. A project binds with
   `--action contract:<id>` and the substrate resolves the current
   facilitator's status. Swap a facilitator out, the binding stays.

## Standing-gate registration (the substrate-side rows)

Four `agent-judges` contracts, one per facilitator, registered in the
global ledger (same `contract promote` pattern as the served-surface
gate `27125bd7` and empathy gate `4a055cf7`):

| Facilitator | Standing-gate id | Side | Bound binary |
|---|---|---|---|
| pay.sh | `04073c2e` | wallet | `pay` MCP + TouchID |
| lobstercash | `4d4aefd3` | wallet | `npx @crossmint/lobster-cli` |
| agentcash | `bae5730b` | wallet / unified | `npx agentcash@latest onboard` |
| Faremeter Flex (Corbits marketplace) | `68c6de71` | merchant / split-config | `@faremeter/payment-solana/flex/facilitator` on our self-hosted stack |

Plus the 50/50 split policy as its own contract: `0f957e72`.

Any project can compose:

```bash
contract declare "this product's billing routes through any of our 4 wallets and our Flex merchant" \
  --action funnel
# returns <project-root>

contract declare "wallet facilitator available" \
  --action contract:1be25e93    # agentcash — or 4d4d3ba6 / bd9c7a5a — or all three via funnel-first
  --parent <project-root>

contract declare "merchant facilitator with 50/50 split active" \
  --action contract:87cd9c2f
  --parent <project-root>

contract declare "50/50 rev-split policy enforced at finalize" \
  --action contract:8c1ac75c
  --parent <project-root>
```

The `contract:<id>` pointer-type resolves each facilitator's current
status from the ledger; an outage at one wallet doesn't fail the project
if it's `funnel-first` over a multi-wallet child set.

## What lives where (substrate vs deployment)

Per the unbrowse-payments-canonical rule (Π2 doctrine): **keys + settle
live at unbrowse, never in /contract.** The substrate-side scope is:

- **Substrate (/contract):** standing-gate contracts naming each
  facilitator + their role + their binary; the `x402:` pointer that
  surfaces `=== PAYMENT REQUIRED ===` blocks when the merchant returns
  402; the doctrine doc binding the 50/50 policy.
- **Server (unbrowse, deployment):** the actual `defaultSplits` config
  on our Corbits stack; the merchant token account address; the
  `flush()`/`getHoldManager()`/`stop()` lifecycle; the on-chain finalize
  cranker. None of this lives in `~/.claude/skills/contract/`.
- **Client (user device):** whichever wallet binary the user installed
  (pay/lobstercash/agentcash). The substrate's `machine:` pointer-type
  (Π3) handles cross-host resolution; the wallet's `X-PAYMENT` signing
  happens in its own process.

## The marketplace primitive (anyone can register one)

Lewis's framing: "we wanna support marketplaces as well to /contract it
such that they are officially supported and called whenever via
/contract properly in our DAG system bound to these things." A
marketplace is just a `faremeter/marketplace` stack with a facilitator
config. Anyone running one (us first, partners next) registers via:

```bash
# On any host running a Corbits marketplace stack:
contract declare "marketplace <name> live at <base-url> with 50/50 defaultSplits" \
  --action 'curl -fsS <base-url>/.well-known/faremeter-facilitator | jq -e ".defaultSplits | length >= 1"'
# Verify the well-known surfaces the split config, then:
contract promote <id>
```

`contract promote <id>` lifts the row from the project ledger to the
global ledger, where any project can pointer-gate it via
`--action contract:<id>`. That's the "officially supported marketplace"
registration — one row in the global ledger, queryable by
`contract search --context "marketplace faremeter"`.

## What's deferred (named, Β1-captured)

The doctrine ships today; four discrete shipments wait on the
deployment side:

1. **`defaultSplits: [{us, 5000}, {merchant, 5000}]`** baked into our
   live Corbits marketplace facilitator config (not in this skill — at
   the unbrowse deployment).
2. **Our USDC token account on Solana mainnet** registered with the
   facilitator at init (operational, not substrate).
3. **`/.well-known/faremeter-facilitator` endpoint** on the marketplace
   serving the verify+settle URLs + the defaultSplits for any project
   probing facilitator health.
4. **AgentCash + lobstercash binary detection** at `unbrowse setup`
   time, so the CLI knows which user-side facilitator to default to
   when surfacing `=== PAYMENT REQUIRED ===` blocks.

Each ships as its own contract when the deployment-side work lands.

## In one sentence

The substrate names four facilitators, binds the 50/50 split to Flex's
`defaultSplits`, registers each as a standing-gate contract any project
can pointer-bind — the DAG IS the routing layer, Flex IS the settlement
layer, the on-chain finalize IS the cut.

Origin: contract `5e1c4b14`, 2026-05-24. Lewis: "relevant binaries that
we can tie to would also be /find-skills pay.sh type stuff and
agentcash.dev type binaries, likewise with lobster.cash that must be
tied together via the /contract binary we are kinda building around
unbrowse, and we should ensure that /contract is building the proper
faremeter flex system… so that we can /contract it such that we take a
cut of 50% of all 402 volumes whereas the rest are split, we wanna
support marketplaces as well to /contract it such that they are
officially supported and called whenever via /contract properly in our
DAG system bound to these things because we collect the /contract DAG
type shit." Faremeter Flex docs read at
`https://docs.faremeter.xyz/flex/facilitator` (defaultSplits bps shape,
mergeSplits dedup, refund-window/finalize lifecycle confirmed live).
The 4 skills (`pay`, `lobstercash`, `agentcash`, `x402-llm`) already
shipped; this doc binds them as the canonical facilitators of /contract
Π5.
