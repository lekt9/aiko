# Source of truth

This file is the inventory of **what the published tree actually is**.
Prose elsewhere must not contradict it. Code and runnable gates outrank
this file; if they diverge, fix the prose.

## Product

**Aiko** is the forward-deployed engineer — the only product name for this
agent. Do not call the product Grok, Grok Build, or Grok CLI.

Crate directories and Cargo packages may still be named `xai-grok-*`.
Those are implementation identifiers. Theme keys `groknight` / `grokday`,
config dir `~/.grok/`, tool ids `GrokBuild:*`, and xAI model ids
`grok-4*` are compatibility or provider names, not the FDE.

**Aiko** is an agent you hire: a Contract-native laptop agent (terminal TUI,
headless, ACP, desktop) on top of a Zig harness that refuses to claim work
happened when it did not.

Public clone: [`https://github.com/lekt9/aiko`](https://github.com/lekt9/aiko)

Internal mirror (not the public clone URL): `gitea:Unbrowse/commons.git`

Spelling: **Aiko**. Meeting notes that say “Ico” are a transcription artifact.

## Layers (one monorepo)

| Path | What it is | In the Zig root build? |
|---|---|---|
| `neuron/` | Firing primitive, membrane, `port`, `redrive`, admitted limbs | Yes (`zig build` installs its CLI as `zig-out/bin/aiko`) |
| `contract/` | Durable interpreter: ledger, W6H, occurrences, validity windows | Yes (`libcontract`) |
| `src/` | `aiko-doctor` — first binary that links **both** Zig layers | Yes |
| `tests/` | Root witnesses (`bridge`, `dispatch`, `tick`, `zig-doctrine`, `conformance`, graph-engineering) | Driven by `zig build gate` |
| `aiko/` | Rust host: TUI, desktop, ACP, MCP, packaging | **No** — compile from `aiko/` |
| `cell/` | Fractal YAML/Python harness standard | **No** — standalone, does not import `contract/` or `neuron/` |
| `docs/` | Cross-layer product docs (this tree) | n/a |
| `aiko/apps/frontend` | Third-party submodule ([Simpleyyt/ai-manus](https://github.com/Simpleyyt/ai-manus), MIT) | No |

**Direction is load-bearing:** `neuron` builds and tests with `contract`
absent. Do not reverse that dependency.

## What is *not* in the published tree

| Path | Status |
|---|---|
| `aiko-flow/` | Local unpublished workspace. Not tracked. Do not document it as a shipped product surface. |
| `career-ops/` | Local unpublished workspace. |
| `cell/hoysan-*`, `cell/data/hoysan-*` | Customer operational material. Must not be committed. |
| Build outputs (`zig-out/`, `target/`, `.zig-cache/`) | Generated. Reproduce with `zig build` / `cargo`. |

## How to build (verified commands)

From the **monorepo root**:

```sh
zig build                 # zig-out/bin/aiko  and  aiko-doctor
zig build test            # both Zig layers' suites
zig build gate            # acceptance witnesses
./zig-out/bin/aiko-doctor # prove both Zig layers link in one process
```

From `aiko/` (Rust host):

```sh
# Finds in-tree ../contract automatically (see scripts/contract-runtime.sh).
scripts/contract-runtime.sh install
# → ${AIKO_BIN_DIR:-~/bin}/aiko
# → ${AIKO_HOME:-~/.aiko}/lib/libcontract.*
```

`AIKO_CONTRACT_REPO` is an **override**, not a required sibling checkout.
In this monorepo the default walk already hits `aiko/../contract`.

## License

Apache License 2.0. See [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE).
`aiko/apps/frontend` remains MIT (upstream).

## Documentation policy

| Kind | Rule |
|---|---|
| Product README, install, architecture | Must match this file and the commands above |
| Gate-backed claims (`CONFORMANCE.md`) | Keep; they are already mechanically checked |
| Historical plans (`PLAN.md`, `PLAN-aiko-convergence.md`, `aiko/plan*.md`) | Banner as historical; do not present as current worklists |
| Limb `SKILL.md` inside `neuron/limbs/` | **Do not rewrite** — they sit inside the package digest |
| Changelogs, prompt templates, vendor docs | Leave unless they leak secrets or customer data |
| `contract/docs/*` due-diligence / thesis | Internal design notes, not the product README |

## Open-source readiness

A published clone must have:

- `LICENSE`, `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`
- no private keys, provider API tokens, or Tailscale/Gitea operator URLs
- no customer operational data (worker names, identity numbers, live rosters)
- clone/build instructions that work from `github.com/lekt9/aiko` alone

Witness: `tests/docs-oss-ready-gate.sh`.
