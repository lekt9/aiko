import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const isCsv = process.argv.includes("--csv");
const isAiko = process.argv.includes("--aiko");
const env = {
  ...process.env,
  UNLOCK_ROOT: root,
  BU_NAME: process.env.BU_NAME ?? (isAiko ? "aiko-app-qa" : "unlock-vault-qa"),
  BU_CDP_URL: process.env.BU_CDP_URL ?? "http://127.0.0.1:9337",
  BH_NO_BROWSER_COOKIES: "1",
  BH_RECORD: "0",
};
// Reset only this isolated QA daemon to avoid stale CDP sessions between runs.
const reset = spawnSync("browser-harness", ["--reload"], {
  env,
  stdio: "inherit",
  timeout: 20_000,
});
if (reset.status !== 0) process.exit(reset.status ?? 1);
const started = Date.now();
const result = spawnSync("browser-harness", [], {
  input: readFileSync(
    new URL(
      isAiko ? "./aiko_app_qa.py" : isCsv ? "./csv_qa.py" : "./vault_qa.py",
      import.meta.url,
    ),
    "utf8",
  ),
  env,
  stdio: ["pipe", "inherit", "inherit"],
  timeout: 240_000,
});
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);
const report = new URL(
  isAiko
    ? "../artifacts/aiko-production/browser/browser-results.json"
    : isCsv
      ? "../artifacts/csv-qa/browser-results.json"
      : "../artifacts/vault-qa/browser-results.json",
  import.meta.url,
);
const evidence = JSON.parse(readFileSync(report, "utf8"));
if (
  statSync(report).mtimeMs < started ||
  !evidence.checks.length ||
  evidence.checks.some((check) => !check.passed)
) {
  throw new Error("Browser suite did not produce a fresh passing report");
}
