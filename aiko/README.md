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

## The goal — zero setup, one shot, nothing to install

Aiko optimizes for one thing: **you describe what you want, in one prompt, and
it happens** — with nothing to configure and nothing to bolt on first. The whole
design is bent toward that outcome, and features are judged against it.

- **Zero setup.** Opening Aiko is enough. It stands up its own runtime, adopts or
  starts whatever it needs, and degrades honestly when something is missing — it
  never hands you a checklist before it will work. There is no config file to
  edit, no key to paste, no service to run on the side.
- **One-shot prompts.** A task is a sentence, not a session. You state the goal
  and Aiko carries it through — plan, act, verify — without a wizard, a scaffold,
  or a second round of questions to get started.
- **Internal tooling, not a plugin bag.** The capabilities are *native* to Aiko.
  You do **not** install a skill or stand up an MCP server to give it a new
  power — that is the exact ceremony this product refuses. Tooling ships inside
  the agent; the user never assembles it.
- **Integration is [Unbrowse](https://github.com/Unbrowse), not bespoke wiring.**
  When Aiko needs to reach into another system or site, it acts through Unbrowse —
  the action engine of the internet — rather than a hand-written integration or a
  per-service connector the user has to install. One mechanism reaches everything.

The test for any change: does it move Aiko toward *prompt in, result out, nothing
installed* — or does it add a step the user has to perform first? If it adds a
step, it is working against the goal. (This is the north star; the from-source
developer install below is for building the harness itself, not the user path —
the user path is meant to be: open it, prompt it, done.)

See [docs/GOAL.md](docs/GOAL.md) for the canonical statement and how it decides
scope.

## Installation

There are two install paths. They install **different things**:

| Path | Installs | Needs |
|------|----------|--------|
| **From source** (`scripts/contract-runtime.sh install`) | `aiko` binary + Contract dylib + packaged skills/SDK | Rust, Zig, sibling `contract` + `neuron` checkouts |
| **Registry bootstrap** (`sdk/registry/setup.sh`) | Contract dylib + `neuron` CLI + limbs only (**not** the `aiko` binary) | Tailscale to Gitea, `GITEA_TOKEN` |

Most developers: **from source**, then login. Registry setup is optional for
neuron/limbs if you already have them via the package.

### Prerequisites (from source)

- **Rust** — pin is `rust-toolchain.toml` (currently 1.92.0)
- **Zig 0.16.0+** — builds Contract (`libcontract`) and the neuron binary
- **Sibling repos** (default layout under the monorepo parent):
  - `~/Unbrowse/contract-core` — or `../contract-core` — or set `AIKO_CONTRACT_REPO` (fallback `../contract` for legacy)
  - `contract-core` bundles `libcontract` + `zig` CLI (no separate `neuron` checkout required; legacy `../contract` + `../neuron` still accepted)
- Shell `PATH` includes **`~/bin`** (where `install` places `aiko`)

```bash
# monorepo layout expected by defaults
# <parent>/
#   aiko/          # this repo
#   contract/
#   neuron/
export PATH="$HOME/bin:$PATH"
```

### From source (recommended for this tree)

```bash
cd /path/to/aiko   # this repository root

# Build Contract + Aiko, package, atomically install
scripts/contract-runtime.sh install
# → ${AIKO_BIN_DIR:-~/bin}/aiko
# → ${AIKO_HOME:-~/.aiko}/lib/libcontract.dylib

# Optional: neuron CLI + generative limbs from Gitea package registry
export GITEA_TOKEN=…   # Unbrowse org token; setup prompts if unset
bash sdk/registry/setup.sh
# → ~/.local/bin/neuron  (default AIKO_BIN_DIR for setup.sh)
# → ~/.aiko/lib/  and  ~/.aiko/limbs/

# Session login — inference uses the public Aiko proxy (no client Surplus key)
aiko login

# Verify
aiko --version
command -v neuron >/dev/null && neuron --help
ls ~/.aiko/limbs/ 2>/dev/null || true
```

Docs witness (agents / CI): `bash scripts/check-install-docs.sh`

### Portable package (another machine)

On a machine that already built the package:

```bash
scripts/contract-runtime.sh package   # or install (builds package first)
ls target/aiko-package/aiko-*-*.tar.gz
```

On the target host:

```bash
tar -xzf aiko-<version>-<platform>.tar.gz
cd aiko-<version>-<platform>
./install.sh
# verifies SHA-256 from manifest.json, then:
#   bin/aiko → ~/bin/aiko
#   lib/libcontract.* → ~/.aiko/lib/
export PATH="$HOME/bin:$PATH"
aiko --version
aiko login
```

Override install locations with `AIKO_BIN_DIR` and `AIKO_HOME`.

### Registry-only bootstrap (neuron stack, not the agent TUI)

Does **not** install `~/bin/aiko`. Use after you already have an `aiko` binary,
or only need Contract + neuron + limbs:

```bash
export GITEA_TOKEN=…
# Still needs Tailscale reachability to the Gitea host
curl -sL http://100.124.140.92:3000/Unbrowse/aiko/raw/branch/main/sdk/registry/setup.sh | bash
# or, from a checkout:
bash sdk/registry/setup.sh
```

### First login and inference path

```text
aiko (session JWT)
  → https://aiko.theclarityproject.net   # aiko-openai-compat
    → aiko-proxy                         # injects server-side SURPLUS_API_KEY
      → gateway.codegraff.com/v1/* (primary)
      → api.surplusintelligence.ai/v1/* (failover)
```

- **Clients:** run `aiko login`. Do **not** set `SURPLUS_API_KEY` for normal use.
- **Operators** of the proxy: put `SURPLUS_API_KEY` only on the Cloudflare Worker
  ([aiko-proxy](http://100.124.140.92:3000/Unbrowse/aiko-proxy),
  `bash scripts/deploy.sh`).

**What a full install gives you:** Aiko agent TUI with Contract-native turn
lifecycle + typed neuron runtime + generative limbs that self-observe, preempt
redundant work, route by energy, and can author new limbs for gaps.

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
and records a terminal result through Contract ABI 13. Advanced typed envelopes
and trust policy are additive, so existing ledgers and turns remain compatible.
Contract’s causal event stream is local and redacted; the standalone Contract
CLI can inspect it with `events`, `watch`, and `explain` without requesting
wallet or Keychain access.

## Canonical Neuron execution

Contract ABI 13 is the durable interpreter for Aiko's typed Skill nodes. Its
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

Requirements are the same as [Installation → Prerequisites](#prerequisites-from-source).
Additional:

- DotSlash for hermetic tools under `bin/`
- Node.js + npm for the desktop app and macOS product installer
- Optional: `AIKO_CONTRACT_LIBRARY` to point at a non-default Contract dylib

```sh
# Build everything (contract dylib + aiko binary + SDK package)
scripts/contract-runtime.sh build-aiko

# Run the Aiko binary in the development profile (no Contract rebuild/package)
cargo run -p xai-grok-pager-bin

# Build just the Aiko binary with the selected release profile
scripts/contract-runtime.sh build-aiko-only

# Package for distribution (includes SDK) → target/aiko-package/
scripts/contract-runtime.sh package

# Package + atomic install → ~/bin/aiko and ~/.aiko/lib/
scripts/contract-runtime.sh install
export PATH="$HOME/bin:$PATH"
~/bin/aiko --version
```

### macOS desktop installer (`.pkg`)

The canonical macOS installer script is [`scripts/prep-installer.sh`](scripts/prep-installer.sh).
It recreates the staged app, packages both `/Applications/Aiko.app` and
`/usr/local/bin/aiko`, signs when the matching Apple identities are available,
verifies the result, and writes versioned deliverables under `dist/`.

Run the build in this order so neither the desktop bundle nor its CLI sidecar is
stale:

```sh
# 1. Verify desktop metadata is already aligned with the Aiko CLI release
RELEASE_VERSION="$(sed -n -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
  crates/codegen/xai-grok-pager-bin/Cargo.toml | head -1)"
test "$(node -p "require('./apps/aiko-app/package.json').version")" = "$RELEASE_VERSION"
test "$(node -p "require('./apps/aiko-app/src-tauri/tauri.conf.json').version")" = "$RELEASE_VERSION"
test "$(sed -n -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
  apps/aiko-app/src-tauri/Cargo.toml | head -1)" = "$RELEASE_VERSION"

# 2. Build Contract, the release CLI, and the portable CLI package
scripts/contract-runtime.sh build-aiko

# 3. Install the desktop dependencies and materialize the native sidecar
pnpm --dir apps/aiko-app install --frozen-lockfile
pnpm --dir apps/aiko-app runtime:prepare

# 4. Build the Tauri app bundle with the current CLI + Contract runtime
pnpm --dir apps/aiko-app exec tauri build --bundles app

# 5. Recreate and verify the macOS product installer
scripts/prep-installer.sh

# Outputs, named from the Aiko CLI version:
#   dist/Aiko-Installer-<version>.pkg
#   dist/Aiko-Installer-<version>.pkg.zip
```

Verify an existing installer without rebuilding it:

```sh
scripts/prep-installer.sh --check
```

For a production release, install the `Developer ID Application` and
`Developer ID Installer` identities, store the `notarytool` profile named
`aiko`, then run `scripts/prep-installer.sh --notarize`. Without those
identities the script creates an ad-hoc-signed app and unsigned package suitable
for local testing, but it does not claim the installer is Gatekeeper-ready.

CI runs `bash scripts/check-installer-ci.sh` and an unsigned product-installer
smoke build on `macos-latest` for every push and pull request. The release
workflow builds the product installer on `macos-latest`, verifies its expanded
package and zip, and publishes stable `Aiko-macOS.pkg` and
`Aiko-macOS.pkg.zip` assets alongside the DMG. Production release signing is
mandatory; configure
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and
`APPLE_SIGNING_IDENTITY` for the app, plus `APPLE_INSTALLER_CERTIFICATE`,
`APPLE_INSTALLER_CERTIFICATE_PASSWORD`, and
`APPLE_INSTALLER_SIGNING_IDENTITY` for the product package. With
`APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`, the package is also notarized.
The release tag or manual workflow version must match the version in
`crates/codegen/xai-grok-pager-bin/Cargo.toml`; CD refuses mixed-version assets.
CD also refuses to publish the package unless the Developer ID Installer
signature and stapled notarization ticket both validate.

Environment overrides used by the packaging scripts:

| Variable | Default | Purpose |
|----------|---------|---------|
| `AIKO_CONTRACT_REPO` | `../contract` | Contract source tree |
| `AIKO_BUILD_PROFILE` | `release` | Cargo profile |
| `AIKO_HOME` | `~/.aiko` | Runtime home (lib, skills, limbs) |
| `AIKO_BIN_DIR` | `~/bin` | Where `install` places `aiko` |

The release artifact is `target/release/aiko` (also packaged under
`target/aiko-package/`). Internal crate names retain their existing
`xai-grok-*` names for source and workspace compatibility.

## Contract runtime packaging

Aiko and Contract remain separate source repositories. Contract is built as a
native runtime library and shipped in the same package as Aiko:

```text
aiko-<version>-<platform>/
├── bin/aiko
├── lib/libcontract.dylib          # libcontract.so or contract.dll off macOS
├── skills/                        # admitted Contract-native skills
├── sdk/registry/                  # neuron/limb registry bootstrap tools
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
full-duplex agent-mail protocol and Contract ABI 13 as the ledger/task
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
