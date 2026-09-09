import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { privateEnv } from "../apps/agent/src/config.ts";
import { buildVoyager, voyagerAgentDirectory, voyagerConfig } from "./build-aiko-voyager.ts";

process.umask(0o077);
if (process.argv.slice(2).join(" ") !== "--deploy") throw Error("Usage: bun scripts/deploy-aiko-voyager.ts --deploy");
const statePath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "unbrowse/aiko-voyager.env");
await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
const lock = `${statePath}.deploy.lock`;
await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
try {
  await buildVoyager();
  let state: Record<string, string>;
  try { state = await privateEnv(statePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = { AIKO_VOYAGER_SESSION_KEY: randomBytes(32).toString("base64url") };
    await writeFile(statePath, `AIKO_VOYAGER_SESSION_KEY=${state.AIKO_VOYAGER_SESSION_KEY}\n`, { flag: "wx", mode: 0o600 });
  }
  const key = state.AIKO_VOYAGER_SESSION_KEY;
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw Error("Invalid private Voyager session key");
  // This deploy publishes only the viewer and its cookie-sealing key. It has no
  // agent storage binding, model key, bot token or stored production bearer.
  const scratch = await mkdtemp(join(tmpdir(), "aiko-voyager-deploy-"));
  let output: string;
  try {
    const secretFile = join(scratch, "secrets.json");
    await writeFile(secretFile, JSON.stringify({ AIKO_VOYAGER_SESSION_KEY: key }), { mode: 0o600 });
    const child = Bun.spawn(["pnpm", "exec", "wrangler", "deploy", "--config", voyagerConfig, "--secrets-file", secretFile], {
      cwd: voyagerAgentDirectory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    output = (stdout + stderr).replaceAll(key, "[REDACTED]");
    console.log(output);
    if (code !== 0) throw Error("Voyager deployment did not complete. Inspect its Cloudflare version before retrying.");
  } finally { await rm(scratch, { recursive: true, force: true }); }
  const url = output.match(/https:\/\/aiko-voyager\.[A-Za-z0-9_-]+\.workers\.dev/)?.[0];
  if (!url) throw Error("The viewer was published, but no URL was returned. Inspect Cloudflare before retrying.");
  let ready = false;
  // A new workers.dev route can briefly serve non-JSON while it propagates.
  // Recheck reads only: publishing itself is never automatically repeated.
  for (let attempt = 0; attempt < 10 && !ready; attempt++) {
    try {
      const response = await fetch(`${url}/healthz`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const health = await response.json() as { viewer?: string; readOnly?: boolean };
      ready = response.ok && health.viewer === "native-voyager" && health.readOnly === true;
    } catch { /* Readiness is still unknown; allow route propagation. */ }
    if (!ready) await Bun.sleep(1000);
  }
  if (!ready) throw Error("The viewer was published, but health is unverified. Inspect its version and run verify-aiko-voyager.ts; do not republish just to retry health.");
  console.log(JSON.stringify({ viewer: url, productionAgentRedeployed: false, verification: "public health only; authenticated trace readback is still required", sessionKeyFile: statePath }));
} finally { await rm(lock, { force: true }); }
