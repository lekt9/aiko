# Guarded Aiko Cloudflare cutover

The cutover command is an operator tool, not an actor tool. It preserves the native `aiko@demo` identity, one foreground thread per owner, hidden actor histories, and complete authoritative entity-learn journals. Import does not run old turns or arm execution. Browser work continues in owner-isolated persistent Codegraff VMs; this command does not migrate browser profiles or provision VMs.

This installation completed the handoff on 2026-09-06 at 06:48:51 UTC. All three source accounts passed readback verification; Telegram uses `https://aiko-agent.lewis-6d8.workers.dev/telegram/webhook`, and `unlock-aiko.service` is inactive and disabled. The private success witness is `artifacts/aiko-cloudflare/migration.json`; backups, native exports and progress receipts are retained under `/home/deck/.local/share/unbrowse/aiko/cloudflare-cutover-20260906/`. The steps below document the completed workflow and its recovery rules, not an instruction to repeat it. Real Telegram media acceptance remains a separate open gate.

## Review and preflight

Run from the repository with Bun 1.4 or later:

```sh
bun scripts/cutover-aiko-cloudflare.ts --run-dir /absolute/new-private-cutover-run
```

This default only reads configuration, witness files, native identity, service status, readiness and Telegram identity. The authenticated nonce challenge is also read-only: it proves that the deployed Worker uses the same bot token and webhook secret without disclosing either. No service is stopped, file is exported, update is acknowledged or webhook is changed. The run directory must not already exist and must be outside the original state directory.

The command reads the existing local configuration through `loadConfig(..., {readonly:true})` and the private `/home/deck/.config/unbrowse/aiko-cloudflare.env`. It requires fresh private witnesses in `artifacts/aiko-cloudflare/`: `live.json` with a passed native search/browser run, and verified `speech.json` and `video.json`. Missing, failed, stale, malformed or wrong-origin witnesses block before stopping the service. Both local polling readiness and Cloudflare readiness must agree with the intended handoff.

Only after reviewing those checks and the source/target deployment, add `--execute` to the same command. This flag authorizes real changes to `unlock-aiko.service`, the target accounts and Telegram. Do not run concurrent cutovers or write to target migration accounts through another client during the handoff.

## Execution and evidence

The command performs this ordered handoff:

1. Stop `unlock-aiko.service`; verify that it is inactive.
2. Use the existing offline `backupState` helper to create `run-dir/pre-cloudflare-backup`. Retain the original source in place.
3. Acquire the production host coordination lock and hold it through the handoff. Export all histories and native memory archives to `run-dir/native-export`. Every data store is read-only; only the coordination lock handle is write-capable, with no committed data changes. SQLite may create empty WAL/SHM coordination sidecars.
4. Require the exact polling cursor file whose name is derived from the configured bot-token ID. Refuse a pending inbox, ambiguous/mismatched cursor, non-settled history, mixed ownership, conflicting stores, credential-shaped retained data, or an account exceeding the 8,000,000-byte import limit.
5. Import each owner through the operator-only no-drive route. Read back complete native threads and memory through the operator export route. Verify identity, ordered event hashes/counts, complete archive hashes and native memory roots. Every owner must match before proceeding.
6. Recheck readiness, deployed credential attestation, the stopped local service and the still-empty Telegram webhook.
7. Call `getUpdates` exactly once with `offset` equal to the exported cursor and `timeout:0`. Returned newer updates stay pending: the command never advances to their highest ID or stores their bodies.
8. Set the Cloudflare webhook with the configured secret, canonical `TELEGRAM_ALLOWED_UPDATES` and `drop_pending_updates:false`. Verify the URL and allowed updates, then disable the old unit so it cannot start another poller on reboot.

Private `run-dir/migration.json` records progress before every potentially ambiguous external mutation. It includes attempted/imported owner IDs, exact hashes and whether readback was verified. It never contains bot credentials, raw memory, event bodies or pending update bodies. Only a fully verified handoff creates `artifacts/aiko-cloudflare/migration.json` with `verified:true` and `completedAt`; an existing success artifact is never overwritten. Export files and backups contain retained private history, including forgotten material, and must not be uploaded as chat attachments or served publicly.

## Partial failure and recovery

| Last stage | Safe interpretation and recovery |
| --- | --- |
| Before service stop | Source remains untouched. Repair the failed witness/configuration/readiness gate and rerun preflight. |
| Backup, export, import or readback failed before webhook change | Original local state remains authoritative. The command checks that Telegram still has no webhook, releases its source lock, and restarts the local unit only if it was originally active. Keep the private progress receipt: even an `attempted` target import may have committed. |
| Cursor acknowledged, webhook not yet attempted | The acknowledged offset is already the persisted local cursor. Newer returned updates were not acknowledged. The same verified-empty-webhook fallback remains safe. |
| Webhook request attempted, response lost or verification failed | Outcome is uncertain. The command does not retry the mutation or restart polling. Inspect `getWebhookInfo` and the progress receipt first. If Cloudflare owns delivery, keep the local service stopped and ensure its unit is disabled. |
| Webhook verified, old-unit disable failed | Cloudflare may already be receiving updates. Keep local polling stopped, finish disabling the unit, and review the run receipt before publishing a final success artifact. |

Never delete populated Durable Objects as automatic cleanup. Exact archive/id retries are safe only while the source history remains unchanged. Once local fallback has resumed and accepted new work, previously imported target accounts can be stale: reconcile delta history through a separately reviewed migration or choose an explicitly reviewed fresh deployment. A rollback after Cloudflare has received new work must preserve that new history and Telegram's pending updates; merely restarting the old poller is not a rollback.

This command does not send a Telegram test message. Live Telegram media acceptance and the final production contract require the separate verified test-chat run. Model cost and latency comparison are outside this migration command's measurement boundary.
