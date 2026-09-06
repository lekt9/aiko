#!/usr/bin/env bun
import { exportAikoCloudflare, MigrationExportError } from "../apps/agent/src/migration-export.ts";

const usage = "bun scripts/export-aiko-cloudflare.ts --state-dir /absolute/offline-state --out /absolute/new-private-export --source-offline";
const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
  console.log(usage);
  console.log("Requires the local host and Telegram poller to be stopped by the operator. Does not stop services, run actors, call networks, or print private history. The output contains sensitive retained memory and must stay private.");
} else {
  try {
    const values = new Map<string, string | true>();
    while (args.length) {
      const flag = args.shift()!;
      if (!["--state-dir", "--out", "--source-offline"].includes(flag) || values.has(flag))
        throw new MigrationExportError("invalid-arguments");
      if (flag === "--source-offline") values.set(flag, true);
      else {
        const value = args.shift();
        if (!value || value.startsWith("--")) throw new MigrationExportError("invalid-arguments");
        values.set(flag, value);
      }
    }
    if (typeof values.get("--state-dir") !== "string" || typeof values.get("--out") !== "string")
      throw new MigrationExportError("invalid-arguments");
    const inventory = exportAikoCloudflare({ stateDir: values.get("--state-dir") as string,
      outputDir: values.get("--out") as string, sourceOffline: values.get("--source-offline") === true });
    console.log(JSON.stringify({ status: "exported", actor: inventory.actor, instance: inventory.instance,
      accounts: inventory.accounts.length, threads: inventory.accounts.reduce((sum, account) => sum + account.threads.length, 0),
      events: inventory.accounts.reduce((sum, account) => sum + account.threads.reduce((n, thread) => n + thread.events, 0), 0),
      memoryJournalRows: inventory.accounts.reduce((sum, account) => sum + account.memory.journalRows, 0),
      telegramCursorsRequiringHandoff: inventory.telegram.length,
      inventory: `${values.get("--out")}/inventory.json`, noDrive: true }));
  } catch (error) {
    console.error(JSON.stringify({ status: "refused", error: error instanceof MigrationExportError ? error.code : "export-failed" }));
    process.exitCode = 1;
  }
}
