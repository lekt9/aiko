# Photon / positron → runtime — waves, daemon, preempt

> Companion to [`PHOTON-POSITRON-CONTRACT-EBM.md`](PHOTON-POSITRON-CONTRACT-EBM.md)
> (structure), [`PHOTON-POSITRON-GAPS.md`](PHOTON-POSITRON-GAPS.md) (depth holes),
> and [`PHOTON-POSITRON-FIRST-PRINCIPLES.md`](PHOTON-POSITRON-FIRST-PRINCIPLES.md)
> (laws § drive / fractal / preempt). Product plan: Aiko `plan3.md`.
>
> **Doctrine in one line:** the ledger is the field; the daemon is a killable
> apparatus; Contract does not *become* a `while` by pointing at itself.

---

## 1. Three different “loops” (do not confuse them)

| Loop | Lives in | Legal? |
|------|----------|--------|
| **Graph expand** (pointer → child → …) | `muscle.schedule`, parent_id, `contract:` refs | Yes if **DAG**, cycle/depth/fan-out capped |
| **Time re-entry** (same id, new occurrence) | `scheduler`: `repeat:`, `at:`, `when:contract:`, release+retry | Yes — this is “loop again” |
| **Process while** (host tick) | `contract tick --every`, Aiko worker limb | Yes — **must** exist; not the ledger |

**Illegal:** expand A → A as a substitute for a process. That is cycle expand /
circular self-confirmation. Rejected by design.

---

## 2. End resolution (pointer chain)

```text
root pointer
  → muscle.schedule → topological waves
  → ready set (optionally energy-ranked)
  → reflex: fire | prepare | hold
  → gate: allow | confirm | deny
  → host executes
  → record_iteration | terminal | execution_released
  → parent settles only when children grounded
```

- **Self-resolve cache:** truth keyed by pointer value; change ⇒ re-derive
  (`cache.zig`, ledger-backed — not RAM-only).
- **Parent feedback:** + only if all children success; unknown → neutral; fail → inhibit.
- **HOLD:** non-terminal; blocker is a child or release, not a fourth terminal.

Physics: finite Feynman diagram, not infinite self-energy without cutoff.

---

## 3. Daemon = clock hand (not antipattern)

### Statelessness means authority, not “no process”

| Put here | Not here |
|----------|----------|
| Ledger rows, leases, terminals, folds | Process RAM as truth |
| Reconstructible recommend | “I remember” only in the daemon |
| Signed lineage | Unlogged side effects |

### Good daemon

```text
while true:
  batch = tick/claim(ledger, now)   # pure of durable state
  for claim in batch: run worker; settle
  sleep(batch.next_wake or poll)
```

Kill it → restart → truth intact if rows were written.

### Bad daemon

Secret queues, learning only in RAM, immortal ownership of jobs, required
process affinity with no lease recovery.

### What already exists

| Surface | Path |
|---------|------|
| Contract one-shot tick | `contract tick` → `resolverTick` |
| Contract resident | `contract tick --every <seconds>` |
| ABI | `contract_tick_json` / settle / renew |
| Aiko claims | `contract_native::tick_due_contracts` |
| Aiko worker loop | `run_contract_worker` (pager-bin) — claim → `--single` → settle |

Plan 3 packages the **good** daemon as product default; kernel pieces are
largely **BUILT**.

---

## 4. Preempt (ledger-first)

| Intent | Mechanism |
|--------|-----------|
| Worker dead | Lease expiry → re-claim |
| Soft yield | `execution_released` + `retry_after_unix` |
| Authority change | Agency supersede / revoke |
| Poison subtree | Failure invalidation same resolver tick |
| Don’t fire | `reflex.hold` / `prepare` |
| Hard stop | `gate` deny |
| Session cancel | Host releases lease (+ optional supersede); not “edit a half terminal” |

Energy chooses **who gets the next lease**; it does not OS-preempt mid-syscall
as Contract law.

---

## 5. Self-continuation recipe

Want a “while” in Contract? Encode **time**, not **cycles**:

```text
declare job with repeat:60s  (or settle → when:contract: next)
  → resident ticks
  → claim under lease
  → worker runs postcondition check
  → settle satisfied | release retry
  → next occurrence appears when due
```

That is tail recursion of **work**, not recursion of the **pointer graph**.

---

## 6. Closed-loop step (one function, many hosts)

Shared shape (`resolverTick` / ABI tick):

1. Compact if store oversized (homeostasis).
2. Warm semantic route cache (optional strides).
3. Materialize due triggers.
4. Backfill / resolve budgeted frontier.
5. (Aiko path) claim leases for execution host.
6. (Aiko path) settle after external evidence.

CLI, resident, LaunchAgent worker, MCP adapter — same step, different wake source.

---

## 7. Gaps this runtime layer still owns

See also [`PHOTON-POSITRON-GAPS.md`](PHOTON-POSITRON-GAPS.md) priorities 1 & 5.

| Hole | Status |
|------|--------|
| Always-on product default without chat | Plan 3 Phase 2 |
| Energy-ranked claim order + fairness | Plan 3 Phase 3 / gap B |
| All limbs share claim/settle | Plan 3 Phase 4 |
| Sleep until `next_wake` (not busy poll) | Plan 3 Phase 5 |
| Live multi-host lease contention proof | OPEN |

---

## 8. Standing rules

1. Daemon may run forever; it must not *own* forever.
2. Prefer new occurrence over cycle edge.
3. Prefer lease recovery over sticky PID affinity.
4. Prefer one closed-loop step shared by all hosts.
5. Market “always-on” only with “killable + ledger reconstructible.”

---

*Apparatus and field stay distinct — that is the whole runtime doctrine.*
