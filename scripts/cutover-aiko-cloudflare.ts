#!/usr/bin/env bun
import { cloudflareState } from "./cloudflare-paths.ts";
import { resolve } from "node:path";
import { loadConfig, privateEnv } from "../apps/agent/src/config.ts";
import { cutoverAikoCloudflare, CutoverError } from "../apps/agent/src/cloudflare-cutover.ts";

const usage = "bun scripts/cutover-aiko-cloudflare.ts --run-dir /absolute/new-private-run [--execute]";
if (import.meta.main) {
  process.umask(0o077);
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
      console.log(usage);
      console.log("Default: read-only readiness/witness/identity checks. --execute stops unlock-aiko.service, backs up and verifies all native imports, switches Telegram without dropping pending updates, then disables the old unit. No automatic target cleanup; retain run-dir/migration.json for partial-failure recovery.");
    } else {
      let execute = false, runDir: string | undefined;
      while (args.length) {
        const flag = args.shift();
        if (flag === "--execute" && !execute) execute = true;
        else if (flag === "--run-dir" && !runDir) runDir = args.shift();
        else throw new CutoverError("invalid-arguments");
      }
      if (!runDir || runDir.startsWith("--")) throw new CutoverError("run-directory-required");
      const config = await loadConfig(process.env, { readonly: true });
      const cloudflare = await cloudflareState();
      const evidence = await cutoverAikoCloudflare({ config, cloudflare, runDir,
        artifactDir: resolve(import.meta.dir, "../artifacts/aiko-cloudflare"), execute });
      console.log(JSON.stringify({ status: evidence.stage, dryRun: evidence.dryRun, verified: evidence.verified,
        accounts: evidence.sourceAccounts.length, importedAccounts: evidence.accounts.length,
        ...(execute ? { evidence: `${runDir}/migration.json` } : { execution: "not_started" }) }));
    }
  } catch (error) {
    console.error(JSON.stringify({ status: "refused", error: error instanceof CutoverError ? error.code : "cutover-preflight-failed",
      ...(error instanceof CutoverError && error.progress ? { progress: error.progress } : {}) }));
    process.exitCode = 1;
  }
}
