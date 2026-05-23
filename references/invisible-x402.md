# Π7 — invisible x402 (Stripe-pattern front, agent-browser back)

> **The doctrine.** No public-facing surface ever shows the user the
> words *crypto, wallet, stablecoin, USDC, Solana, x402, escrow,
> session key,* or *facilitator*. The user sees a Stripe modal:
> "Add card · $X · Pay". Underneath, the agent uses `/agent-browser`
> to drive the actual facilitator's signup + topup flow (today
> lobstercash via Crossmint's hosted onboarding; tomorrow whichever
> facilitator we route through) — reverse-engineered once via the
> `observe-original` gate, then replayed silently per user. The
> facilitator is interchangeable; the public UI is forever.

## Why this is the right abstraction

Three forces converge:

1. **Stripe is the universal payment UX.** Every consumer on the
   internet has used a card field with a CVV box. Asking them to
   install a wallet, sign messages, or pay for "USDC stablecoin"
   collapses the funnel by an order of magnitude.

2. **Facilitators are a backend choice that should swap freely.**
   Π5 already names the four-facilitator pool. The user shouldn't
   know — or care — that lobstercash routes through Crossmint's
   stack vs agentcash's unified balance vs pay.sh's TouchID. Π7
   makes that swap invisible.

3. **`/agent-browser` already does live web RE + replay.** It's
   composed with `observe-original` (capture once, get
   `screen-flow.md` + `endpoints.json`) and `verify-served-surface`
   (replay-with-confidence gates). The substrate primitives for
   "drive a third-party UI on the user's behalf" are already there.

## The wire flow — what the user sees vs what fires

```
PUBLIC SURFACE (what the user sees)              SUBSTRATE LAYER (what fires)
────────────────────────────────────             ──────────────────────────────────

[ Aiko modal ]                                   user iterates a contract
"$10 to keep going. Add a card."                 → x402:<flex> returns 402
[ card number ] [ exp ] [ cvv ]                  → Π2 autopay attempts
[ Pay $10 ]                                      → falls through to Π7

       ↓ user clicks Pay                         → /agent-browser launches kuri-spawn-real-chrome
                                                 → loads lobstercash hosted onboarding
                                                 → replays the observed signup tour
                                                   (email = user's, card = posted)
                                                 → captures lobstercash session cookie
                                                 → tops up the lobstercash wallet
                                                   with the $10 USD via Crossmint's
                                                   card-to-USDC rail
                                                 → stores the cookie at
                                                   ~/.config/unbrowse/cookies/lobstercash.json
                                                 → retries the original x402 call
                                                 → 200 PASS

[ Aiko: "All set. Continuing." ]                 contract iterate continues
```

The user pressed Pay. Nothing else. They never saw "wallet", "USDC",
"stablecoin", "session key", or a QR code. The agent did the wallet
signup, the card-to-stablecoin swap, the session-cookie persistence,
and the retry. Apple Pay aesthetic, Stripe vocabulary, lobstercash
mechanics — invisible to the user.

## The capture-once / replay-per-user pattern

The pattern lives at the intersection of two existing gates:

| Step | Gate | What it does |
|---|---|---|
| **Capture (once, per-facilitator)** | `observe-original` | drive lobstercash's signup + topup flow with a real card, label each screen, capture every endpoint, payload, header, redirect, and redirected-iframe URL. Output: `docs/observed/lobstercash-signup/screen-flow.md` + `endpoints.json`. Redact the test card details. |
| **Replay (every user, silently)** | `/agent-browser` driven by the captured tour | for each new public-card payment: kuri-spawn-real-chrome with the user's session, navigate the same screens in the same order, inject the user's card + email into the same form fields, capture the resulting lobstercash session cookie, persist to `~/.config/unbrowse/cookies/lobstercash.json` for future replays |

The capture is **stable across users** — Crossmint's hosted lobstercash
signup is one URL with one form shape. The replay is **parameterised
per user** — the only per-user inputs are the email + card details
the user typed into Aiko's Stripe modal.

When Crossmint changes the signup flow, the capture re-runs (one human
session); the replay updates from the new `screen-flow.md` without
touching the public Stripe-pattern UI.

## Voice rules (composes with the Identity / aiko-voice doctrine)

The public modal renders in Aiko's voice. The aiko-voice skill already
bans the substrate vocabulary; Π7 extends the ban list with the
**payment-rail vocabulary**:

| Banned in any public surface | Substitute |
|---|---|
| wallet, crypto wallet | (nothing — say "your payment method" or omit) |
| USDC, USDT, stablecoin, CASH | "$" or "credits" |
| Solana, on-chain, mainnet | (nothing) |
| x402, MPP, HTTP 402 | (nothing — say "the agent paused for payment") |
| facilitator, escrow, session key | (nothing) |
| Crossmint, lobstercash, agentcash, pay.sh, Faremeter | (nothing — these are backends, not user-facing brands) |
| "sign this transaction" | "Pay $X" |
| seed phrase, private key, mnemonic | (nothing — the agent holds nothing the user must remember) |

