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

## Single source of truth

**Contract (`contract/libcontract`) is the SSOT.** All durable work — Aiko turns, Telegram occurrences, Smithers runs, evidence — lives in its ledger (`contracts.jsonl` via `libcontract.dylib`). The Telegram offset file (`~/.aiko/telegram/offset`), `~/.aiko/native/api.json` token, Smithers `/tmp/smithers-gateway/*.json` runtime file, and `docs/graph-engineering/*.walk.json` execution plans are **ephemeral cursors/projections**, never second ledgers. See `DOCTRINE.md` + `contract-hook-covenant-gate.sh` `forbidden_ledgers == ["HookOccurrence","ContextEnvelope"]`.

## Layers (one monorepo)

| Path | What it is | In the Zig root build? |
|---|---|---|
| `neuron/` | Firing primitive, membrane, `port`, `redrive`, admitted limbs | Yes (`zig build` installs its CLI as `zig-out/bin/aiko`) |
| `contract/` | Durable interpreter: ledger, W6H, occurrences, validity windows | Yes (`libcontract`) |
| `src/` | `aiko-doctor` — first binary that links **both** Zig layers | Yes |
| `tests/` | Root witnesses; the exact `zig build gate` inventory is derived from `build.zig` and listed in the root README and `CLAUDE.md` | Driven by `zig build gate` |
| `aiko/` | Rust host: TUI, desktop, ACP, MCP, packaging | **No** — compile from `aiko/` |
| `aiko-flow/` | In-monorepo Smithers control/authoring surface; MIT-licensed source. Its root npm workspace is `private: true`, which prevents publishing that aggregate package; it does not make the tracked source private or unpublished. | **No** — standalone TypeScript workspace |
| `cell/` | Fractal YAML/Python typed harness standard; it does not own credentials, context, admission, or durable control truth | **No** — standalone, does not import `contract/` or `neuron/` |
| `neuron/limbs/unbrowse/` | Digest-admitted provider-neutral read boundary | Yes (standalone Neuron gate) |
| `neuron/limbs/telethon/` | Digest-admitted provider-neutral effect boundary with synthetic conformance fixtures | Yes (standalone Neuron gate) |
| `aiko-flow/packages/components/src/components/` | Smithers `Cell`/`runCell` typed harness plus Contract-backed `ContractCell`; not an authority store | No — standalone TypeScript workspace |
| `docs/` | Cross-layer product docs (this tree) | n/a |
| `aiko/apps/frontend` | Third-party submodule ([Simpleyyt/ai-manus](https://github.com/Simpleyyt/ai-manus), MIT) | No |

**Direction is load-bearing:** `neuron` builds and tests with `contract`
absent. Do not reverse that dependency.

## AI-FDE claim boundary

The following published witnesses are green in this tree:

| Proven in-tree claim | Runnable witness |
|---|---|
| Contract-backed cited context and delegated authority | `tests/contract-hook-ingress-gate.sh`, `tests/contract-delegation-capability-gate.sh` |
| Smithers typed Cell/runCell composed with Contract control | `tests/no-duplicate-fde-primitives-gate.sh`, `tests/smithers-contract-driver-gate.sh` |
| Bounded native authoring through digest admission and real-path judgment | `neuron/tests/authored-gap-gate.sh` |
| Admitted Unbrowse read boundary | `neuron/tests/unbrowse-limb-gate.sh` |
| Admitted provider-neutral Telethon effect boundary | `neuron/tests/telethon-limb-gate.sh` |
| Obsolete wrong-layer authority cannot return | `tests/no-duplicate-fde-primitives-gate.sh` |

These witnesses do **not** establish a market-first claim, a managed enterprise
credential vault, a production Telegram employee-account/provider integration,
a production SAP adapter, or an operator write UI. Those remain **Absent** in
[`AI-FORWARD-DEPLOYED-ENGINEER.md`](AI-FORWARD-DEPLOYED-ENGINEER.md).

## What is *not* in the published tree

| Path | Status |
|---|---|
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

The monorepo is Apache License 2.0 except where a tracked component carries its
own license. See [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE). `aiko-flow/`
and the `aiko/apps/frontend` upstream remain MIT.

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
