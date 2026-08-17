# Hoysan Breakpoint Inventory — loss-less

Source: `/Users/lewis/Downloads/hoysan` — `prompt.md.rtf` (55k transcript), `HOYSAN Roster Aug 26.xlsx` / `Sep 26.xlsx` (DAY 293×40, NIGHT 95×40, NTS 108×40), `Requirements Gathering PM.pdf` (11p), roster photos (2026-08-12).

## Contract & roster shape

* PSA Port Authority: **40** drivers/shift via WhatsApp instruction (contract says 42). Two shifts: 07:00 day, 19:00 night.
* Worker classes: **NTS** (Indian, dorm-near-port, cheapest, no roster say, last-minute flexible), **TS** (Malaysian, roster-following), **Locals** (princesses, highest pay, submit off-day preferences, must hit **16 shifts/mo** for headcount quota → allows more foreign hires), **blue** = flaky backup pool.
* Roster Excell: `X`=off-day, yellow `FFFFFF00`=locals, green `FF00B050`=Sunday col, orange `FF92D050`=NTS; totals `=SUM(C89+C90-C88)` available manning, `=COUNTIF(..."ABS"/"SBY"/"MC")`; counts 51 DAY + 15 NIGHT + 32 NTS.
* Hard fence: **5-consecutive-day** work limit → must rest. Night-shift ban first 2 weeks for new workers. NTS dormitory proximity, 16-shift quota eligibility gates ranking.

## Breakpoints (observe → decide → effect + idempotency + primitive)

| # | Breakpoint (human today) | Ingress bytes | Auth boundary | Decision (pinned policy) | Effect + idempotency key | Muscle-memory | Already-gated primitive that covers it |
|---|---|---|---|---|---|---|---|
| B1 | **Preference ingest** 20th-23rd | WhatsApp screenshots + Google Form JSON → off-day tuples | WA group + Form owner (VerifiedIngress) | record per (worker, date) | tuple `namespace:hoysan-pref + worker + date + root` + SHA256 digest | `X` in DAY/NIGHT/NTS sheet | `cell/patterns/input-sources/{poll,webhook,hook}` alias + `neuron/limbs/unbrowse` (route capture → replay) + `cell/patterns/confirm` |
| B2 | **Monthly roster engine** (29th final) | off-tuples + 5-day streak history | roster planner identity | locals-first → TS fill → NTS flexi → blue backup; level to 40/42 (contracted vs WA actual); 5-consecutive fence; 16-shift quota | Cell digest `roster_digest` — deterministic double-fire | DAY/NIGHT/NTS Excels, yellow/green/orange fills, `=SUM/=COUNTIF` | **`cell/patterns/hoysan-draft/hoysan-draft.cell.yaml`** — synthetic-safe deterministic engine, infeasible→refuse→retain nothing (extend schema, do not fork) + `cell/patterns/dashboard` render membrane + `cell/patterns/confirm` |
| B3 | **Evening leveling** | phone/radio negotiation | foreman voice | even out daily totals to 40 | `roster_patch` + fence re-check | phone → sheet edits | `neuron/limbs/pipeline` stage + `neuron/limbs/energy-router` eligibility→rank |
| B4 | **Dissemination + 4pm amendments** | 8 WhatsApp screenshots | WA sender | 1-to-1 change without rebroadcast; displaced worker flexibility check | `CompensationGap` diff (only 4 who changed, not 31) | screenshots in WA | `neuron/src/redrive.zig` case-3 `ALREADY_SENT` + `neuron/limbs/fanout` |
| B5 | **Paper master digitization** | paper consecutive-days ledger | ground foreman | source-of-truth for B2 fence | `streak_table` pinned digest via CAS dedup | paper → DB | `cell/primitives/cas` + `contract/libcontract/src/context_projection.zig` cited read |
| B6 | **Pre-shift cascade** 5:00 WA → 5:30 no-reply → call → blue→NTS replacement | WA delivery receipts → call outcome | foreman device | escalation ladder (terminate, confirmed never messaged again) | `outbox→send→independent read-back` per recipient | WA → call | `neuron/limbs/telethon` + `neuron/limbs/outbox-drainer` + `neuron/limbs/conversation` (SMP-33 reply without allow_send) + `neuron/tests/escalation-ladder-gate.sh` |
| B7 | **Ferry + headcount** | eyes on unstaffed prime movers | foreman on-site | visual read-back = empty machine | `headcount_verified` evidence | truck → site | `neuron/limbs/outbox-drainer` read-back + `cell/patterns/confirm` |
| B8 | **Shift handover** 08:00/20:00 | outgoing verbal brief | foreman handover | pass manpower delta | `context_projection` citation | verbal → Contract citations | `contract/libcontract/src/execution_control.zig` fenced lease |
| B9 | **Shortfall → LD** | PSA phone (<05:00 $60 vs last-minute expensive) + weekly LD email | PSA verifier | `if informed<cutoff $60 else higher` | LD calc `f(business doc read-back)` verified vs weekly email | LD email | `cell/patterns/confirm` |

## Reuse claim (SMP-24)

* **hoysan-draft** is not a proposal to build — it already exists and is gated via `cell/run.py build cell/patterns/hoysan-draft/hoysan-draft.cell.yaml` and `hoysan-synthetic-correctness-gate.sh`. B2 extends its request schema.
* **telethon** + **unbrowse** + **energy-router** + **fanout** + **outbox-drainer** + **conversation** are admitted limbs with `conformance.py` gates — B1/B3/B4/B6 compose them.
* **input-sources harness** makes poll/webhook/hook one harness alias — second interface (Sheets vs WhatsApp) is one organelle rewire, not a provider branch.

## Muscle-memory (product brief pointer)

Primary surface is the **Excel itself**: frozen panes, day 1-31 columns, `X` marks, fills, COUNTIF/SUM totals — not a SaaS card wall. See `PRODUCT_BRIEF-hoysan.md` + `DESIGN-hoysan.md` and `docs/graph-engineering/AIKO-DROP-IN-PRIMITIVE-MAP.md` for reuse map.

*Inventory version: hoysan/1 — 2026-08-17. Witness: `tests/hoysan-inventory-gate.sh` (breakpoint + 5-consecutive + PSA + hoysan-draft + PRODUCT_BRIEF-hoysan.md).*
