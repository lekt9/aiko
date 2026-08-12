# Aiko capability verification

> **Historical.** Dated report or retest log. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Updated after repair: `2026-07-22T02:42:13+08:00`
Installed binary: `/Users/lewis/bin/aiko`
Version: `aiko 0.2.102 (8acf895)`

| Capability | Result | Evidence |
|---|---|---|
| installed-cli | PASS | Installed Aiko reports its version and command catalog. |
| packaged-contract | PASS | Installed ABI v3 library is arm64 and exports turn, task, and ranking symbols. |
| background-worker | PASS | LaunchAgent-backed Contract worker is running. |
| native-manifest | PASS | Versioned manifest advertises Contract, Collective, agent-mail, application, and permission interfaces. |
| native-discovery | PASS | Loopback discovery is valid and its bearer token file is mode 600. |
| config-inspection | PASS | Configuration, hooks, skills, agents, permissions, and MCP discovery serialize as JSON. |
| session-catalog | PASS | Persisted sessions can be listed without entering the TUI. |
| plugin-catalog | PASS | Installed plugin inventory is machine-readable. |
| mcp-catalog | PASS | Configured MCP inventory is machine-readable. |
| shell-completions | PASS | The rebuilt installed binary emits `#compdef aiko`, `_aiko()`, and `_aiko_commands`. |
| collective-kernel | PASS | Contract collective vectors and decentralized Aiko host/network suite pass. |
| native-api-tests | PASS | Native API schemas, bearer comparison, and external-id validation pass. |
| contract-bridge-tests | PASS | All 16 bridge tests pass using the single release library test target. |
| desktop-build | PASS | Desktop TypeScript/Vite build and stream/sanitizer tests pass. |
| contract-turn | PASS | A real model turn was declared before sampling and signed satisfied at EndTurn. |
| auth-mutation | GATED | Login/logout were not mutated; current login policy was inspected only. |
| updater-mutation | GATED | Update installation was not invoked during an audit of the active install. |
| paid-services | GATED | AgentMail inbox creation and CAPTCHA solving require explicit purchase confirmation. |
| external-channels | GATED | Telegram delivery requires a configured bot and external recipient. |
| destructive-controls | GATED | Session deletion and Contract cancel/retry were not exercised on user data. |
| windows-runtime | STATIC | Windows artifacts can be inspected on macOS but require a Windows host for execution proof. |

## Interpretation

`PASS` means the installed path or its documented acceptance suite was exercised successfully. `GATED` means testing would change accounts, spend money, contact third parties, or destroy user state. `STATIC` means the artifact can be inspected here but runtime proof requires another operating system.

## Findings

1. The completion generator and its regression assertions now consistently use the public `aiko` command name. Aiko was rebuilt, packaged with Contract, and atomically installed.
2. The bridge check now selects only the library target and uses the release profile: `cargo test --release -p xai-grok-shell --lib contract_native::tests`. Its one-time cold build remains expensive because the bridge module lives inside the full shell crate, but the test execution itself completed in 6.34 seconds with 16 passed and 0 failed.
3. Account mutation, update installation, paid services, external delivery, destructive controls, and Windows execution remain explicitly outside this local non-destructive audit. They are classified rather than silently counted as passing.
