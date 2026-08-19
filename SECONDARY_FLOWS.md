# Secondary flows — Hoysan Drop-In

- **Pre-shift cascade (5:00 WA blast → 5:30 no-reply sweep → call → pull BLUE → pull NTS → report PSA):** escalation ladder via `telethon` + `outbox-drainer` + `fanout` narrowed delegations; each rung is a typed `outbox → send → read-back` with `ALREADY_SENT → CompensationGap`. Drafts are paste-ready WhatsApp/call text.
- **LD panel:** `$60` early vs last-minute tier, weekly PSA settlement (`weeklySettlement`); LD read-back via `confirm` diff against the weekly email.
- **Paper-master digitization:** `streak_table` pinned via CAS dedup and cited read for the 5-day fence ground truth.
- **Shift handover (08:00/20:00):** `context_projection` citation carries the manpower delta.
- **Ferry headcount:** `outbox-drainer` read-back — unstaffed prime mover = `headcount_verified`.
