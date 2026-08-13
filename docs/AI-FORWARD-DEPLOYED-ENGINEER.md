# Aiko as an AI Forward Deployed Engineer

**Status classes used below:** **Proven** (runnable gate exists and is green), **Designed** (specified, not yet witnessed), **Absent** (not in this tree).

This is the product boundary. Public copy may not promote a capability past the class recorded here.

## Who it is for

A tenant that already runs a recurring operational loop — people, accounts, a system of record, outbound messages, and a cost of being wrong. The first customer shape is the staffing loop already witnessed in parts of this repository: requirement → roster → confirmation → reply or timeout → escalation → amendment → compensation.

Aiko is hired into that loop as one **role identity**, not installed as a bag of integrations.

## Category claim

**Defensible:** Aiko is an AI Forward Deployed Engineer — a digital employee that takes a role, a dedicated least-privilege account, and an outcome, then authors and operates a digest-pinned workflow.

**Not defensible yet:** “the first AI FDE.” That is a competitive claim. No competitive witness exists. Treat it as an **Absent** market fact, not as README furniture.

“Drop-in employee” names the intended *experience*: account credentials are the primary form of auth, not developer API keys. It does **not** mean skip SSO, MFA, tenant scope, or approval for high-consequence effects. First login is an authorization act, not setup failure.

## The role contract (W6H)

| Question | Binding answer |
|---|---|
| **Who** | One tenant-scoped Aiko role identity, acting through dedicated employee or service accounts. Never a borrowed personal session. |
| **What** | A controllable, digest-pinned Cell workflow, native adapters, cited context lineage, independently settled effects. |
| **When** | On an event, cadence, reply, invalidation, or explicit approval. Uncertain work stays pending. |
| **Where** | Smithers/control authors and pauses. Cell is the typed workflow. Aiko plans the frontier. Contract remembers. Neuron executes admitted limbs. Unbrowse learns existing web systems locally. |
| **Why** | Enter a real operating loop and leave a workflow that can be inspected, handed off, and trusted without trusting Aiko’s own report. |
| **How** | Observe → write inert → test → admit by digest → attach least authority → act through the outbox → read back independently → settle or compensate. |

“Single entity” means one role identity and one context envelope. It does **not** mean collapsing Neuron, Contract, Cell, or the Rust host into a monolith. A delivered workflow must keep working without a hard Aiko dependency.

## First operational wedge

**Telethon employee account** is the proposed first vertical. The first workflow is the staffing loop already partially witnessed here.

**SAP** stays a sandbox pilot on its own gate. Do not block Telethon promotion on SAP. Do not claim RFC/BAPI/OData support until the selected customer surface is built and witnessed.

## Authority model

- Aiko receives an **opaque credential handle** (`cred:<tenant>/<origin>/<account>`), never a password, cookie, token, or API key in prompts, Cell inputs, ledger rows, evidence, telemetry, generated package digests, or git.
- Secrets stay in the OS credential store and are injected only at the destination boundary. There is no plaintext-file fallback for employee credentials.
- Every handle is tenant / origin / account scoped and lists allowed actions.
- SSO, MFA, or consent on first use is required authorization, not ceremony to delete.
- Unknown scope, expiry, MFA, ambiguous timeout, or failed read-back remains pending or escalates.

## Handoff lifecycle

1. Tenant names a role, a dedicated account, and an outcome.
2. Aiko observes the existing system (Unbrowse under that account, or an already-declared membrane).
3. A capability gap is closed by discovery or bounded authoring. Bytes are written **inert**.
4. Build, test, admit by digest, attach least authority. Compilation alone retains nothing.
5. The typed workflow is a Cell. Smithers/control may pause, approve, or resume it. Contract owns the frontier. Neuron fires admitted limbs.
6. Effects leave through the outbox and are settled only by independent read-back.
7. Invalidation redrives or opens a compensation gap. A boundary already crossed is never re-crossed.
8. The delivered Cell and admitted limbs remain after the Aiko host is gone.

