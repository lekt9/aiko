# NEVER PUBLISH THIS REPO

This is the **SERVER side** of `/contract` — the closed-source
substrate that compiles prose into typed contract neurons, holds the
canonical ledger, derives wallets, signs binaries, and runs the
moat-bearing primitives.

**Public surface:** `@aiko/contract` npm package, source at
`~/Projects/contract-thin-client/`. That repo (and only that repo) is
the public edge. This repo (`~/.agent-skills/contract/`) is closed.

## What this repo contains (all CLOSED)

- `libcontract/` — Zig core (wallet derivation, ledger, cache, signature chain)
- `zig/` — binary source (aiko, contract)
- `docs/` — design substrate (observations-fractal-loop.md, the recursive
  design conversation we're not giving away)
- `scripts/` — wallet operations (sign-binary, verify-self, build pipeline)
- `audit-gate/`, `bm25-gate/`, `budget-gate/`, ... — quality gates
- `references/` — internal references, Outline doc mirrors
- `audits/` — rule-enforcement scripts

## Mechanical guards

1. **No `package.json` in this tree.** `npm publish` errors hard before it
   even reads files. If a package.json ever lands here, the next guard fires.
2. **`.npmignore` excludes everything.** Belt-and-suspenders against
   accidental publish.
3. **Pre-push hook refuses `github.com` remotes.** `.git/hooks/pre-push`
   greps the remote URL; abort if `github.com` appears. Only the internal
   gitea remotes (Tailscale-only) are allowed.
4. **Thin client never imports from this tree.** `contract-thin-client`
   has a separate-folder invariant; any `import` referencing
   `~/.agent-skills/contract/` OR `../contract/` is a build error.

## What gets re-implemented (not lifted) in the thin client

The thin client is a **protocol speaker**, not a port of the substrate:
- Wire format (declare payload + response envelope) — stable surface, re-implemented in TS
- Wallet bootstrap — three-tier ladder adapted for Node (fs-only, no Keychain shellout)
- Binary-stdin convention — when the local aiko binary IS installed, the
  thin client pipes to it; when not, falls through to cloud HTTP
- Tunnel client — ripped from chisel/rathole/yamux/noise; the relay
  (`contract-tunnel-relay`) already exists separately

The compiler, ledger, signing keys, doctrine corpus, audit gates — all
stay on this side of the line.

## Doctrine pin

OPEN-SOURCE-NOTICE.md split: capture/RE engine + backend + CLI binary
+ anti-bot research = CLOSED; SDKs + thin client + OpenClaw plugin =
OPEN. This repo is the closed half by design.
