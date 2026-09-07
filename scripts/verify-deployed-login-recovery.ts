/** Restart/expiry regression against the dedicated synthetic account only. */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadConfig, privateEnv } from "../apps/agent/src/config.ts";
import { Codegraff } from "../apps/agent/src/codegraff.ts";

process.umask(0o077);
const env = await privateEnv("/home/deck/.config/unbrowse/aiko-cloudflare.env");
const config = await loadConfig(process.env, { readonly: true });
const owner = env.AIKO_E2E_OWNER, base = env.AIKO_CLOUDFLARE_URL;
const domain = "unlock-login-canary.lewis-6d8.workers.dev";
if (owner !== "acct_cloudflare_e2e02" || base !== "https://aiko-agent.lewis-6d8.workers.dev") throw Error("Invalid synthetic deployment");
const gateway = new Codegraff(config.modelKey!);
async function request(path: string, body?: object, operator = false, expected = 200) {
  if (!path.includes("/api/control/events")) console.log("Canary step", path.split("?")[0], body && "action" in body ? body.action : "");
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${operator ? config.operatorToken : env.AIKO_E2E_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180_000),
  });
  if (response.status !== expected) throw Error(`Canary ${path.split("?")[0]} returned HTTP ${response.status}`);
  return await response.json() as any;
}
const unauthenticated = await fetch(base + "/api/connectors/connections", {signal:AbortSignal.timeout(20000)});
if (unauthenticated.status !== 401) throw Error("Missing authentication gate");
await unauthenticated.body?.cancel();
// The account is reserved for canaries. Refuse to alter unfamiliar providers.
const existing = (await request("/api/connectors/connections")).connections;
for (const connection of existing) {
  if (connection.provider === "browser" && connection.status !== "disconnected") {
    if (!["browser:" + domain, "browser:linkedin.com"].includes(connection.connectorId)) throw Error("Unexpected canary browser connection");
    await request("/api/connectors/disconnect", { connectionId: connection.id });
  }
}
const connection = await request("/api/connectors/browser", { domain });
if (!/^[a-f0-9-]{36}$/.test(connection.id)) throw Error("Invalid canary connection");
const control = (action: string, fields: object = {}) => request("/api/connectors/native", { connectionId: connection.id, action, ...fields });
async function form() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const view = await control("form");
    if (view.status !== "pending") throw Error(`Expected pending form, got ${view.status}`);
    if (view.fields?.includes("username") && view.fields.includes("password")) return view;
    await Bun.sleep(300);
  }
  throw Error("Canary fields did not load");
}
const first = await form();
console.log("Canary form loaded; locating its owner-bound runner.");
let after = 0, sandbox: string | undefined;
for (;;) {
  const page = await request(`/api/control/events?thread=user-${owner}&after=${after}&limit=100`, undefined, true);
  for (const { event } of page.events) if (event.type === "AikoSandboxReady" && event.owner === owner) sandbox = event.sandbox;
  if (!page.hasMore) break;
  if (page.nextAfter <= after) throw Error("Invalid event cursor");
  after = page.nextAfter;
}
if (!sandbox || !/^[a-z0-9-]+$/.test(sandbox)) throw Error("No owner-bound canary VM");
async function exec(command: string) {
  const signal = AbortSignal.timeout(120_000);
  const launched = await gateway.request(`/v1/sandboxes/${sandbox}/exec`, { command, async: true }, signal);
  if (!/^[a-zA-Z0-9_-]+$/.test(launched.execId)) throw Error("Invalid execution ID");
  for (;;) {
    const job = await gateway.request(`/v1/sandboxes/${sandbox}/exec/${launched.execId}?tail=10000`, undefined, signal);
    if (job.state === "completed") {
      if (job.exitCode !== 0) throw Error("Canary runner operation failed");
      return String(job.output ?? job.result ?? "");
    }
    await Bun.sleep(500);
  }
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const bun = "/home/daytona/.bun/bin/bun";
const root = "/home/daytona/aiko";
const guard = `if ((await Bun.file("${root}/owner.json").json()).owner !== ${JSON.stringify(owner)}) throw Error("Wrong canary owner");`;
const expectedHash = createHash("sha256").update(await Bun.file(new URL("../apps/agent/assets/runner.txt", import.meta.url)).text()).digest("hex");
const verifiedHash = await exec(`${bun} -e ${quote(guard + `console.log(new Bun.CryptoHasher("sha256").update(await Bun.file("${root}/runner.js").arrayBuffer()).digest("hex"))`)}`);
if (verifiedHash.trim() !== expectedHash) throw Error("Canary is not running the release bundle");
async function close() {
  await exec(`${bun} -e ${quote(guard)} && cd ${root} && ${bun} runner.js close`);
}
await close();
const restarted = await form();
if (restarted.revision !== first.revision + 1) throw Error("Restart did not advance private generation");
console.log("Deployed pending form recovered after runner restart.");
await close();
const expire = guard + `const {Database}=await import("bun:sqlite");const db=new Database("${root}/browser/request-evidence.sqlite");const id=${JSON.stringify(connection.id)};const row=db.query("SELECT state FROM native_login WHERE id=?").get(id);const state=JSON.parse(row.state);if(state.domain!==${JSON.stringify(domain)}||state.status!=="pending")throw Error("Wrong canary state");state.expiresAt=1;db.query("UPDATE native_login SET state=? WHERE id=?").run(JSON.stringify(state),id);db.close();`;
await exec(`${bun} -e ${quote(expire)}`);
if ((await request("/api/connectors/complete", {connectionId:connection.id})).status !== "pending") throw Error("Status poll discarded recoverable sign-in");
const refreshed = await form();
if (refreshed.revision !== restarted.revision + 2) throw Error("Expiry did not clean and reopen its generation");
console.log("Deployed expired form recovered after an intervening status check.");
const rejected = await control("login", { username: "fixture-user", password: "wrong-fixture-password" });
if (rejected.status === "connected" || rejected.credentialsSaved === true) throw Error("Bad password accepted");
const connected = await control("login", { username: "fixture-user", password: "fixture-password" });
if (connected.status !== "connected" || connected.credentialsSaved !== true) throw Error("Synthetic login did not verify");
// The actual reported site is inspected without submitting any credentials.
await request("/api/connectors/disconnect", {connectionId:connection.id});
const linkedin = await request("/api/connectors/browser", {domain:"linkedin.com"});
async function linkedinForm() {
  for (let attempt=0; attempt<20; attempt++) {
    const view=await request("/api/connectors/native", {connectionId:linkedin.id,action:"form"});
    if (view.status!=="pending") throw Error("Expected pending LinkedIn form");
    if (view.fields?.includes("username") && view.fields.includes("password")) return view;
    await Bun.sleep(300);
  }
  throw Error("LinkedIn fields did not load");
}
const linkedinBefore=await linkedinForm();
await close();
const linkedinAfter=await linkedinForm();
if(linkedinAfter.revision!==linkedinBefore.revision+1) throw Error("LinkedIn form did not recover after restart");
await request("/api/connectors/disconnect", {connectionId:linkedin.id});
console.log("Actual LinkedIn fields recovered after restart; no LinkedIn credentials submitted.");
await mkdir("artifacts/connectors", { recursive: true });
await writeFile("artifacts/connectors/login-repair-api.json", JSON.stringify({ at: new Date().toISOString(), verified: true, base, owner, domain, connectionId: connection.id, runnerHash: expectedHash, beforeRevision: first.revision, restartRevision: restarted.revision, expiryRevision: refreshed.revision, statusBeforeReopen: "pending", badPasswordRejected: true, credentialsSaved: true, syntheticCredentials: true, linkedinFormRecovered:true, linkedinCredentialsSubmitted:false }, null, 2));
console.log("Deployed restart, expiry, bad-password and verified-login checks passed.");
