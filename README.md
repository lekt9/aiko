# Aiko

**Aiko** is a Contract-native agent for your laptop. It understands a
codebase, edits files, runs commands, searches the web, and manages long-running
work from a terminal TUI, headless scripts, or editors using ACP.

```sh
aiko
aiko "fix the failing test"
aiko --single "review this repository"
```

Contract is built into the turn lifecycle. Users ask Aiko for an outcome; Aiko
automatically declares that goal in the local Contract ledger before work
starts and appends a satisfied verdict only when the agent reaches a genuine
end-of-turn result. There is no `/contract` command and users do not need to
invoke the `contract` binary themselves.

The split is intentional:

- **Aiko** is the public agent, environment, and binary.
- **Contract** is the local signed ledger row and resolver substrate.
- A prompt becomes one contract declaration.
- Successful completion becomes the contract verdict.
- Cancelled and failed turns remain unresolved instead of being reported as
  successful.

The bridge loads Contract's canonical dylib once and uses its native ABI and
row schema, so the same
ledger remains readable by Contract tooling. If the substrate is temporarily
unavailable, Aiko continues the user’s work and records a debug event; ledger
bookkeeping never blocks the agent.

## What Contract contributes

The bundled Contract runtime is more than a completion flag. It supplies one
signed ledger and resolver with six typed agency roles: purpose, sensor,
action, evaluator, governor, and development. Governed workflows can bind:

- effect reach and explicit approval for network/deployment/message/payment,
  on-chain, or human-impacting actions;
- consequence sensors terminating in hashed external reality anchors;
- independent evaluators, counter-metrics, vetoes, freshness, and revocation;
- slow-loop target ownership and frozen boundaries;
- same-tick bad-news propagation and compatible rollback;
- atomic, reversible topology-development proposals.

Aiko’s ordinary turn bridge remains non-blocking: it declares the user’s goal
and records a terminal result through ABI v2. Advanced typed envelopes and
trust policy are additive, so existing ledgers and turns remain compatible.
Contract’s causal event stream is local and redacted; the standalone Contract
CLI can inspect it with `events`, `watch`, and `explain` without requesting
wallet or Keychain access.

## Building

Requirements:

- Rust (the repository pins its toolchain in `rust-toolchain.toml`)
- DotSlash for the hermetic tools under `bin/`
- Contract's `libcontract.dylib` installed at `~/.aiko/lib/` (or selected with
  `AIKO_CONTRACT_LIBRARY`)

```sh
cargo run -p xai-grok-pager-bin
scripts/contract-runtime.sh build-aiko
cargo check -p xai-grok-pager-bin
```

The release artifact is `target/release/aiko`. Internal crate names retain
their existing `xai-grok-*` names for source and workspace compatibility.

## Contract runtime packaging

Aiko and Contract remain separate source repositories. Contract is built as a
native runtime library and shipped in the same package as Aiko:

```text
aiko-<version>-<platform>/
├── bin/aiko
├── lib/libcontract.dylib
├── manifest.json
└── install.sh
```

Build and install the combined, checksummed package:

```sh
scripts/contract-runtime.sh build-aiko   # default: build and repackage
scripts/contract-runtime.sh install
```

Packages are written under `target/aiko-package/`. The installer atomically
installs Aiko to `${AIKO_BIN_DIR:-~/bin}/aiko` and Contract to
`${AIKO_HOME:-~/.aiko}/lib/libcontract.dylib`.

`build-aiko` and invoking `contract-runtime.sh` with no command both refresh
the combined Aiko + Contract package by default, so a successful application
build cannot leave a stale Contract runtime in the distributable. Use
`build-aiko-only` only for an intentionally unpackaged inner-loop build.
The package manifest pins both the Aiko and Contract SHA-256 hashes plus their
source revisions. Packaging fails if either expected artifact is absent, and
the installer verifies both hashes before atomically replacing the live files.

The complete integration behavior is documented in
[`docs/contract-agency-runtime.md`](docs/contract-agency-runtime.md).

For linked development, keep Contract as the source of truth:

```sh
scripts/contract-runtime.sh dev-link
scripts/contract-runtime.sh watch
```

`dev-link` makes the installed Contract library a symlink to the sibling
Contract repository's `zig-out` artifact. `watch` rebuilds that artifact when
Contract sources change; newly started Aiko processes load the new build
without copying it into this repository or rebuilding Aiko.

## Native frontend API

The installed background worker also exposes an authenticated, loopback-only
API for Swift, Electron, and local web frontends. It keeps ACP as the
full-duplex agent-mail protocol and Contract ABI v3 as the ledger/task
authority.

```sh
aiko native discovery
aiko native manifest
```

The mode-`0600` discovery document at `~/.aiko/native/api.json` contains the
active URL and bearer token. See
[`docs/aiko-native-api.md`](docs/aiko-native-api.md), the
[OpenAPI 3.1 document](docs/aiko-native-api.openapi.json), and the
[TypeScript client](sdk/aiko-native/README.md).

## Repository layout

| Path | Contents |
|------|----------|
| `crates/codegen/xai-grok-pager-bin` | Composition root for the `aiko` binary |
| `crates/codegen/xai-grok-pager` | TUI, prompts, modals, and rendering |
| `crates/codegen/xai-grok-shell` | Agent runtime and the Contract-native turn bridge |
| `crates/codegen/xai-grok-tools` | Terminal, file, search, and other tools |
| `crates/common/xai-application-runtime` | Aiko-owned CDP and Electron primitives |
| `crates/codegen/xai-grok-workspace` | Filesystem, VCS, execution, and checkpoints |
| `sdk/aiko-native` | Typed frontend client for discovery, Contract, and agent mail |
| `third_party/` | Vendored upstream source |

The root `Cargo.toml` is generated. Prefer editing individual crate manifests.

## Development

```sh
cargo test -p xai-grok-shell contract_native
cargo test -p xai-grok-pager app::cli
cargo fmt --all
```

First-party code is licensed under Apache License 2.0. See `LICENSE` and
`THIRD-PARTY-NOTICES`.
