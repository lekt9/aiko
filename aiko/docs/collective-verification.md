# Aiko Collective verification record

Verified on 2026-07-21 from the source tree described by `plan-arch.md`.

## Contract trust kernel

- `cd ../contract/libcontract && zig build test` passes the native Contract and
  collective kernel suites.
- `zig build collective-conformance -- ../fixtures/collective/golden-vectors.json`
  verifies both cross-language golden vectors.
- The full native library exports the legacy harness ABI and the additive
  collective ABI, including targeted Merkle inclusion proof creation and
  verification.
- `collective_rank.zig` verifies that fresh failures affect only evidence for
  the exact matching capability version.

## Aiko host and network

`cargo test --release -p xai-aiko-collective -- --test-threads=1` passes:

- 36 unit tests for bounded wire messages, offline defaults, persistent
  identities/stores, quarantine, quotas, GC, search, ranking, replication,
  transparency, and execution gating;
- 7 Contract boundary tests for canonical vectors, privacy fail-closed
  behavior, deterministic pack round trips, indexes, signing, ranking,
  checkpoints, merging, and inclusion proofs;
- 4 adversarial simulations for poisoning, eclipse, Sybil, and spam behavior;
- a real three-node QUIC LAN test that publishes, retains, discovers, ranks,
  and locally executes with no account, seed, relay, cloud, or original
  publisher online.

The integration suite also reopens a persisted peer store and serves its object
to a fresh node after the original publisher and first transport sessions stop.
Kademlia provider discovery is tested after the original seed departs.

## UI and TUI

- `pnpm --dir apps/aiko-app build:ui` passes the TypeScript/Vite build.
- `pnpm --dir apps/aiko-app test` and the Rust ACP golden tests pass the native
  message-stream contract.
- `cargo check --release -p xai-grok-shell -p xai-grok-pager -p
  xai-grok-pager-bin` passes. Existing non-snake-case captcha wire-field
  warnings remain warnings only.
- Desktop and TUI surfaces expose collective status, participation controls,
  publication review/audit, revocation, local erasure, peer/index state, and
  typed native events.

## Distribution artifacts

macOS arm64:

- `dist/macos-arm64/Aiko-0.1.0-macos-arm64.dmg`
- `dist/macos-arm64/Aiko-0.1.0-macos-arm64-app.zip`
- `dist/macos-arm64/SHA256SUMS.txt`

The DMG passes `hdiutil verify`. Its mounted `Aiko.app` passes strict deep
ad-hoc code-signature verification and contains an arm64 runtime plus only the
full `libcontract.dylib`. It is not Developer ID notarized.

Windows x86-64:

- `dist/windows-x86_64/Aiko-0.1.0-windows-x86_64-installer.zip`
- `dist/windows-x86_64/Aiko-0.1.0-windows-x86_64-portable.zip`
- `dist/windows-x86_64/SHA256SUMS.txt`

Both archives pass ZIP integrity and SHA-256 verification. The CLI, desktop
app, and full Contract runtime are PE32+ x86-64 binaries. The DLL exports both
legacy harness and collective symbols. They were cross-compiled and inspected
on macOS; no Windows VM or Wine runtime was available for execution testing.

## Cloud independence

Collective participation is disabled by default. Local operation, publication
gating, object storage, indexing, ranking, QUIC replication, mDNS, Kademlia,
peer exchange, optional relay roles, witness gossip, repository/DNS/community
seeds, and execution approval all have local or peer-operated paths. No hosted
database, account provider, object store, index, relay, seed, or ranking service
is required for the verified LAN flow.
