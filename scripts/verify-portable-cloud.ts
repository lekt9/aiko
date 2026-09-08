/** Real workerd restart test. Uses synthetic accounts, local DOs, no providers. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "aiko-workerd-portable-"));
const agent = join(root, "apps/agent");
const config = ts.parseConfigFileTextToJson("wrangler.jsonc", await Bun.file(join(agent, "wrangler.jsonc")).text()).config;
const tokenA = "portable-test-account-a-credential";
const tokenB = "portable-test-account-b-credential";
const reader = "portable-test-account-read-credential";
config.name = "aiko-portability-check";
config.main = join(agent, "src/cloudflare.ts");
config.assets.directory = join(agent, "public");
config.vars = {
  AIKO_MODE: "demo", AIKO_INSTANCE_ID: "portability", AIKO_REPLY_STYLE: "direct",
  AIKO_OPERATOR_TOKEN: "portable-test-operator-credential-000000",
  AIKO_PLANE_CREDENTIALS: JSON.stringify([
    { account: "acct_portable_a", digest: createHash("sha256").update(tokenA).digest("hex"), scopes: ["read", "write"] },
    { account: "acct_portable_b", digest: createHash("sha256").update(tokenB).digest("hex"), scopes: ["read", "write"] },
    { account: "acct_portable_a", digest: createHash("sha256").update(reader).digest("hex"), scopes: ["read"] },
  ]),
};
delete config.account_id;
delete config.observability;
await writeFile(join(directory, "wrangler.json"), JSON.stringify(config));
const socket = createServer();
await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
let child: ReturnType<typeof Bun.spawn> | undefined;
let output = "";
async function start() {
  child = Bun.spawn(["node", join(agent, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", join(directory, "wrangler.json"), "--persist-to", join(directory, "state"), "--port", String(port), "--ip", "127.0.0.1"], {
    cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, CI: "true", XDG_CONFIG_HOME: join(directory, "config"), WRANGLER_SEND_METRICS: "false" },
  });
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output = (output + new TextDecoder().decode(chunk)).slice(-12000);
  };
  void capture(child.stdout as ReadableStream<Uint8Array>);
  void capture(child.stderr as ReadableStream<Uint8Array>);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local Worker stopped (${child.exitCode}): ${output.slice(-6000)}`);
    try {
      const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { assert.equal((await response.json() as any).storage, "durable-object"); return; }
    } catch { /* Await readiness while the exact process remains alive. */ }
    await Bun.sleep(250);
  }
  throw new Error(`Local Worker readiness timed out: ${output}`);
}
async function stop() {
  if (!child) return;
  child.kill("SIGINT");
  const timer = setTimeout(() => child?.kill("SIGKILL"), 10000);
  try { await child.exited; } finally { clearTimeout(timer); child = undefined; }
}
const request = (path: string, token?: string, body?: unknown) => fetch(origin + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
});
try {
  await start();
  assert.equal((await request("/v1/messages")).status, 401);
  assert.equal((await request("/v1/messages", "wrong-token")).status, 401);
  assert.equal((await request("/v1/messages", reader, { id: "readonly_attempt", text: "Forbidden write" })).status, 403);
  const message = { id: "portable_restart_test", text: "Remember that the portability test color is amber." };
  const sent = await request("/v1/messages", tokenA, message);
  assert.equal(sent.status, 202, await sent.text());
  await stop();
  await start();
  assert.equal((await request("/api/control/wake?account=acct_portable_a", tokenA, {})).status, 403);
  assert.equal((await request("/api/control/wake?account=acct_portable_a", "portable-test-operator-credential-000000", {})).status, 202);
  // Persistence alone can pass while alarm execution is broken. Require an
  // actual prepared reply after restart, with no additional foreground input.
  const completionDeadline = Date.now() + 30_000;
  let answered = false;
  while (Date.now() < completionDeadline) {
    const page = await (await request("/v1/messages", tokenA)).json() as any;
    answered = page.messages.some((row: any) => row.role === "assistant" && row.turn === `plane:${message.id}`);
    if (answered) break;
    await Bun.sleep(100);
  }
  assert.ok(answered, `Restarted Worker did not produce a reply: ${output.slice(-4000)}`);
  const response = await request("/v1/messages", tokenA);
  assert.equal(response.status, 200);
  const history = await response.json() as any;
  assert.equal(history.messages.filter((row: any) => row.id === `plane:${message.id}` && row.text === message.text).length, 1);
  const replay = await request("/v1/messages", tokenA, message);
  assert.equal(replay.status, 202);
  const readback = await (await request("/v1/messages", tokenA)).json() as any;
  assert.equal(readback.messages.filter((row: any) => row.id === `plane:${message.id}`).length, 1);
  const foreign = await (await request("/v1/messages", tokenB)).json() as any;
  assert.equal(foreign.messages.length, 0);
  assert.equal((await request("/api/control/events?thread=user-acct_portable_a", tokenB)).status, 403);
  assert.equal((await request("/api/control/export?account=acct_portable_a", tokenA)).status, 403);
  console.log(JSON.stringify({ verified: true, runtime: "real local workerd", restartPersistence: true, replyAfterRestart: true, idempotency: true, accountIsolation: true, readOnlyScope: true, providerCalls: 0 }));
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
