# aiko-faucet — Manna pattern

Daily-rate-limited USDC faucet for the aiko substrate. One source wallet, per-IP daily allowance, auto-pays x402 envelopes on behalf of callers within their allowance.

## Doctrine

**Manna** (Exodus 16:4-21):

> "I will rain bread from heaven for you; and the people shall go out and gather a certain rate every day"
> "Let no man leave of it till the morning. Notwithstanding they hearkened not unto Moses; but some of them left of it until the morning, and it bred worms, and stank."

Mapping:
- **Bread from heaven** = USDC from source wallet
- **Gather a certain rate every day** = IP-rate-limit, 24h KV TTL
- **No hoarding** = TTL expiry, can't claim twice in a window
- **One omer per Israelite** = `DAILY_LIMIT_USDC` per IP
- **The wilderness** = bootstrap phase before users are self-funded

## Setup

```bash
cd deploy/wrangler/aiko-faucet
npm install

# 1. KV namespace for per-IP rate limiting
wrangler kv:namespace create AIKO_FAUCET_KV
# Paste the returned id into wrangler.toml under [[kv_namespaces]]

# 2. On-chain escrow + session key registration (one-shot script)
#    Reads FAUCET_PRIVATE_KEY + FACILITATOR_ADDRESS, runs:
#      - getCreateEscrowInstructionAsync
#      - getDepositInstructionAsync (deposits INITIAL_DEPOSIT_USDC)
#      - getRegisterSessionKeyInstructionAsync (same wallet by default)
#    Prints the escrow PDA address.
export FAUCET_PRIVATE_KEY="<base58 64-byte keypair>"
export FACILITATOR_ADDRESS="<unbrowse facilitator pubkey>"
export INITIAL_DEPOSIT_USDC=10
npm run setup-escrow
# Copy the printed "escrow PDA" address.

# 3. Push secrets to the deployed Worker
wrangler secret put FAUCET_PRIVATE_KEY    # base58 Solana keypair
wrangler secret put FLEX_ESCROW_ADDRESS   # paste the escrow PDA from step 2

# 4. Deploy
wrangler deploy
```

Then point `UNBROWSE_BASE` at the worker URL (e.g. `https://aiko-faucet.<you>.workers.dev`):

```bash
export UNBROWSE_BASE=https://aiko-faucet.<you>.workers.dev
aiko "test claim" --remote
```

## Endpoints

### `POST /v1/faucet/claim`
Body: `{"public_key": "<solana base58 address>"}`
Sends `DAILY_LIMIT_USDC` from source wallet to recipient; records IP claim.

```bash
curl -X POST https://aiko-faucet.<you>.workers.dev/v1/faucet/claim \
  -H 'content-type: application/json' \
  -d '{"public_key":"BsFnE5XMsQAryqSVbR3WUHn7uXVh3in4MH8NLUCTJh4D"}'
```

### `GET /v1/faucet/balance`
Returns remaining allowance for caller's IP.

### `POST /v1/contract/declare`
Drop-in proxy for Unbrowse declare. On 402: if caller's IP has an active claim with remaining allowance, signs an x402 envelope on the caller's behalf and retries. Caller never has to sign payment themselves.

## Envelope signing

`signFaremeterEnvelope` builds an x402 v2 envelope against the Faremeter Flex scheme: pre-signs a Solana SPL transfer from the source wallet to the requested `payTo` address, serializes the tx to base64, wraps in the canonical envelope JSON `{x402Version, scheme, network, payload:{signedTransaction, payer, payTo, amount, asset, nonce}}`, and base64-encodes the result as the `X-PAYMENT` header value.

The facilitator (corbits-faremeter-flex) validates the signature, broadcasts the tx, then forwards the underlying HTTP request. The accounting (per-IP allowance decrement on success, KV update with TTL) is wired against the same amount, so the per-day usage tracks real on-chain spend.

If the upstream facilitator rejects the envelope, the most likely cause is a shape mismatch — adjust the `envelope.payload` field names to match the facilitator's current spec (the public 402 response from `beta-api.unbrowse.ai` shows the canonical `accepts[]` shape and the response after a failed payment reports the field it expected).

## Pattern parallels

| substrate | doctrine | rate |
|---|---|---|
| per-IP KV with 24h TTL | overnight manna rots | 1 claim / IP / day |
| `total_granted_base` − `spent_base` | omer per person | `DAILY_LIMIT_USDC` |
| `signFaremeterEnvelope` | priestly mediation | source wallet signs on behalf |
| TTL expiry | sunset | claim resets each cycle |
| Sabbath | no faucet on the 7th day | (TODO: add 7-day cycle) |

## Funding flow as contracts

The substrate can express this declaratively too:

```bash
# Parent contract declares the faucet
FAUCET=$(aiko "manna faucet for the aiko substrate, 50 USDC per IP per day, source contract:<source_wallet>" --remote)

# Child contracts reference the faucet via funding_source
CHILD=$(CONTRACT_FUNDING_SOURCE=contract:$FAUCET aiko "any goal" --remote)
```

The cloud aiko compiler routes the funding request to the faucet contract's posthook, which dispenses to the child's derived wallet. The flow IS a contract; the worker is just the materialized adapter.