## Self-wiring loop (this increment)

The native shape is Cell, not a second scheduler:

```text
account-handle → deploy-workflow → deploy-aiko
                      │
                      └─ authored cell is itself a seat harness
                         that wires deploy-aiko
```

Aiko deploys a workflow. That workflow is a Cell. That Cell is a harness that seats Aiko. The next workflow Aiko deploys is the same primitive. Harness within the harness is the design.

Smithers (local unpublished checkout: `aiko-flow/`) is the control/authoring surface only. It must emit, pause, and resume the bound Cell. It is not a shipped product surface and is not a second ledger.

## Status of claims

### Proven

| Claim | Witness |
|---|---|
| Neuron fires, membranes, limbs, standalone without Contract | `neuron` gates (`runtime`, `universal-interface`) |
| `redrive` three-case invalidation, including compensation | `redrive-gate` |
| Self-wiring by discovery and self-writing by digest admission | `interface-morphogenesis-gate`, `meta-agent-gate` |
| Bounded authoring that never reads the gap’s acceptance | `authored-gap-gate` |
| Deterministic staffing roster; shortfall writes nothing | `staffing-engine-gate` |
| Escalation ladder terminates; confirmed worker is not re-messaged | `escalation-ladder-gate` |
| Cell is a typed DAG with Merkle manifests and a self-hosting builder | `cell/tests/gate.sh` |
| Account handle is the Cell-native auth unit; raw API keys are refused | `cell/tests/gates/fde-self-wire.sh` |
| Deploy-workflow authors a seat Cell; deploy-aiko seats Aiko; digest moves with the outcome | `tests/fde-workflow-gate.sh` |
| Graph planning is Contract’s, not a second scheduler | `tests/graph-engineering-gate.sh`, `aiko-doctor graph-plan` |

### Designed

| Claim | Next witness |
|---|---|
| OS credential vault: inventory, expiry, MFA handoff, revoke, rotate, logout | `tests/credential-envelope-gate.sh` (not yet written) |
| Smithers pause/resume survives restart and agrees with Cell digest + Contract frontier | remainder of `fde-workflow-gate` (control-plane half) |
| Context plane: cited, tenant-isolated, invalidates on source movement, survives handoff | `tests/fde-context-gate.sh` |
| Native authoring of a new adapter family through write-inert → admit → attach | `tests/fde-authoring-gate.sh` |
| Unbrowse port: observe → independent replay → promote → drift demotes; secrets sealed | `tests/unbrowse-aiko-gate.sh` |

### Absent

| Claim | Why it is absent |
|---|---|
| Market-first / “the first AI FDE” | No competitive witness |
| Production Telethon employee-account adapter | No `telethon-fde-gate` |
| Production SAP adapter | No `sap-fde-gate` |
| Operator write UI (queues, roster edit, approvals) | Live view is read-only by design |
| Managed credential vault in the OS secret store | Capability gap `enterprise-credential-vault` |
| Publishing `aiko-flow/` (Smithers checkout) as a shipped Aiko surface | Local unpublished; see `docs/SOURCE-OF-TRUTH.md` |

## Promotion gate for the first vertical

Telethon may be promoted from Designed to Proven only when `tests/telethon-fde-gate.sh` proves, from empty state:

1. dedicated account login (phone / code / 2FA) stores only an opaque handle
2. inbound updates normalize through Neuron’s provider-neutral interface
3. per-chat and per-recipient ACL holds
4. send goes through the outbox and is read back independently
5. amendment contacts only changed recipients
6. redrive never resends a message that already crossed
7. auth expiry or unobservable send stays pending and escalates

No documentation promotion of “Aiko runs Telegram as an employee” happens before that gate is green.

## Acceptance for this document

This file is the contract for the category. It is accepted when:

- every capability statement is classed **Proven**, **Designed**, or **Absent**
- the first vertical and its runnable gate are named
- market-first remains **Absent**
- the self-wire Cell loop has a gate that fails if raw API keys are accepted or if the authored harness no longer seats Aiko
