# Hoysan — Design (Excel sheet is the home)

Primary surface `/` = roster grid: frozen worker col + 31 day cols, `X` marks, fills per class, sticky totals row (`=SUM/=COUNTIF`), leveling indicator (gap to 40). Secondary flows: pre-shift cascade board (5:00→5:30→call→NTS), LD calc panel (pre-cutoff $60 vs last-minute).

Reuse: `cell/patterns/dashboard/render.cell.yaml` for sheet render; `cell/patterns/hoysan-draft` for deterministic engine; `neuron/limbs/telethon` ladder for chase.
