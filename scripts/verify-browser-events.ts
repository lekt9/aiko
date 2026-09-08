/** Contract runner. Focused checks are development evidence; only --full can
 * satisfy the browser-events contract. Missing end-to-end checks fail closed. */
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const full = process.argv.includes("--full");
if (process.argv.slice(2).some(arg => arg !== "--full")) throw Error("Usage: bun scripts/verify-browser-events.ts [--full]");
process.umask(0o077);
const startedAt = Date.now();
const directory = resolve(root, `artifacts/browser-events/check-${startedAt}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const focused = [
  "browser-events", "browser-events-host", "browser-watch-authority",
  "browser-watch-driver", "browser-watch-runner", "browser-watch-assembly", "browser-watch-connector-authority", "browser-watch-policy", "browser-watch-config", "browser-watch-config-host",
  "browser-watches", "browser-watch-actions", "browser-watch-actor-actions", "browser-watch-webhook-actions", "browser-watch-webhook-assembly",
  "webhook-adapter", "harness-revisions", "harness-library-api", "harness-recovery", "channel-wiring", "channel-log-source-host", "browser-watch-source-renewal",
  "sandbox-job", "sandbox-dispatch", "webhook-sandbox-dispatch", "harness-observed-network", "harness-library", "observed-network", "browser-learning",
].map(name => `apps/agent/test/${name}.test.ts`);
type Check = { name: string; command: string[]; files?: string[]; timeoutMs: number };
const checks: Check[] = [
  { name: "focused", command: ["bun", "test", ...focused], files: focused, timeoutMs: 300_000 },
  { name: "private-transport", command: ["bun", "test", "apps/agent/test/codegraff.test.ts", "apps/agent/test/browser-watch-provider-probe.test.ts"],
    files: ["apps/agent/test/codegraff.test.ts", "apps/agent/test/browser-watch-provider-probe.test.ts"], timeoutMs: 180_000 },
  { name: "collector", command: ["bun", "test", "apps/agent/test/cdp-background-listener.test.ts"],
    files: ["apps/agent/test/cdp-background-listener.test.ts"], timeoutMs: 60_000 },
  { name: "idle-lifetime", command: ["bun", "test", "apps/agent/test/browser.test.ts", "-t", "idle retirement"], timeoutMs: 60_000 },
  { name: "registry-watch-policy", command: ["bun", "test", "apps/agent/test/registry-defaults.test.ts", "-t", "watch mapper"], timeoutMs: 60_000 },
  { name: "native-watch-delivery-fence", command: ["bun", "test", "apps/agent/test/cloudflare-host.test.ts", "-t", "Router delivery checks current authority"], timeoutMs: 60_000 },
  { name: "native-watch-storage-authority", command: ["bun", "scripts/verify-browser-watch-kv.ts"], files: ["scripts/verify-browser-watch-kv.ts"], timeoutMs: 180_000 },
  { name: "agent-types", command: ["pnpm", "--filter", "@unlock/agent", "typecheck"], timeoutMs: 180_000 },
  { name: "product-contracts", command: ["pnpm", "exec", "vitest", "run", "apps/web/test/browser-watches.test.ts", "apps/web/test/browser-watch-renewal.test.ts", "apps/web/test/saved-tools.test.ts", "apps/web/test/saved-tools-proxy.test.ts", "--maxWorkers=2"],
    files: ["apps/web/test/browser-watches.test.ts", "apps/web/test/browser-watch-renewal.test.ts", "apps/web/test/saved-tools.test.ts", "apps/web/test/saved-tools-proxy.test.ts"], timeoutMs: 120_000 },
];
if (full) checks.push(
  { name: "workspace-types", command: ["pnpm", "typecheck"], timeoutMs: 600_000 },
  { name: "agent-suite", command: ["pnpm", "test:aiko"], timeoutMs: 1_800_000 },
  { name: "hosted-build", command: ["pnpm", "aiko:cloud:build"], timeoutMs: 300_000 },
  { name: "local-workerd", command: ["pnpm", "aiko:cloud:verify"], timeoutMs: 300_000 },
  // These witnesses must exercise actual production bindings, genuine subscribed
  // push with the site tab closed, native CLI/restart, custody lifecycle, and the
  // complete human journey. Do not substitute the fixture tests above or a skip.
  { name: "production-browser-journey", command: ["bun", "scripts/verify-browser-events-live.ts"], files: ["scripts/verify-browser-events-live.ts"], timeoutMs: 900_000 },
  // Isolated controls/accessibility checks complement the production journey;
  // fixture HTTP responses cannot attest a live subscription or action delivery.
  { name: "product-controls-fixture", command: ["python3", "apps/web/test/browser-watches.fixture-run.py"], files: ["apps/web/test/browser-watches.fixture-run.py", "apps/web/test/browser-watches.browser.py", "apps/web/test/browser-watches-mount.browser.py"], timeoutMs: 600_000 },
  { name: "saved-tools-fixture", command: ["python3", "apps/web/test/browser-watches.fixture-run.py", "--saved-tools"], files: ["apps/web/test/browser-watches.fixture-run.py", "apps/web/test/saved-tools.browser.py", "apps/web/test/saved-tools.fixture-api.ts"], timeoutMs: 600_000 },
);
const report: {
  version: 1; mode: string; startedAt: number; finishedAt?: number;
  status: "running" | "incomplete" | "failed" | "passed";
  contractSatisfied: boolean; missingChecks: { check: string; path: string }[];
  checks: { name: string; command: string[]; exitCode: number; elapsedMs: number; log: string }[];
} = { version: 1, mode: full ? "full" : "focused", startedAt, status: "running", contractSatisfied: false, missingChecks: [], checks: [] };
const save = async () => {
  const path = resolve(directory, "result.json");
  await writeFile(`${path}.partial`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.partial`, path);
};
report.missingChecks = checks.flatMap(check => (check.files ?? [])
  .filter(path => !existsSync(resolve(root, path))).map(path => ({ check: check.name, path })));
await save();
if (report.missingChecks.length) report.status = "incomplete";
else {
  for (const check of checks) {
    console.log(`Checking ${check.name}`);
    const at = Date.now(), log = resolve(directory, `${check.name}.log`);
    const fd = openSync(log, "wx", 0o600);
    let exitCode = 1;
    try {
      const child = Bun.spawn(check.command, { cwd: root, stdin: "ignore", stdout: fd, stderr: fd });
      const timeout = setTimeout(() => child.kill("SIGTERM"), check.timeoutMs);
      const kill = setTimeout(() => child.kill("SIGKILL"), check.timeoutMs + 10_000);
      try { exitCode = await child.exited; }
      finally { clearTimeout(timeout); clearTimeout(kill); }
    } catch { console.error(`Could not run ${check.name}; see ${log}`); }
    finally { closeSync(fd); }
    report.checks.push({ name: check.name, command: check.command, exitCode, elapsedMs: Date.now() - at, log });
    await save();
    if (exitCode !== 0) { report.status = "failed"; break; }
  }
  if (report.status === "running") report.status = "passed";
}
report.finishedAt = Date.now();
report.contractSatisfied = full && report.status === "passed";
await save();
console.log(JSON.stringify({ ...report, evidenceDirectory: directory }));
if (report.status !== "passed") process.exitCode = 1;
