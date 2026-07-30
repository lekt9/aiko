# Contract self-audit against `SKILL.md`

**Date:** 2026-07-21  
**Scope:** the claims made by the Contract skill, tested using Contract's own
native suite plus black-box invocations of the shipped `scripts/contract`
binary in an isolated `HOME` and workspace.  
**Result:** **pass — 17/17 black-box gates passed and 752/752 Zig tests
passed.** The audit originally exposed two defects; both are retained below as
resolved findings so the security decisions and regression coverage remain
visible.

Run the reproducible audit from the repository root:

```sh
scripts/self-audit.sh
```

The script exits non-zero whenever an advertised invariant fails.
It does not call `declare`, signing, `import-root`, resident `tick`, broadcast,
wallet payment, or any on-chain write path.

## Executive result

| Area | Result | Evidence |
|---|---|---|
| Native deterministic kernel | Pass | `zig build test --summary all`: 752/752 tests |
| Collective conformance | Pass | 2/2 checked-in golden vectors |
| Command separation | Pass | the goal-only persona is absent; `aiko` does not select Contract CLI behavior |
| Real checked-task lifecycle | Pass | begin → pending → failed verify → proof created → satisfied |
| Verification exit semantics | Pass | failed check exits 1 and remains pending; successful rerun exits 0 |
| Causal action/sensor/evaluator trace | Pass | all roles exist and retry attempts have unique parent-linked IDs |
| Read-only wallet isolation | Pass | help/status/events/explain/self create no wallet or ledger and do not block |
| Secret persistence boundary | Pass | planted marker absent; offline renderer contains redaction boundary |
| Binary self-attestation | Pass | unsigned clean-home mutation is refused before a ledger write; explicit isolated signing enables it |
| Governed high-risk HOLD | Pass at kernel level | governance, anchor, trust, failure, and development tests |
| Scheduling/leases/settlement | Pass at kernel level | scheduler and ABI tests; not a live daemon endurance test |
| Aiko channel limbs | Not proven here | owned by Aiko daemon/integration code, not Contract alone |
| Claude uses Contract correctly | Not mechanically enforceable | this is an agent operating rule, not a binary invariant |

## Resolved finding 1: self-verification previously warned and continued

Before this repair, a clean isolated home emitted:

```text
binary-attest: WARN self-verify failed (SignatureVerificationFailed)
```

It then created the task and exited successfully. That conflicted with the
source/build description that startup self-verification “refuses to run” when
verification fails.

Why this matters: the signed-build story is not a runtime enforcement boundary
for a clean profile if failure is advisory. The task ledger behavior remains
functional, but the attestation claim is stronger than the observed behavior.

Resolution applied:

1. declaration mutations now fail closed after a missing, stale, foreign, or
   tampered binary signature;
2. read-only and explicit signing/bootstrap verbs remain available;
3. the audit copies the executable into an isolated profile, proves its
   unsigned mutation is refused before any ledger row exists, explicitly signs
   that copy, then proves the signed mutation succeeds.

## Resolved finding 2: retry event IDs were duplicated

The original audit performed one failed verification and one successful retry.
Contract preserved six events but produced only three unique IDs:

```text
task-action-<id>-1
task-sensor-<id>-1
task-evaluator-<id>-1
```

The same identifiers were reused because `zig/src/main.zig` hard-coded the
`-1` suffix for every verification. Parent links therefore referred to a
non-unique node after retries.

Why this matters: the skill promises preserved evidence, retries, and a causal
action → sensor → evaluator trace. The events are retained, but event identity
is ambiguous, weakening graph traversal, deduplication, and external evidence
consumers.

Resolution applied: the durable next iteration wave is now the attempt number.
The action, sensor, evaluator, anchor, iteration, and final satisfaction rows
all use that same attempt. The failed-then-pass black-box regression asserts
that all six event IDs are unique and their causal roles remain renderable.

## Claim-by-claim assessment

### “Contract records, resolves, executes/caches, verifies, records outcome”

**Mostly proven.** The native suite covers deterministic declaration/cache
keys, resolver state, dependency synapses, negative-cache bypass, failure
propagation, scheduling, leases, settlement, and signed terminal behavior. The
black-box lifecycle proves that the advertised `task begin/status/verify`
surface runs a real shell check and does not satisfy a failed task.

