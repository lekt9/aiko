# Drop-In protocol — shadow → specify → build → spawn → operate

```
map-breakpoint → specify-receptor → build-harness → spawn-seat → attach-verify
     │                │                  │               │              │
  observe          harness           fde/self-wire   delegation     admit→attach
  +Unbrowse        alias            + grow.py        + fenced      + supervised
  + WA/Sheets      poll↔hook                           lease         + runnable witness
```

1. **Shadow the human** — `application_observe` on their real inbox/Sheets/Excel + `Unbrowse` route capture. No invented ingress bytes.
2. **Specify one receptor** — `ingress/cursor + events[] + effects[]` with `requires_authority/ttl/evidence/variants`. Same spec validates under `poll` **xor** `webhook` **xor** `hook` — wiring change, not core branch.
3. **Build inert harness** — compose `cell/patterns/fde/self-wire.cell.yaml` (`account-handle → deploy-workflow → deploy-aiko`) via `grow.py`. Stage `→` admit `→` activate by digest; never file-copy.
4. **Spawn capability-bounded child** — `inheritEnv=false` + `SpawnAuthorityPolicy` + `execution_control` fenced lease. Child shares root, distinct execution/occurrence; transcript/`HOME`/`API_KEY` **never** copied. Prove `reply/<correlation>` without `allow_send` (`conversation` SMP-33) and citation survival across `compact` (`cross_journal_retention`).
5. **Attach & prove** — admitted digest only. Runnable gate asserts: `namespace+key+root+digest=replay` vs `same key+changed bytes=conflict`, revoked/unlisted limb refused, `ALREADY_SENT → CompensationGap` (compensation, not resend), `confirm` diff, `dashboard` Excel parity, deterministic two-fire, `input-sources` alias.

Every node must list **≥1 reads** under `cell/primitives|patterns`, `neuron/limbs`, or `contract/libcontract` — enforced by `tools/check_reuse.py --walk`.

**Covenant (SMP-14 + SMP-24):** composition parent `cell/patterns/fde/self-wire.cell.yaml` (`account-handle → deploy-workflow → deploy-aiko`); roster engine `cell/patterns/hoysan-draft/hoysan-draft.cell.yaml` reused (extend, not fork); input alias `poll`↔`webhook`↔`hook` via `cell/patterns/input-sources/harness.cell.yaml` — same receptor proves alias, no provider branches.

If a Mac seat is needed, delegate to `machine-cockpit` inside `spawn-seat`. Do not reimplement `:8787`.
