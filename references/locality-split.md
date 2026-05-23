# Locality split (dev-local vs user-remote)

> **The clarification.** `/contract` substrate — the ledger, the
> `~/.claude/skills/contract/` install, the chain-walk runtime, the
> facilitator gates, the hooks — lives **locally on Lewis's Mac and
> nowhere else**. It is the dev environment for building the substrate
> itself. For unbrowse users on their devices, the substrate runs
> **entirely server-side** at unbrowse; the only thing on their
> machine is the thin `unbrowse` CLI binary, which acts as a transport
> adapter to the remote DAG. **Users never install `/contract`, never
> see a ledger file, never run `contract iterate`.**

## Why this is load-bearing

Three prior doctrines need this audience-split or they read wrong to a
user:

1. **Π3 `machine:` pointer-type** (origin `e7c8f6f2`) — "the contract
   row stays portable across hosts (mac, tencent, any client install)
   — each machine maintains its own resolution map." That language is
   **dev-context**: my Mac + my tencent VM + any of my client hosts.
   It is NOT a user-context primitive. Users don't have a
   `~/.config/contract/machine-binaries.json` because they don't have
   `/contract` installed at all.

2. **Π4 marketplace mirror** (origin `397bc7bd`) — "every contract
   declared anywhere → pushed to unbrowse, which becomes the canonical
   DAG." Read in the locality-split frame: for users the canonical DAG
   IS the only DAG; there is no local fallback to mirror. The local
   ledger lives only on Lewis's Mac (this dev machine) and on whatever
   other dev hosts I personally install the skill on.

3. **Φ1 OpenAI-compatible front + the security-public-scope** (origin
   `a4910638`) — "the substrate-side half (`~/.claude/skills/contract/`)
   is already public-by-definition — a local install, the user reads
   every line." Refined: the user-facing local install is **the
   `unbrowse` CLI binary**, not the `/contract` skill. The published
   security-scope code is what `unbrowse` does on their device (the
   transport, the requirement-block parser, the tool_call → UI mapper),
   not the substrate's iterate-loop / ledger writer / hook bus.

## The honest deployment topology

```
LEWIS'S DEV MACHINE (mac)                    USER'S DEVICE (any)
─────────────────────────                    ─────────────────────────
~/.claude/skills/contract/   ← dev only      ~/Applications/unbrowse
  scripts/contract           (build the      (the only local binary —
  scripts/lib/contract_core   substrate       a thin transport client)
  ledgers/contracts.jsonl     itself here)
~/.contracts/                                no ~/.contracts/ exists
  contracts.jsonl
  inbox/{telegram,…}                         no inbox files
  streams/<id>/stdout.log                    no streams dir
  hooks/{drive-advance,…}                    no hooks
  .git/                                      —

         │                                        │
         │ I push doctrine + verb changes         │ unbrowse CLI hits
         │ to ~/.claude/skills/contract/          │ HTTPS server-side
         │ then promote to docs.getfoundry.app    │
         ▼                                        ▼
              ┌──────────────────────────────────────┐
              │  UNBROWSE.AI SERVER-SIDE             │
              │                                      │
              │  /v1/chat/completions (Φ1 route)     │
              │  /v1/credits/* (Π1 x402)             │
              │  /v1/billing/autopay/charge (Π2)     │
              │  /v1/contracts/mirror (Π4)           │
              │  /v1/contracts/iterate (Ω3 — server- │
              │     side contract iterate runner)    │
              │                                      │
              │  THE canonical DAG lives here.       │
              │  Every user-facing call routes here. │
              │  Settlement, facilitator pool,       │
              │  binding DAG, browser spoofing,      │
              │  Π7 invisible-x402 indirection —     │
              │  all server-side.                    │
              └──────────────────────────────────────┘
```

## The hard rules (substrate-bound)