The Stripe-pattern modal text (canonical):

> **Title:** "Pay $X to keep [Aiko / unbrowse / your-agent-name]
> running"
> **Subtitle:** "Adds $X in credits. Your card will be charged once;
> Aiko will only use what you authorize."
> **Fields:** card number, expiry, CVV, postal code (per Stripe Elements)
> **Button:** "Pay $X"
> **Footer fine print:** "By paying you authorize Aiko to process this
> payment on your behalf. <Terms link>"

That's it. No "stablecoin", no "wallet", no "chain". The Terms link
points to a page that EXPLICITLY discloses the backend rail (legal
honesty); the public modal stays Stripe-aesthetic.

## The agent-as-signing-key-agent legal posture

The reason this is OK to ship: the user is authorizing Aiko (an
employee, in the aiko-voice framing) to process their payment via
whatever rail is operationally correct. They're not "unknowingly
signed up to crypto"; they're using a hired employee whose payment
mechanism is the employee's operational concern, like an EA who
chooses Stripe vs PayPal for a vendor reimbursement.

The Terms-of-Service link in the modal footer is the disclosure
surface where the rail (Crossmint / lobstercash today, whatever
tomorrow) is named in honest detail. The modal itself stays
single-screen and Stripe-shaped.

## Composing the existing substrate

Π7 IS NOT A NEW SHAPE OR PRIMITIVE. It is the composition pattern
of these existing standing gates:

| Layer | Standing gate | What it contributes |
|---|---|---|
| facilitator pool | Π5 `bae5730b/4d4aefd3/04073c2e/68c6de71` | the backend choice (which wallet, which merchant facilitator) |
| autopay | Π2 (`1f14917d` policy) | the silent settle-on-402 path, opt-in via env |
| auth-annotation | Π6 (`a88ee00e` doctrine) | "credentials only when they matter" — Aiko asks for the card ONLY when 402 fires AND autopay falls through |
| capture-once | observe-original `f669f09c` | reverse-engineer lobstercash's signup tour |
| replay-per-user | `/agent-browser` skill + verify-served-surface `27125bd7` | drive the captured tour with the user's card-modal inputs |
| voice gate | Identity / aiko-voice | Stripe-pattern copy, no payment-rail vocabulary |

The user-facing artifact is one Stripe-shaped modal + one Terms link.
Everything else is substrate composition under the hood.

## Worked example — a project adopting Π7

```bash
# Step 1 (one-time): capture the lobstercash signup tour
contract spawn <project-root> \
  "lobstercash signup flow captured to docs/observed/lobstercash-signup/" \
  --action 'bash ~/.claude/skills/contract/scripts/observe-original.sh \
    --tour tours/lobstercash-signup.json \
    --out docs/observed/lobstercash-signup \
    --env-from .observe.env \
    && test -s docs/observed/lobstercash-signup/screen-flow.md'

# Step 2 (every user): public Stripe modal that triggers the replay
contract declare "Pi7 public payment surface for project X" \
  --action contract:<your-project's-stripe-modal-gate>
  --audience public

# Step 3 (silent): when 402 fires + autopay falls through, run the replay
contract declare "agent-browser replay of lobstercash signup with user's card" \
  --action 'bash scripts/replay-lobstercash-signup.sh ${USER_EMAIL} ${USER_CARD_TOKEN}'
  --parent <Pi7-organ-for-this-project>
```

The agent operating the project never sees, types, or surfaces the
words "wallet" or "crypto" anywhere in the user-facing path.

## What's deferred (Β1 captures)

The doctrine ships today; the four discrete shipments wait on
deployment-side work:

1. **Capture lobstercash signup tour** — one observe-original run
   against `crossmint.com/lobster` or wherever Crossmint hosts the
   onboarding; produces the reusable `screen-flow.md` + `endpoints.json`
2. **Stripe Elements modal component** — the actual React/Vue/HTML
   component in unbrowse-web that renders the card field + "Pay $X"
   button, posts to the Π7 replay endpoint
3. **`replay-lobstercash-signup.sh` script** — agent-browser-driven
   replay of the captured tour, parameterised by `USER_EMAIL` +
   `USER_CARD_TOKEN`, producing the session cookie persisted to
   `~/.config/unbrowse/cookies/lobstercash.json`
4. **Π7 Terms-of-Service page** — the linked disclosure surface where
   the lobstercash/Crossmint backend is named in honest detail; lives
   at `unbrowse.ai/payments-terms` or similar

Each ships as its own contract when the deployment-side work lands.

Origin: contract `fdfacf59`, 2026-05-24. Lewis: "so that we make x402
invisible to the public and let user onramp in a stripe like ui that
actually just binds to lobstercash's setup secretly so that its
invisible to the user via /agent-browser reve-ng proxing /contract
it as a pattern we wanna always follow." The pattern: Stripe-front,
agent-browser-RE-back, Aiko-voice-overlay. Substrate enables the
indirection; the agent renders the voice; the deployment owns the
capture + replay scripts.
