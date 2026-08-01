# Aiko

**Aiko** is a Contract-native agent for your laptop. It understands a
codebase, edits files, runs commands, searches the web, and manages long-running
work from a terminal TUI, headless scripts, or editors using ACP.

For a visual tour of the entire repository—runtime flows, ownership boundaries,
persistent state, crate inventory, builds, and where to make changes—start with
the [repository field guide](docs/REPOSITORY-GUIDE.md) or the
[documentation map](docs/README.md).

```sh
aiko
aiko "fix the failing test"
aiko --single "review this repository"
```

## Quick Start — 30 seconds to full stack

```bash
# 1. Build and install aiko (binary + Contract runtime + SDK)
scripts/contract-runtime.sh install

# 2. Pull neuron + limbs from the Gitea package registry
~/.aiko/sdk/registry/setup.sh

# 3. Verify
aiko --version     # Aiko agent TUI
neuron --help      # typed neuron runtime
ls ~/.aiko/limbs/  # 8 auto-admitted limbs (preemptor, dispatch-router, etc.)
```

Or use the one-liner (no npm needed):

```bash
curl -sL http://100.124.140.92:3000/Unbrowse/aiko/raw/branch/main/sdk/registry/setup.sh | bash
```

**What you get:** Aiko agent TUI with Contract-native turn lifecycle + a
typed neuron runtime (fire pure `Stimulus → Decision` neurons) + 8 generative
limbs that self-observe, preempt redundant work, route stimuli by energy, and
auto-generate new limbs for missing capabilities.

**One agent, one repo.** Aiko ships with Contract (libcontract.dylib),
the neuron runtime, and 8 generative limbs — all pulled from the Gitea
package registry on install. The sibling repos (`contract`, `neuron`) are
independent build artifacts with their own toolchains, not separate agents.
The old `aiko-agent` (Python/Hermes fork) is archived — its features live
on as neuron limbs.

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

## Canonical Neuron execution

Contract ABI 12 is the durable interpreter for Aiko's typed Skill nodes. Its
pure `Neuron` types, validation, and identities come from the sibling
`typed_neuron` Zig package; Aiko consumes mechanically generated Rust transport
types rather than maintaining a second wire contract.

Each production node returns a canonical decision. Contract commits that
decision, its authoritative evidence, node settlement, and pending effects in
one append-only transaction. A consequential product tool follows a strict
order:

```text
canonical decision committed → named adapter dispatched → exact effect acknowledged
```

Replay suppresses duplicate dispatch. An uncertain adapter outcome remains
held for reconciliation. Admitted scripts run as read-only decision producers
inside Aiko's enforced sandbox; they cannot perform effects directly.

The ordinary conversational turn declaration remains best-effort as described
above. A tool effect already under Neuron governance does not bypass the
pre-dispatch Contract membrane.

## SDK, Neuron & Generative Limbs

Aiko ships with an embedded SDK (`sdk/registry/`) that pulls the full stack
from your private Gitea package registry over Tailscale:

| Component | Binary | Registry | What it does |
|-----------|--------|----------|-------------|
| **aiko** | `~/bin/aiko` | built-in | Agent TUI with Contract-native turns |
| **contract** | `~/.aiko/lib/libcontract.dylib` | generic package | Contract ledger + typed neuron ABI |
| **neuron** | `~/.local/bin/neuron` | generic package | Fail-closed typed neuron runtime |
| **neuron-limbs** | `~/.aiko/limbs/` | generic package | 8 generative limbs |

**Generative limbs** are self-building neuron packages that extend what Aiko
can do without becoming a second primitive. Eight limbs ship with the SDK:

| Limb | Fires on | What it does |
|------|----------|-------------|
| `preemptor` | every stimulus | Skip equivalent firings from cache (confidence ≥ 0.92) |
| `dispatch-router` | every stimulus | Route to lowest-energy admitted limb over model |
| `introspection-trigger` | every 50 firings | Auto-fire introspection, detect capability gaps |
| `auto-attacher` | limb admission | Wire admitted limbs to matching receptors |
| `energy-router` | candidate scoring | Structural energy minimization for routing |
| `introspection` | trigger message | Self-observation, gap analysis, limb generation |
| `pipeline` | staged items | Process items with in-flight budget |
| `outbox-drainer` | queued messages | Retry, dead-letter, reconcile |

All limbs follow the same lifecycle: **describe → write → admit → attach →
operate → judge → cache → retire** (§30). The introspection limb generates new
limbs automatically when it detects capability gaps — the agent learns to
build its own tools.

**Commands after install:**
```bash
neuron limb inspect .state         # list admitted limbs
neuron limb admit ./my-limb .state # admit a new limb by digest
neuron limb run .state --package ./my-limb --neuron id --stimulus req.json
neuron compact .state               # snapshot + truncate WAL
neuron telemetry project .state     # firing stats
```

## Building

Requirements:

- Rust (the repository pins its toolchain in `rust-toolchain.toml`)
- Zig 0.16.0+ (for the Contract runtime and neuron binary)
- DotSlash for the hermetic tools under `bin/`
- Contract's `libcontract.dylib` installed at `~/.aiko/lib/` (or selected with
  `AIKO_CONTRACT_LIBRARY`)

```sh
# Build everything (contract dylib + aiko binary + SDK package)
scripts/contract-runtime.sh build-aiko

# Just the aiko binary (no contract rebuild)
cargo run -p xai-grok-pager-bin

# Package for distribution (includes SDK)
scripts/contract-runtime.sh package

# Install to ~/bin/aiko + ~/.aiko/
scripts/contract-runtime.sh install
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