1. **`unbrowse` binary on a user device NEVER imports / installs
   `~/.claude/skills/contract/`.** The skill directory is a dev-tool.
   If we ever ship a "/contract local install" target, it is gated
   behind a `UNBROWSE_DEV=1` env flag and explicitly named in the
   installer prompt as "for unbrowse contributors only."

2. **Public-facing docs NEVER tell a user to run `contract …`** —
   not `iterate`, not `list`, not `search`. The user-facing CLI is
   `unbrowse`. The `contract` verb is internal vocabulary that
   surfaces only in dev / debug contexts.

3. **The substrate-side server endpoint at unbrowse hosts the
   canonical ledger.** When a user-facing flow needs to iterate a
   contract (e.g. the Π7 invisible-x402 modal needs to settle a 402),
   the unbrowse binary POSTs to `/v1/contracts/iterate`. The server
   runs the iterate, writes the row, returns the result + any
   requirement block.

4. **Lewis's local ledger is for dev work + Σ2 `team`/`private`
   rows.** When a row needs to be visible to the user-facing server,
   it gets `--audience public` AND is mirrored via Π4 to the server-side
   ledger. The user-facing ledger sees only public rows.

5. **`contract promote <id>` (cross-ledger copy) is still valid** for
   moving rows between my dev project ledgers and my dev global
   ledger. It is NOT how user-facing rows reach the server — that's
   Π4's mirror endpoint.

## What this means for prior doctrines (audience refresh, no fossilization)

| Prior doctrine | Read it as |
|---|---|
| Π3 `machine:` pointer-type | dev-context primitive for Lewis's multi-host work (mac/tencent/etc); user devices never use it |
| Π4 marketplace mirror | the SERVER-CANONICAL ledger for users; the local mirror is a dev convenience |
| Φ1 substrate-public-scope | refers to the `unbrowse` CLI's source (the transport), NOT to `~/.claude/skills/contract/` |
| Λ1 KEY 2 routing (codex / HTTP) | dev surface; the user-facing flow has KEY 2 happen server-side per the OpenAI-render layer |
| Σ4 agent-routing / Σ6 sessions | server-side routing for user-facing identities; dev-side routing for Lewis's multi-client work |
| every "/contract install on each host" framing | dev hosts only; user hosts get the `unbrowse` binary, full stop |

None of those doctrines are wrong; they're all dev-context-true. This
doc clarifies that **the user-facing topology is strictly thin-client
+ remote substrate**.

## Β1 follow-ons captured

The doctrine ships today; the four discrete shipments wait on
deployment-side work:

1. **`/v1/contracts/iterate` server endpoint at unbrowse** — runs the
   iterate, writes the row to the canonical server ledger, returns
   any requirement blocks (Ω3 follow-on to Φ1).
2. **`unbrowse` CLI's "install instructions" page audit** — sweep
   every public doc / README / website page that mentions "install
   /contract" or "the ledger lives at ~/.contracts/" and remove from
   user-facing docs (keep in dev-contributor docs only).
3. **Π7 invisible-x402 modal endpoint refactor** — confirm the modal's
   "Pay $X" POST hits a server-side endpoint that runs the agent-browser
   lobstercash replay; the user device's `unbrowse` binary only collects
   the card token + email and forwards.
4. **`UNBROWSE_DEV=1` gate on /contract local install** — if/when we
   ship a "contributor install" path, gate it behind this env flag and
   surface it only in the contributor README; user-facing install
   scripts must not even mention the gate exists.

## Self-check

The next `self/no-contradictions` run should look for: any
user-facing surface that mentions `~/.contracts/`, `contract iterate`,
`~/.claude/skills/contract/`, or instructs a user to install the
`/contract` skill. Any hit is a doctrine violation per this locality
split.

Origin: contract `ed4a2700`, 2026-05-24. Lewis's framing: "should
never live locally for the users on unbrowse cli /contract being
local is only for me, lewis on this computer to dev /contract
itself." This doc binds the audience split so future
agents reading the substrate don't mistakenly tell a user to "install
/contract."
