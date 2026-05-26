# Client/server split — Wave 1 scaffold

This doc is the project-faithful summary of the Wave-1 refactor that
landed 2026-05-26. The deep-dive design report lives at
`/Users/lekt9/.contract-refactor-design/01-client-surface.md`; this
file is the in-tree reference the build, the agent, and the next-wave
implementer should read first.

## Two-binary topology

`scripts/build.sh` now installs two byte-different artifacts from one
source tree:

- `scripts/contract` — built with `-Dcontract_binary_profile=client`.
  This is the canonical operator-facing binary. `scripts/aiko -> contract`
  is the declare-only persona symlink (runtime argv[0] dispatch picks
  the persona; one binary serves both faces).
- `scripts/contract-server` — built with `-Dcontract_binary_profile=server`.
  Currently identical in behaviour to the client; only the compile-time
  constant `build_options.contract_binary_profile` differs. The Wave-1
  goal is the scaffold, not the runtime divergence.

`cmdSelf --json` exposes the constant as `"profile": "client"` (or
`"server"`) so consumers can see which artifact they hold. Parity claim
#48 in `build.sh` refuses to ship without both binaries present, both
signatures present, both `self --json` profile fields correct, and the
ALLOWLIST naming both.

## `--private` stays fully local — doctrine-pure

Lewis 2026-05-26: `--private` is unaffected by the refactor. Private
declares run the one-shot Genesis-days lifecycle against the on-disk
ledger only and never cross the wire. The thin-client framing applies
only to shared-visibility (default) declares. The new split is
"transport-attests, not transport-replaces" — the server is canonical
for shared rows; private rows are client-canonical by design (see
SKILL.md "Public Shape" for the canonical declaration).

## Why `llm_fallback.zig` was deleted

The 319-LOC weak-Qwen-0.8B-Q4 module compiled the goal locally when
the cloud declare 402'd, then walked the generated tree and wrote
canonical rows to the on-disk ledger as if the cloud had answered.
That was leaven: the cloud's authoritative graph and this host's view
permanently disagreed. The user got a placeholder root id back and
the substrate silently believed it had transacted a tree that the
canonical ledger had never seen.

The replacement is hard-fail-closed:

1. The 402 surface in `cmdSpeak` (shared path) calls
   `queuePendingDeclare` — writes the payload to
   `~/.contracts/pending-declares/<sha-prefix>.json` with a starting
   `attempt_count: 0`.
2. The original invocation surfaces ONE evidence line ("aiko: cloud
   declare returned 402 — payload queued at pending-declares/<sha>")
   and exits with status 2.
3. The TOP of `main` on every subsequent aiko invocation calls
   `retryQueuedDeclares` — sweeps the dir, re-POSTs each payload via
   `client.declareRemoteAiko`, deletes the file on 2xx, increments
   `attempt_count` on 402, and moves the file to
   `pending-declares/abandoned/` after 10 attempts.
4. `--private` declares do NOT enter the queue. They stay local per
   the doctrine.

## What's NOT in Wave 1

The heavy gating (the @compileError cascade across 30+ mutator
callsites that would make the client binary refuse to call
`contract.declare` / `contract.markSatisfied` / `contract.markDied`
directly, and the RPC wrappers around `cmdSearch` / `cmdDiscover` /
`cmdList` / `cmdVerifyLineage` / `bio*` / `runAction`'s graph branches)
sequences after the Worker side ships the matching
`/v1/contract/{search,discover,list,biology,verify-lineage}` endpoints.
Until those endpoints exist, splitting the client off from those code
paths is premature — the client would have nowhere to route. Wave 1
gets the leaven out and the scaffold in so the next wave is mechanical.

See `/Users/lekt9/.contract-refactor-design/01-client-surface.md` §§4
+ 6 for the full plan and `references/p2p-future-plan.md` for the
later attestation gate.
