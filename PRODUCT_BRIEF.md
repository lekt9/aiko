# Hoysan Drop-In — Product Brief

**Domain:** PSA Port Authority prime-mover deployment — 40/shift actual (contract 42), two shifts 07:00/19:00, 51 DAY + 15 NIGHT + 32 NTS workers, 5-consecutive-day fence, blue flaky backup pool, paper master = fence ground truth, 16-shift headcount quota. Source bytes: `HOYSAN Roster Aug 26.xlsx` / `Sep 26.xlsx` (DAY 293×40, NIGHT 95×40, NTS 108×40), `prompt.md.rtf` (PSA 40/shift, NTS/TS/Locals 3-class, 20th-23rd preference ingest, 29th leveling, leveling to 40 vs 42 contracted-vs-WA actual, pre-shift WA cascade 5:00→5:30→call→NTS, LD $60 informed vs last-minute), workflow PDFs, roster photos.

**Muscle-memory:** Excel sheet is the home — frozen panes, day 1-31 cols, `X` = off-day, yellow locals `FFFFFF00` / green Sunday `FF00B050` / orange NTS `FF92D050`, totals `=SUM(C89+C90-C88)` + `=COUNTIF(ABS/SBY/MC)`. Primary surface must look like that sheet, not card KPIs.

**Workflow (trigger→test→breakpoints→chat):** WA poll / Sheets webhook / Excel hook (one `input-sources/harness` alias) → normalize off-day tuples (`namespace:hoysan-pref+worker+date+root`) → deterministic roster engine (`cell/patterns/hoysan-draft/hoysan-draft.cell.yaml` extend via `hoysan_draft.py`, not fork; `confirm.cell` for grounded prefs, `dashboard` render for sheet parity, `energy-router` eligibility→rank) → outbox→send→independent read-back per recipient → escalation ladder (5:00 WA → 5:30 no-reply → call → blue→NTS via `fanout` narrowed + `telethon` + `outbox-drainer`).

**Breakpoints (9, B1-B9):** preference ingest, roster engine, evening leveling, dissemination+4pm, paper digitization, pre-shift cascade, ferry headcount, shift handover, shortfall→LD ($60 vs last-minute, weekly LD email). See `HOYSAN-BREAKPOINT-INVENTORY.md` + `breakpoint-catalog.md`; each answers ingress bytes / auth boundary (`VerifiedIngress`) / decision rule / effect+idempotency / primitive reuse.

**Login:** staff PIN login + server-auth guard on all mutating routes; open-internal without PIN explicitly documented as Designed-to-Absent gap.

**CRUD:** Full C/R/U/D on workers, roster, roster-cells, shifts, LD ledger — not seed-only. Eligibility before ranking (5-day fence, 2-week night ban, NTS dormitory, 16-shift quota + headcount gates rank).

**Non-goals:** Live PSA / Sheets / WA provider tokens; managed enterprise credential vault; SAP — remain outside the claim boundary per the `docs/AI-FORWARD-DEPLOYED-ENGINEER.md` honest wall (live provider surfaces are Designed; the SAP adapter and enterprise vault are Absent).
