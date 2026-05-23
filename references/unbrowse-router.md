# /contract IS the unbrowse router

> **The pitch in one line.** Unbrowse is the one install that makes 90 %
> of the web callable by your agent without a browser, per-service MCPs,
> or CLIs. `/contract` is the **routing substrate underneath** — the DAG
> that decides which marketplace skill, which facilitator, which wallet,
> which auth surface, which machine binary fires for each agent call.
> Same install on every device, same ledger on every project, one
> facilitator pool, one 50/50 split policy.

## The two-line stack

```
                ┌─────────────────────────────────────────────┐
                │  unbrowse   — the surface the agent calls   │
                │  90% from cached API graph, 10% via stealth │
                │  browser; both routed through /contract     │
                └────────────────────┬────────────────────────┘
                                     │
                ┌────────────────────▼────────────────────────┐
                │  /contract  — the routing substrate         │
                │  (DAG of cells/organs, four facilitators,   │
                │   binding DAG, auth-annotated graph)        │
                └─────────────────────────────────────────────┘
```

Unbrowse is the **product surface**: install once, every web call goes
through it; the marketplace's cached API graph hits 90 % of requests
under 200 ms (per the canonical Mar 28 2026 cut — 5.4× median speedup,
90-96 % cost reduction, 94 domains). `/contract` is the **router
underneath**: each call is a cell, the cell may pointer-gate one of
four facilitators (pay.sh, lobstercash, agentcash, Faremeter Flex per
Π5), may need a binding-recompute (CSRF / JWT / fingerprint per the
binding DAG), may need auth (Π6 auth-annotation, filtered out when
the user has no relevant cookies), may live as a local CLI invocation
(Π3 `machine:` pointer) or a server-side route (Π4 marketplace mirror,
named-and-deferred).

## What the router decides per call

Every agent call enters the router. The router answers four questions
before firing:

1. **Which facilitator?** Π5 binds the four standing-gate contracts
   (`04073c2e` pay.sh, `4d4aefd3` lobstercash, `bae5730b` agentcash,
   `68c6de71` Faremeter Flex merchant). The user's installed wallet
   binary signs the X-PAYMENT; our Flex merchant facilitator settles
   with the 5000/5000 bps split (`0f957e72`) at on-chain finalize.

2. **Does this need auth?** Π6 (this turn) annotates every endpoint /
   skill row with `auth_required: bool` + the cookie domain(s) it
   needs. At retrieval time, `contract search` and `contract list`
   filter out auth-gated rows when the user has no matching cookies.
   No preemptive "please sign in" prompts; only when the user
   explicitly reaches for an auth-gated skill does a SIGN-IN REQUIRED
   block fire.

3. **Does this need a dynamic param?** The binding DAG (CSRF,
   JWT-refresh, JSESSIONID, ct0, sensor-data tokens, hCaptcha widget,
   device fingerprint, signed nonce) is one shape: `OperationBinding`
   walked by `ChainWalkContext` per
   `docs/BROWSER-SPOOFING-DAG.md`. Stale binding → producer endpoint
   re-fetched → fresh value threaded in. Same recompute mechanism
   for every browser-spoofing dimension.

4. **Which spoof profile?** Per `docs/BROWSER-SPOOF-1-TO-1.md`, the
   local CLI binary reads the user's actual installed Chrome
   (`chrome --version`), derives client hints from local OS + arch,
   surfaces `spoof_confidence` per request; auto-falls-back to the
   kuri-spawned real Chrome on bot-shaped failures.

Four questions, four substrate primitives, one routing layer. Every
agent call passes through them; no question requires the agent to
re-derive the answer per project.

## Why this is the right boundary

The instinct is to bake routing into unbrowse itself. Wrong, for three
reasons:

1. **Multi-project leverage.** Unbrowse is one product surface. The
   DAG of cells / organs / facilitators / bindings is reused across
   every project Lewis ships (aiko, foundry, unreel, the panel, the
   bot, the web, any client install). Putting the router in /contract
   means every project inherits it without re-implementing.

2. **Substrate enables, never prescribes.** Unbrowse decides what
   skills exist + what their data contracts are. /contract decides
   how they compose + when they fire + who pays + which credential
   surfaces apply. The split honors the CLAUDE.md meta-rule —
   substrate (us) provides the shapes; the marketplace (unbrowse)
   provides the content.

3. **Local + remote at the right abstraction.** The ledger lives
   locally (`~/.contracts/contracts.jsonl`) AND remotely (Π4
   marketplace mirror, deferred). Per Lewis: "we maintain it both
   locally and remotely at the right abstraction." Local-first means
   the router never blocks on network; remote-mirror means the cross-
   device experience (Σ6 sessions) stays in sync.

## Π6 — auth annotation + lazy-credential filter

The "credentials only when they matter" doctrine, made mechanical.

### The field

Every `declared` row carries an optional `auth_required` shape:

```json
{
  "event": "declared",
  "id": "abc1234",
  "plan": "fetch the user's Reddit saved posts",
  "action": "x402:https://marketplace/...",
  "auth_required": {
    "domains": ["reddit.com"],
    "cookie_names": ["reddit_session"],
    "sign_in_url": "https://www.reddit.com/login",
    "fallback": "anonymous_subreddit_json_only"
  }
}
```

