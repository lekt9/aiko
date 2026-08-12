# Contributing

Public development happens on [`github.com/lekt9/aiko`](https://github.com/lekt9/aiko).

Read [`docs/SOURCE-OF-TRUTH.md`](docs/SOURCE-OF-TRUTH.md) before changing
documentation or install paths. Code and gates outrank prose.

## Security

Report vulnerabilities through [`SECURITY.md`](SECURITY.md). Do not open a
public issue for a security report.

## What to change

| You want to… | Start here |
|---|---|
| Fix product docs | Root `README.md`, then `docs/` |
| Change Zig harness behaviour | `neuron/`, `contract/`, `src/` — prove it with `zig build gate` |
| Change the Rust agent | `aiko/` — see [`aiko/CONTRIBUTING.md`](aiko/CONTRIBUTING.md) |
| Change Cell | `cell/` — it must stay free of `contract/` and `neuron/` imports |
| Add a limb `SKILL.md` | Do not casually edit an admitted package's `SKILL.md`; it is inside the digest |

Do not commit customer operational data (worker names, identity numbers,
live rosters) or private operator URLs.

## Toolchain

- **Zig 0.16.0** — root `build.zig` and both Zig layers
- **Rust 1.92.0** — `aiko/rust-toolchain.toml`
- **Protobuf compiler** — Rust workspace

This repository already contains `contract/` and `neuron/`. You do not need
sibling clones to build.

```sh
# Zig harness
zig build
zig build test
zig build gate

# Rust host (from aiko/)
cd aiko
scripts/contract-runtime.sh build-aiko-only
cargo test -p <crate> <test-filter>
cargo fmt --all
```

A substantive change should have a machine-verifiable check. Prefer an
existing gate over a new one. If you add a claim to a README, add it to
`tests/docs-oss-ready-gate.sh` or `aiko/scripts/check-install-docs.sh`.

## Pull requests

1. Keep the diff scoped to one residual.
2. Do not rewrite limb `SKILL.md` files or vendor/submodule docs unless the
   change is required for correctness.
3. Run the narrowest relevant gate locally.
4. By submitting a pull request you license your contribution under the
   Apache License 2.0 (see [`LICENSE`](LICENSE)).
