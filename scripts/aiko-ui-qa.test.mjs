import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
test("failed UI startup cannot leave a passing/stale report and cleans only its namespace", { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ["scripts/aiko-ui-qa.mjs"], {
    cwd: root,
    env: { ...process.env, CHROME_BIN: "/nonexistent-unlock-fixture-chrome", BU_NAME: "must-not-use-caller-namespace", BU_CDP_WS: "ws://must-not-use-caller-browser.invalid" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 1, output);
  const directory = join(root, "artifacts/aiko-ui-qa");
  const runs = (await readdir(directory)).filter(name => name.endsWith(`-${child.pid}`));
  assert.equal(runs.length, 1, "each attempted run needs its own evidence directory");
  const report = JSON.parse(await readFile(join(directory, runs[0], "browser-results.json"), "utf8"));
  assert.equal(report.runId, runs[0]);
  assert.equal(report.checks.find(check => check.check === "journey runner")?.passed, false);
  assert.equal(report.checks.find(check => check.check === "browser-cleanup")?.passed, true);
  assert.equal(report.checks.some(check => ["native-login", "database", "secretary-work", "ui-recovery"].includes(check.check)), false);
});
