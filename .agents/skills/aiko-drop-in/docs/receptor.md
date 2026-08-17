# Receptor — one spec, three ingress aliases

**Spec:** `references/receptor.json` (`schema_version: 2`, `ingress` poll|local_listener|provider_webhook, `cursor` on `worker_id+date` + `payload_digest`).

**Harness:** `cell/patterns/input-sources/harness.cell.yaml` + `route.cell.yaml` — wiring chooses `poll` vs `webhook` vs `hook`; the parent `membrane.item` is identical. Same `level-roster` effect, same idempotency `namespace:hoysan-pref + worker + date + root`, same `ConfirmedGap` proof.

Hoysan B1: WhatsApp poll ↔ Form webhook ↔ paper hook → one normalized stream → `hoysan-draft` engine. Second tenant (Sheets vs Slack) = rewire one organelle.
