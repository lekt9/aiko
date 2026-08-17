---
name: aiko-drop-in
description: "Drop into a human-operated comms breakpoint: shadow the person, build a typed Cell harness, spawn a capability-bounded child Aiko sharing only delegated Contract citations, and operate through the same interfaces the human used. Preferred for 'wire into this role / take over this inbox / replace this person / spawn a seat'."
---

# Aiko Drop-In — preferred seat for human breakpoints

A **breakpoint** is any human `observe → decide → effect` between two systems that can be taken over: an inbox that gets triaged, a roster that gets leveled, a WhatsApp that gets chased, an Excel that gets copied. The human is the bottleneck and the interface identity.

This skill is **preferred** when the user says any of:

> wire into this role · drop into this inbox · take over this loop · replace this person · adopt this inbox · spawn a seat · wire herself into this breakpoint

Before `contract-interface` (one interface) or `machine-cockpit` (one Mac). Those remain requisites — this skill **composes** them, not replaces them.

## Breakpoint catalog (five classes)

| Class | Example (Hoysan real) | Automatable | Harness owns |
|---|---|---|---|
| Triage router | NTS/TS preference WhatsApp → inbox label → forward | yes | ingress poll/webhook + ACL + send |
| Approval gate | “approve if off-day and 5-day fence ok, else refuse” | yes, if policy bytes pinned | Contract lease + delegation check |
| Data mule | Excel roster DAY/NIGHT/NTS → Sheets → WhatsApp screenshots | yes, always | typed Cell with idempotency key |
| Follow-up loop | 5:00 WhatsApp → 5:30 no-reply → call → blue→NTS replacement | yes | scheduler + outbox/read-back ladder |
| Judgment call | de-escalate angry PSA shortfall call | **HOLD** — pre-draft only, never auto-send | human gate |

**Falsifier:** if you cannot name the ingress bytes, the auth boundary, and the effect’s idempotency key, it is not a breakpoint — it is a wish.

## Covenant (why “same memory” does not mean shared RAM)

Spawned Aikos are **capability-bounded descendants**, not ambient peers.

- Child authority = `delegation_capability` opaque handle (verified subject/tenant + root/parent/fence + audience/purpose + expiry/max_effects + scope). **Never** `CONTRACT_ROOT=` env-string lineage.
- Context = **Contract read projection** over cited rows + graph `input_bindings` + settlements + Neuron `evidence[].sources` — narrow reads, not transcript dump.
- Smithers is scheduler only; Contract owns lineage, readiness, settlement, invalidation. No second ledger.

`shared memory` → *delegated citations*. Any implementation that copies `~/.aiko`, transcripts, or `HOME`/`API_KEY` into the child is **refused** by the gate.

## Harness composition (one shape, every breakpoint)

```
human inbox (WhatsApp/Sheets/Excel/paper/phone)
  → VerifiedIngress (transport auth, raw bytes digest, credential generation)
  → Contract declare/adopt (namespace+key+root + payload digest separate; same tuple+digest=replay, same key+changed bytes=conflict)
  → scope/authorize → fenced lease (execution_control)
  → GraphHarness Cell (deterministic roster/scheduler, pinned Cell package+limb digests)
  → Neuron limb (outbox → send → independent read-back)
  → settle or invalidate → compensation (never blind resend of crossed effect)
```

* Primitives are **frozen**: `cell/primitives/account-handle` is the seat identity (`cred:tenant/origin/account`, refuses raw tokens); reuse it before inventing a credential cell.
* `cell/patterns/fde/self-wire.cell.yaml` (`account-handle → deploy-workflow → deploy-aiko` = “Aiko seats Aiko”) is the harness parent. This skill composes it, not rebuilds it.
* `cell/patterns/hoysan-draft/hoysan-draft.cell.yaml` is the existing Hoysan roster engine (`synthetic-safe, infeasible→refuse→retain nothing`) — extend its request schema, do not fork.
* Input alias: same receptor validates under `poll` vs `webhook` vs `hook` (`cell/patterns/input-sources/harness.cell.yaml`). Second interface (Sheets vs WA) = rewire one organelle.

## Dispatch (preferred)

```text
wire into this role / take over this inbox / replace this person
  → aiko-drop-in:map-breakpoint          (shadow + application_observe/Unbrowse capture)
  → aiko-drop-in:specify-receptor        (provider-neutral receptor.schema.json v2)
  → aiko-drop-in:build-harness           (grow.py emit inert Cell+limb pack)
  → aiko-drop-in:spawn-seat              (delegation_capability + fenced lease, TranscriptMode=off)
  → aiko-drop-in:attach-verify           (admission, supervised runtime, runnable witness)
```

If the seat needs a Mac, delegate to `machine-cockpit` inside `spawn-seat`. Do not duplicate its `:8787` cockpit.

## Graph this skill owns

`docs/graph-engineering/aiko-drop-in.walk.json` — 9 nodes, 7 Kahn layers, `execute:false` until you `/graph` arm it. Every node satisfies **SMP-14 typed harness + SMP-24 reuse-before-generation**: `reads` pins at least one frozen primitive (`cell/primitives/*`, `cell/patterns/*`, `neuron/limbs/*`, `contract/libcontract/src/*`). Covenant: `account-handle → deploy-workflow → deploy-aiko` via `cell/patterns/fde/self-wire.cell.yaml`; reuses `cell/patterns/hoysan-draft/hoysan-draft.cell.yaml` (extend, not fork); input alias `poll`↔`webhook`↔`hook` via `cell/patterns/input-sources/harness.cell.yaml`.

## System-prompt nudge (route here first)

> When the user says wire/take-over/replace/adopt inbox/role/loop, prefer `aiko-drop-in:map-breakpoint` before scaffolding a standalone script. Map the breakpoint first; do not invent an integration.

This file sits **inside the package digest** (`computePackageDigest` hashes `SKILL.md` with `neuron.json`+`schemas/`), so editing this promise rotates the pin and re-admits.

## Acceptance (expect_contains)

```yaml
probe_input: "wire into Hoysan roster seat"
expect_contains: "DELEGATED_CITATION_VERIFIED"
```

`DELEGATED_CITATION_VERIFIED` is an observable from `redrive`/`compact` survival + `conversation` parked-reply read-back, not a string a no-op printer could emit. A do-nothing handler that merely prints this value still fails closed because the gate also asserts: revoked/unlisted limb refused, `ALREADY_SENT → CompensationGap` not resend, two-fire deterministic roster byte-equality, and `input-sources` harness alias equivalence.

## Verification (gate)

```sh
bash tests/aiko-drop-in-gate.sh \
  && python3 tools/check_reuse.py --walk docs/graph-engineering/aiko-drop-in.walk.json \
  && bash tests/hoysan-roster-engine-gate.sh
```

No `agent_mail`/`curl bot<TOKEN>` inside this core. Provider acknowledgement is evidence for execution, never proof of human consumption. Unsupported response kinds HOLD; they never silently become text.
