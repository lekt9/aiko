# Contract agency runtime in Aiko

Aiko owns the public agent experience. Contract is the bundled native control
substrate loaded into that experience. They remain separate source repositories
and ship as one checksummed runtime package.

## Turn lifecycle

At the start of a turn, Aiko declares the user’s goal through Contract’s native
ABI. A genuine completed turn records satisfaction; cancellation, failure, or
an unavailable substrate does not fabricate success. Contract bookkeeping is
best-effort for the ordinary Aiko turn and cannot prevent the agent from doing
the user’s work.

Contract retains one resolver and one append-only signed ledger. Its additive
agency schema distinguishes:

| Role | Responsibility |
|---|---|
| `purpose` | human-owned objective and frozen boundaries |
| `governor` | target ownership, arbitration, approval, and cadence |
| `action` | work with declared capability and effect reach |
| `sensor` | external consequence observation |
| `evaluator` | independent criteria, counter-metrics, and veto |
| `development` | attributable, reversible graph change proposals |

Untyped Aiko turn rows remain `legacy_ungoverned`. Contract does not infer a
role from prompt text or historical success.

## Grounding and failure behavior

High-risk typed actions require capability coverage, explicit approval, and a
fresh sensor that observes at least the declared reach. Sensors produce typed
reality anchors with a digest, concrete source, collection method, observation
window, failure domain, and tamper/revocation state. Large or private evidence
stays behind content-addressed pointers.

Independent evaluation counts instruments and failure domains rather than row
or wallet count. Copied and circular confirmations do not inflate confidence.
A counter-metric veto prevents promotion. Fresh contradiction, sensor loss,
anchor expiry, capability breach, or compromised evidence bypasses a green
cache and invalidates downstream consumers in the same resolver tick.

Recovery uses only a verified, unrevoked checkpoint under the active policy.
Changing the graph is a separate `development` operation with rationale,
evidence, authority, predicted impact, atomic application, and an inverse patch.

## Observability and secrets

Contract writes a small operational health log and a separate causal JSONL
stream. Events contain controlled identifiers and references—not prompts,
payloads, credentials, or environment values. Secret-shaped fields are rejected
before persistence, and the offline renderer redacts hostile imported JSON.

The standalone Contract CLI supports:

```sh
contract events [--trace <id>]
contract watch [<trace-id>] [--json]
contract explain <trace-id>
```

These read-only paths, along with help, status, task status, and self, dispatch
before queued retries, wallet resolution, signing, and network work. A fresh
file-backed Contract identity does not write Keychain. Native Keychain access is
reserved for explicit keychain-only import, maintenance/rotation, or recovery.

## Build, package, and install

From the Aiko repository:

```sh
scripts/contract-runtime.sh
# equivalent:
scripts/contract-runtime.sh build-aiko
```

Both commands rebuild the sibling Contract dylib, build the Aiko release
binary, and refresh the combined package under `target/aiko-package/`.
`build-aiko-only` is the explicit opt-out for an intentionally unpackaged local
build.

The versioned package contains:

```text
aiko-<version>-<platform>/
├── bin/aiko
├── lib/libcontract.dylib
├── manifest.json
└── install.sh
```

The manifest pins both SHA-256 hashes, source commits, dirty-state flags,
platform, ABI version, and build time. The installer verifies the manifest
before atomically installing Aiko and Contract. At runtime Aiko searches:

1. `AIKO_CONTRACT_LIBRARY`;
2. the dylib beside its packaged binary;
3. `~/.aiko/lib/libcontract.dylib`;
4. the sibling Contract development build.

Every candidate must export Contract ABI version 2 before Aiko resolves its
function pointers.
