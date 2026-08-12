# Contributing

The published monorepo is [`github.com/lekt9/aiko`](https://github.com/lekt9/aiko).
This directory (`aiko/`) is the Rust host. Contribution process for the whole
tree is in the root [`CONTRIBUTING.md`](../CONTRIBUTING.md).

SpaceXAI publishes this source under the Apache License, Version 2.0
(see [`LICENSE`](LICENSE) and the root [`LICENSE`](../LICENSE)).

## Security reports

Please report security issues through the process described in
[`SECURITY.md`](SECURITY.md). Do not open a public issue for vulnerabilities.

## Internal development

Development uses the toolchains expected by the runtime packaging script:

- Rust 1.92.0, pinned by [`rust-toolchain.toml`](rust-toolchain.toml);
- Zig 0.16.0 or newer;
- a Protocol Buffers compiler: `PROTOC`/`protoc` on `PATH`, or DotSlash
  (`cargo install dotslash`) for the repository's hermetic `bin/protoc`;
- in-tree `../contract` and `../neuron` (this monorepo). `AIKO_CONTRACT_REPO`
  is an override, not a required extra clone.

Run commands from the repository root:

```sh
# Fast Aiko-only loop; does not rebuild or package Contract
cargo run -p xai-grok-pager-bin
scripts/contract-runtime.sh build-aiko-only

# Build/package the Aiko binary, Contract ABI 13 runtime, skills, and SDK
scripts/contract-runtime.sh build-aiko

# Start with the narrowest relevant test
cargo test -p <crate> <test-filter>

# Format before handoff
cargo fmt --all
```

Every substantive change must have a machine-verifiable Contract task. Register
the outcome and its real check before implementation, then settle it only after
the check passes:

```sh
contract task begin "<outcome>" --check "<command that proves it>"
contract task verify <task-id>
```

See the [repository field guide](docs/REPOSITORY-GUIDE.md#build-and-packaging-map)
for component-specific builds, tests, source ownership, and debugging paths.

## Licensing of this source

By downloading or using this source, you agree that your use is governed by
the Apache License, Version 2.0. No contributor license agreement is offered
because external contributions are not accepted.
