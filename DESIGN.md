# Hoysan — Design (Excel sheet is the home)

**Primary surface:** Frozen `S/N+NAME` col + 31 day-cols grid, `X` off-marks, fills per class (yellow locals `FFFFFF00` / green Sunday `FF00B050` / orange NTS `FF92D050`), sticky totals row (`=SUM(C89+C90-C88)` available manning + `=COUNTIF(...ABS/SBY/MC)` + ABS/SBY/MC), leveling indicator gap-to-40. Excel sheet muscle memory — not card KPIs.

**Grid:** 293×40 DAY / 95×40 NIGHT / 108×40 NTS — same dimensions as source `HOYSAN Roster *.xlsx`. Row height per 3-row S/N pattern preserved.

**Login:** PIN gate on roster mutations; read-only browse without PIN where documented.

**Secondary flows:** Pre-shift cascade board (5:00→5:30→call→blue→NTS ladder via fanout), LD panel (`$60` vs last-minute weekly email verification), paper-master `streak_table` view.

**Reuse:** `cell/patterns/dashboard/render.cell.yaml` for sheet render; `cell/patterns/hoysan-draft` for the deterministic engine; `neuron/limbs/telethon` ladder for chase.