Retry evidence now retains unique causal identity across attempts.

### “Never claim success from an LLM judgment alone”

**Proven for checked local tasks.** `task verify` derives its verdict from the
real command exit code. A missing proof leaves the task pending and exits
non-zero; creating the proof and verifying again satisfies it.

This does not prove that every caller chooses a meaningful check. Contract can
execute the declared check faithfully, but it cannot determine whether a weak
check such as `true` captures the user's real outcome.

### “Use task begin; verification re-runs the check”

**Proven.** The isolated test begins with `test -f proof.txt`, observes a
failure, creates `proof.txt`, reruns verification, and observes satisfaction.

### “Do not expose secrets/private keys/payment credentials”

**Proven for the maintained fixtures and inspected surfaces.** The runtime
secret scanner passes, read-only output contains no secret-shaped values, and
the event renderer retains its redaction boundary. This is a regression claim,
not a mathematical proof for every future input.

The first-run wallet onboarding prints public addresses and funding guidance;
it did not print the generated root seed or private key.

### “Read-only commands stay outside wallet, retry, network, and Keychain”

**Proven by the existing black-box audit.** `--help`, `status`, `events`,
`explain`, and `self --json` complete in isolated state without creating
`root.key`, encrypted key material, or a semantic ledger, and without
prompt-shaped blocking.

### “On-chain submission is disabled unless explicitly requested”

**Supported, not end-to-end network-proven by this audit.** The normal CLI help
surface exposes no broadcast/payment verb, the broadcast utility is a separate
non-default build target, and this audit invokes no network or signing path.
Kernel tests cover operator/capability gates. A packet-level no-network test for
every default command is not currently part of `scripts/self-audit.sh`.

### “High-risk typed actions remain HOLD until authority and sensors exist”

**Proven at the deterministic kernel level.** The suite includes explicit tests
that high-risk reach needs approval plus a fresh same-reach sensor, grounded
workflows cannot satisfy before an independent reality check, copied/same-domain
evidence counts once, counter-metrics veto promotion, stale/revoked observations
cannot promote, and sensitive graph patches require approval.

### “Bad news, revocation, rollback, and independent evaluation work”

**Proven at the deterministic kernel level.** Tests cover same-tick downstream
invalidation, cache bypass, revocation, source/failure-domain independence,
Goodhart vetoes, and rollback restricted to verified, unrevoked,
policy-compatible checkpoints.

### “Runs schedules and maintains daemon limbs”

**Split result.** Contract's scheduler/lease/settlement primitives are covered
by native tests. The stronger operational claims—polling Telegram/Discord/
Slack/email, using every channel affordance, surviving agent restarts, and Aiko
automatically restarting a failed limb—require Aiko daemon implementations,
credentials, and live channel endpoints. Contract alone cannot self-prove
those claims, and they were not exercised here.

Those statements should be described as the Aiko integration contract or
tested in an Aiko end-to-end daemon suite, rather than counted as Contract
kernel proof.

### “Claude is the planner/reasoner; the harness is deterministic state”

**Architecturally consistent but not binary-testable.** Contract exposes state
and deterministic mechanisms. Whether an agent delegates reasoning correctly,
avoids `declare`, chooses a meaningful check, and calls `tick` only when asked
is governed by skill-following behavior outside the executable.

## What the green native suite really establishes

The 752 passing Zig tests are substantial. They cover the local ledger,
identity and lineage, canonical objects, publication/admission, ranking,
checkpoints and inclusion proofs, agency roles, anchors, governance,
development patches, failure propagation, trust, capability routing, caches,
scheduling, storage primitives, and optional chain-related components.

They do **not** erase the two black-box failures above, and they do not prove
live third-party channel behavior. Unit coverage and product claims are related
evidence, not interchangeable evidence.

## Reproduction summary

```text
Native Zig suite                 752 passed / 752
Collective golden vectors       2 verified / 2
Black-box self-audit gates      17 passed / 17
Read-only commands              5 passed / 5
Unsigned mutation               refused before ledger write
Signed isolated mutation        accepted after explicit bootstrap
Retry event identity            6 unique IDs / 6 events
```

`scripts/self-audit.sh` is now green. It remains deliberately fail-closed: a
regression in either repaired invariant makes the script and its owning
Contract task red again.
