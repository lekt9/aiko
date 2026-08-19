# Breakpoint catalog — human observe→decide→effect

Every row answers: **ingress bytes**, **auth boundary**, **decision rule**, **effect + idempotency key**, **muscle-memory**, **primitive that already covers it**.

| # | Breakpoint (human today) | Ingress →normalize | Auth (VerifiedIngress) | Decide (pinned policy bytes) | Effect + idempotency | Muscle-memory | Reuses |
|---|---|---|---|---|---|---|---|
| B1 | Preference ingest (20th-23rd) | WhatsApp + Google Form → off-day tuple | WA group + Form owner | record per worker/day | normalized tuple `namespace:hoysan-pref + worker + date + root` + digest | `X` in DAY/NIGHT/NTS sheet | `input-sources/poll\|webhook\|hook` alias, `unbrowse`, `confirm` |
| B2 | Monthly roster engine (29th final) | off-tuples + 5-day history | roster planner identity | locals-first → TS fill → NTS flexi → blue backup; **5-consecutive fence**; level 40/42 (contract 42 vs WA actual) | Cell `roster_digest` (deterministic double-fire) | DAY/NIGHT/NTS Excels, yellow/green/blue fills, `=SUM/=COUNTIF` | `hoysan-draft.cell.yaml` (extend, not fork) + `dashboard/render` + `confirm` |
| B3 | Evening leveling | phone/radio negotiation | foreman voice | even out daily totals | `roster_patch` with fence re-check | phone → sheet edits | `pipeline` stage + `energy-router` rank |
| B4 | Roster dissemination + 4pm amendments | WhatsApp 8 screenshots | WA sender | 1-to-1 change without rebroadcast | `CompensationGap` diff (only 4 who changed, not 31) | screenshots in WA | `redrive` case-3, `fanout` narrowed delegations |
| B5 | Paper master digitization | paper consecutive-days ledger | ground foreman | source-of-truth for B2 fence | digitized `streak_table` pinned digest | paper → DB | `cas` dedup + `context_projection` cited read |
| B6 | Pre-shift cascade 5:00→5:30→call→NTS | WA → 5:30 no-reply → call → replacement (blue→NTS) | foreman device | escalation ladder | `outbox→send→read-back` per recipient, terminate | WA → call | `telethon` limb + `outbox-drainer` + `conversation` SMP-33 |
| B7 | Ferry + visual headcount | eyes on unstaffed prime movers | foreman on-site | read-back = machine has no driver | `headcount_verified` evidence | truck → site | `outbox-drainer` read-back |
| B8 | Shift handover 8a/pm | outgoing brief | foreman handover | pass manpower delta | `context_projection` citation | verbal → Contract citations | `execution_control` fence |
| B9 | Shortfall → LD | PSA phone (<5a/pm $60 vs last-minute expensive) + weekly LD email | PSA verifier | `if informed<cutoff $60 else higher` | LD calc `= f(business doc read-back)` | LD email verification | `confirm` |

**Covenant (SMP-14 typed harness + SMP-24 reuse-before-generation):** composition parent `cell/patterns/fde/self-wire.cell.yaml` (`account-handle → deploy-workflow → deploy-aiko` = "Aiko seats Aiko"); roster engine `cell/patterns/hoysan-draft/hoysan-draft.cell.yaml` (reuse, do not fork); input alias `poll`↔`webhook`↔`hook` via `cell/patterns/input-sources/harness.cell.yaml` — one receptor, one alias, no provider branches.

**Honesty boundary:** B4-B9 with phantom “all 9 invented” witnesses are absent until `hoysan-pilot-*` gates pass. `synthetic-safe` means `hoysan-draft` refuses infeasible drafts and **retains nothing** — a real gate, not marketing.