`auth_required: null` (or absent) means anonymous-capable. Anything else
declares which cookies, which domains, which sign-in surface, and the
honest anonymous fallback the agent can use when the user hasn't signed
in.

### The filter (retrieval-time, not declare-time)

`contract list --has-creds` and `contract search --has-creds`
filter the ledger to rows where:
- `auth_required` is null, OR
- the user's local cookie jar (`~/.config/unbrowse/cookies/<host>.json`
  per the auth-bench path A doctrine) contains the named cookies for
  every domain in `auth_required.domains`

Default behavior: surface ALL rows, but render anonymous-capable ones
first and group auth-gated ones under "needs sign-in for:". The user
sees what's possible without auth + what would unlock with sign-in,
in one screen.

### The "credentials only when they matter" mechanic

When an agent tries to iterate an auth-gated cell AND the user has no
matching cookies, the substrate doesn't fire the action. Instead it
emits `=== SIGN-IN REQUIRED ===` (existing block from Π1) with:

```
=== SIGN-IN REQUIRED ===
  kind:      sign-in
  upstream:  reddit.com
  for_skill: <skill plan text>
  fallback:  anonymous_subreddit_json_only
  sign_in_url: https://www.reddit.com/login
  render_hints:
    - telegram: inline keyboard → magic-link
    - web:       OAuth modal
    - panel:     Privy sign-in card
    - terminal:  open URL
```

The agent (or the user, via the rendered surface) chooses: sign in to
unlock the auth path, OR take the named fallback. Either way, the
credential ask happens **only at the moment the user needs the
auth-gated capability** — never preemptively, never as a setup-time
"please connect all your accounts."

### What this changes about the bench

The auth-bench coverage strategy (`docs/AUTH-BENCH-STRATEGY.md`)
already names the four safe paths (user cookies, public APIs, vendor
demos, explicit not-covered residual). Π6 makes the filter mechanical:
a project's bench dashboard can show "37 of 168 auth-gated lanes
covered (you're signed in to: reddit, github; sign in to linkedin to
unlock +8 lanes)" — pulled from the ledger filter rather than
hand-maintained.

## What gets published to docs.getfoundry.app

This same doc, pushed via the outline-api skill, lives at:
`https://docs.getfoundry.app/doc/<slug>` under the existing
**unbrowse** collection. The publish is the "/contract it into docs
and existence" step Lewis named. Updates happen via
`documents.update --append` per `outline-api` SKILL.md.

## What gets revealed in /unbrowse-ai positioning

The unbrowse-ai skill's user-facing pitch already says: "Unbrowse is
the one install that makes 90 % of the web callable…" The router
slot underneath it is now `/contract`. For investor / customer /
agent-builder framings, the line is:

> Unbrowse is the install. /contract is the router beneath it: one DAG,
> four facilitators, one binding recompute layer, one auth annotation,
> one 50/50 cut on every paid call. The same install on every device
> hits the same router on every project.

The `unbrowse-ai` skill's `customer` and `agent-host-integrator`
audience tiers should reference this doc when the question is "what's
actually under the hood?"

## Standing-gate ids referenced (all real, all in the global ledger)

| Layer | Doctrine | Standing gate |
|---|---|---|
| facilitator pool | Π5 | pay `04073c2e` · lobstercash `4d4aefd3` · agentcash `bae5730b` · Flex `68c6de71` |
| rev-split policy | Π5 | `0f957e72` (50/50 bps) |
| served-surface | universal | `27125bd7` |
| empathy | universal | `4a055cf7` |
| observe-original | universal | `f669f09c` |
| receptor substrate | universal | `838d1447` |

Any project can pointer-gate any of these via `--action contract:<id>`.

## Β1 follow-ons captured

The substrate-side router doctrine ships today; four discrete
shipments wait on per-component wiring:

1. **`auth_required` field plumbing** in `contract_core.declare()` so
   declare-time annotation persists to the row.
2. **`--has-creds` filter** on `contract list` + `contract search` that
   reads the cookie jar at `~/.config/unbrowse/cookies/`.
3. **`SIGN-IN REQUIRED` block extension** to carry `for_skill`,
   `fallback`, and `auth_required.domains` per Π6 schema.
4. **Outline publish** — push this doc to docs.getfoundry.app under
   the unbrowse collection on next /contract turn (operational this
   turn, captured here for posterity).

Origin: contract `a88ee00e`, 2026-05-24. Lewis's compound ask:
"write docs about this being the unbrowse router /contract it into
docs and existence and /contract to reveal the relevant parts in
/unbrowse-ai /contract now that its ready and always do so when it
makes sense and update via /contract always by /overleaf [read:
Outline — docs.getfoundry.app, already wired via outline-api] and
/contract it so that we know which things require auth and filter out
those upon failure or missing cookies because we maintain it both
locally and remotely at the right abstraction via /contract so we can
leverage credentials only when they matter /contractually."
