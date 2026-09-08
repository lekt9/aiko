// Deterministic journeys through the real UI and local native hosts. No personal browser or provider accounts.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = fileURLToPath(new URL("../", import.meta.url));
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
const out = join(root, "artifacts/aiko-ui-qa", runId);
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "aiko-ui-qa-"));
const children = new Set();
const startedAt = new Date().toISOString();
const checks = [];
const env = { ...process.env, UNLOCK_ROOT: root, AIKO_UI_QA_OUT: out, BH_NO_BROWSER_COOKIES: "1", BH_RECORD: "0", BU_NAME: `aiko-ui-qa-${process.pid}` };
// Never let an inherited personal CDP WebSocket override this run's fresh browser.
delete env.BU_CDP_WS;

function stop(child, signal = "SIGTERM") {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal); // Only the process group this runner created.
  } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

function start(command, args, label, extra = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extra }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", async (code) => {
      await writeFile(join(out, `${label}.log`), output);
      resolve(code);
    });
  });
  // A server can fail before the readiness probe observes it.
  done.catch(() => {});
  return { child, done, output: () => output };
}

async function run(command, args, label, extra = {}, input) {
  console.log(`Checking ${label}…`);
  await mkdir(join(out, label), { recursive: true });
  const job = start(command, args, label, { ...extra, AIKO_UI_QA_OUT: join(out, label) });
  job.child.stdin.end(input);
  let escalation;
  const timer = setTimeout(() => {
    stop(job.child);
    escalation = setTimeout(() => stop(job.child, "SIGKILL"), 3000);
  }, 300_000);
  try {
    const code = await job.done;
    checks.push({ check: label, passed: code === 0, exitCode: code });
    if (code !== 0) throw new Error(`${label} failed; see ${out}/${label}.log\n${job.output().slice(-2500)}`);
  } finally { clearTimeout(timer); clearTimeout(escalation); }
}

async function journey(label, extra, script) {
  try { await run("browser-harness", [], label, extra, await readFile(join(root, script), "utf8")); }
  catch (error) {
    // Independent synthetic journeys still run, but any failure keeps CI red.
    console.error(error);
    process.exitCode = 1;
  }
}

async function ready(url, job) {
  for (let i = 0; i < 240; i++) {
    if (job.child.exitCode !== null || job.child.signalCode) throw new Error(`Preview stopped: ${job.output().slice(-2000)}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview did not become ready at ${url}`);
}

async function browserBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const cache = join(homedir(), ".cache/ms-playwright");
  for (const name of await readdir(cache).catch(() => [])) {
    if (name.startsWith("chromium-")) candidates.push(join(cache, name, "chrome-linux64/chrome"));
  }
  for (const path of candidates) { try { await access(path); return path; } catch {} }
  throw new Error("Set CHROME_BIN to an installed Chrome/Chromium binary. The runner creates its own temporary profile.");
}

async function cleanup() {
  // browser-harness detaches its daemon; stop only this run's BU_NAME too.
  const daemon = start("browser-harness", ["--reload"], "browser-cleanup");
  daemon.child.stdin.end();
  const timer = setTimeout(() => stop(daemon.child, "SIGKILL"), 5000);
  try {
    const code = await daemon.done;
    checks.push({ check: "browser-cleanup", passed: code === 0, exitCode: code });
    if (code !== 0) process.exitCode = 1;
  } catch (error) {
    checks.push({ check: "browser-cleanup", passed: false, error: String(error) });
    process.exitCode = 1;
  } finally { clearTimeout(timer); }
  for (const child of children) stop(child);
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const child of children) stop(child, "SIGKILL");
  await rm(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });

try {
  const cdpPort = await port();
  env.BU_CDP_URL = `http://127.0.0.1:${cdpPort}`;
  // An explicit fresh profile is mandatory, including when the caller already has Chrome open.
  const chrome = start(await browserBinary(), ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(scratch, "chrome")}`, "about:blank"], "chromium");
  await ready(`${env.BU_CDP_URL}/json/version`, chrome);
  await run("browser-harness", ["--reload"], "browser-init");
  const ui = join(scratch, "ui");
  await run("pnpm", ["--filter", "@unlock/web", "exec", "vite", "build", "--config", "vite.connectors.config.ts", "--outDir", ui], "connector-build");
  const connectorPort = await port();
  const connector = start("pnpm", ["--filter", "@unlock/web", "exec", "vite", "preview", "--config", "vite.connectors.config.ts", "--outDir", ui, "--host", "127.0.0.1", "--port", String(connectorPort), "--strictPort"], "connector-preview");
  const connectorUrl = `http://127.0.0.1:${connectorPort}`;
  await ready(`${connectorUrl}/connect.html`, connector);
  await journey("native-login", { CONNECTOR_PREVIEW_URL: connectorUrl }, "apps/web/test/native-login-progress.browser.py");
  const dbPort = await port();
  const database = start("bun", ["--no-env-file", "apps/agent/scripts/database-preview.ts"], "database-preview", { DATABASE_PREVIEW_UI_DIR: ui, DATABASE_PREVIEW_PORT: String(dbPort) });
  const databaseUrl = `http://127.0.0.1:${dbPort}`;
  await ready(`${databaseUrl}/connect`, database);
  await journey("database", { DATABASE_PREVIEW_URL: databaseUrl }, "apps/web/test/database-artifact.browser.py");
  const secretaryPort = await port();
  const secretary = start("bun", ["--no-env-file", "apps/agent/scripts/secretary-work-preview.ts"], "secretary-preview", { SECRETARY_PREVIEW_PORT: String(secretaryPort) });
  const secretaryUrl = `http://127.0.0.1:${secretaryPort}`;
  await ready(secretaryUrl, secretary);
  await journey("secretary-work", { SECRETARY_PREVIEW_URL: secretaryUrl }, "apps/web/test/secretary-work.browser.py");
  const recoveryPort = await port();
  const recovery = start("bun", ["--no-env-file", "apps/web/test/ui-recovery.preview.ts"], "ui-recovery-preview", { UI_RECOVERY_PORT: String(recoveryPort), UI_RECOVERY_BUILD_DIR: join(scratch, "recovery") });
  const recoveryUrl = `http://127.0.0.1:${recoveryPort}`;
  await ready(recoveryUrl, recovery);
  await journey("ui-recovery", { UI_RECOVERY_BASE_URL: recoveryUrl }, "apps/web/test/ui-recovery.browser.py");
  console.log(`${process.exitCode ? "One or more journeys failed" : "All core journeys passed"}. Evidence: ${out}`);
} catch (error) {
  checks.push({ check: "journey runner", passed: false, error: String(error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
  await writeFile(join(out, "browser-results.json"), JSON.stringify({ runId, scope: "isolated synthetic UI and local native hosts", startedAt, completedAt: new Date().toISOString(), checks }, null, 2) + "\n");
}
