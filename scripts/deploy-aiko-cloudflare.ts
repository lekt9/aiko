import { mkdir, writeFile, rename, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { credentialDigest, parsePlaneCredentials } from "../apps/agent/src/plane-auth.ts";
import { redactor } from "../apps/agent/src/security.ts";
import { buildCloudflare, agentDirectory, wranglerConfig } from "./build-aiko-cloudflare.ts";
import { cloudflareState, cloudflareStatePath, cloudflareSecrets } from "./cloudflare-paths.ts";

// Build needs no credentials, native state, Telegram bot, or local service.
process.umask(0o077);
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--deploy")) throw new Error("Usage: bun scripts/deploy-aiko-cloudflare.ts [--deploy]");
await buildCloudflare();
if (!args.includes("--deploy")) {
  console.log("Cloud build passed. Use --deploy to publish.");
  process.exit(0);
}
const source = await cloudflareSecrets();
const get = (key: string) => process.env[key] ?? source[key];
const operator = get("AIKO_OPERATOR_TOKEN");
if (!operator || operator.length < 32 || !get("CODEGRAFF_API_KEY"))
  throw new Error("Set AIKO_OPERATOR_TOKEN (at least 32 characters) and CODEGRAFF_API_KEY for live deployment");
if (!!get("AIKO_BOT_TOKEN") !== !!get("AIKO_WEBHOOK_SECRET"))
  throw new Error("Set both Telegram credentials, or neither for web-only deployment");
const path = cloudflareStatePath();
const state = await cloudflareState();
state.AIKO_E2E_OWNER ??= "acct_cloudflare_e2e02";
state.AIKO_E2E_TOKEN ??= randomBytes(32).toString("base64url");
state.AIKO_BACKUP_KEY ??= get("AIKO_BACKUP_KEY")!;
if (!state.AIKO_BACKUP_KEY) throw new Error("Set AIKO_BACKUP_KEY from your recovery secret store. For a NEW deployment, generate a 32-byte base64 key once and retain it before deploying.");
if (!/^[A-Za-z0-9_-]{40,}$/.test(state.AIKO_E2E_TOKEN) || Buffer.from(state.AIKO_BACKUP_KEY, "base64").length !== 32)
  throw new Error("Invalid deployment canary token or backup recovery key");
const configuredCredentials = get("AIKO_PLANE_CREDENTIALS");
if (configuredCredentials === undefined) throw new Error("Set the complete AIKO_PLANE_CREDENTIALS list; use [] explicitly for a new deployment with only the canary account");
const credentials = parsePlaneCredentials(configuredCredentials);
const digest = credentialDigest(state.AIKO_E2E_TOKEN);
const existing = credentials.find(entry => entry.digest === digest);
if (existing && (existing.account !== state.AIKO_E2E_OWNER || !existing.scopes.includes("read") || !existing.scopes.includes("write")))
  throw new Error("Canary credential conflicts with configured account");
if (!existing) credentials.push({ account: state.AIKO_E2E_OWNER, digest, scopes: ["read", "write"] });
parsePlaneCredentials(JSON.stringify(credentials));
const secrets: Record<string, string> = {
  AIKO_OPERATOR_TOKEN: operator,
  CODEGRAFF_API_KEY: get("CODEGRAFF_API_KEY")!,
  AIKO_BACKUP_KEY: state.AIKO_BACKUP_KEY,
  AIKO_PLANE_CREDENTIALS: JSON.stringify(credentials),
};
for (const key of [
  "CEREBRAS_API_KEY", "ARCADE_API_KEY", "AIKO_BOT_TOKEN", "AIKO_WEBHOOK_SECRET",
  "AIKO_ALLOWED_USERS", "AIKO_MANAGER_KEY", "AIKO_MANAGER_PROVIDERS_JSON",
  "AIKO_CONNECTOR_VAULT_JSON", "AIKO_CODE_MODE", "AIKO_VOICE_KEY",
  "AIKO_CARTESIA_KEY", "AIKO_CARTESIA_VOICE_ID", "AIKO_CARTESIA_MODEL", "AIKO_PERSONA",
]) {
  const value = get(key);
  if (value !== undefined) secrets[key] = value;
}
// Retain only deployment recovery material, never unrelated CI environment secrets.
async function saveState() {
  const keys = ["AIKO_E2E_OWNER", "AIKO_E2E_TOKEN", "AIKO_BACKUP_KEY", "AIKO_CLOUDFLARE_URL"];
  const content = keys.filter(key => state[key] !== undefined).map(key => {
    if (/[\r\n]/.test(state[key]!)) throw new Error("Invalid deployment state value");
    return `${key}=${state[key]}`;
  }).join("\n") + "\n";
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.${randomBytes(8).toString("hex")}.pending`;
  await writeFile(pending, content, { flag: "wx", mode: 0o600 });
  await rename(pending, path);
}
// Persist the recovery key before publishing a deployment that can write backups.
await saveState();
const redact = redactor([...Object.values(secrets), state.AIKO_E2E_TOKEN]);
async function run(args: string[]) {
  const child = Bun.spawn(["pnpm", "exec", "wrangler", ...args, "--config", wranglerConfig], {
    cwd: agentDirectory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  console.log(redact(out + err));
  if (code !== 0) throw new Error(`Deployment step failed (${code})`);
  return out;
}
// Publish code and secrets in one version; no intermediate live secret update.
const secretDir = await mkdtemp(join(tmpdir(), "aiko-deploy-"));
let output: string;
try {
  const secretFile = join(secretDir, "secrets.json");
  await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
  output = await run(["deploy", "--secrets-file", secretFile]);
} finally { await rm(secretDir, { recursive: true, force: true }); }
const url = output.match(/https:\/\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.workers\.dev/)?.[0] ?? state.AIKO_CLOUDFLARE_URL;
if (!url || new URL(url).protocol !== "https:") throw new Error("Set AIKO_CLOUDFLARE_URL for deployments using only a custom domain");
state.AIKO_CLOUDFLARE_URL = url;
await saveState();
let ready = false;
for (let attempt = 0; attempt < 20 && !ready; attempt++) {
  try {
    const response = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(10000) });
    ready = response.ok && ((await response.json()) as { storage?: string }).storage === "durable-object";
  } catch { /* Allow propagation before declaring deployment health unknown. */ }
  if (!ready) await Bun.sleep(1000);
}
if (!ready) throw new Error("Cloudflare readiness failed; inspect the deployment before retrying");
console.log(JSON.stringify({ deployed: url, control: `${url}/control`, telegramCutover: false }));
