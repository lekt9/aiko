import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxDispatch, type SandboxDispatchChallenge, type SandboxDispatchReply } from "../src/sandbox-dispatch.ts";
import { sandboxDigest, verifySandboxReceipt, type SandboxJob } from "../src/sandbox-job.ts";
import { runSandboxJob, sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";

const environmentDigest = await sandboxEnvironment("guarded-fixture-v1");
const origin = "https://hooks.receiver.com";
async function job(count = 1, wallMs = 5000): Promise<SandboxJob> {
  const artifact: SandboxJob["artifact"] = { kind: "network", actionId: "deliver", graph: {
    schemaVersion: 2, executorAbi: "site-harness/1", siteId: "fixture", version: "1", sourceCaptureDigest: await sandboxDigest("capture"),
    allowedOrigins: [origin], actions: [{ id: "deliver", inputs: [], steps: Array.from({ length: count }, (_, i) => ({
      id: `send${i}`, dependsOn: i ? [`send${i - 1}`] : [], method: "POST", origin, path: i ? "/items/second" : "/items/first",
      pathParameters: {}, query: {}, headers: {}, expectedStatuses: [200],
    })) }],
  } };
  return { version: 1, owner: "owner", operationId: crypto.randomUUID(), contextRef: "context", authorityRef: "authority", artifact,
    harnessDigest: await sandboxDigest(artifact), dependencyLock: {}, dependencyLockDigest: await sandboxDigest({}), environmentDigest,
    input: {}, authority: { origins: [origin], methods: ["POST"] }, budget: { wallMs, requests: count, outputBytes: 32768 },
    dispatch: { protocol: "host-request/v1" } };
}
function challenge(reply: SandboxDispatchReply): SandboxDispatchChallenge {
  expect(reply.status).toBe("awaiting-dispatch");
  if (reply.status !== "awaiting-dispatch") throw Error(JSON.stringify(reply));
  return reply;
}
function decision(value: SandboxDispatchChallenge, allow = true) {
  const { owner, operationId, jobDigest, requestDigest, nonce } = value;
  return { owner, operationId, jobDigest, requestDigest, nonce, allow };
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await f.close(); }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-dispatch-"));
  const dbPath = join(directory, "receipts.sqlite"), keyPath = join(directory, "key");
  const db = new Database(dbPath), journal = await sandboxJobJournal(db, keyPath);
  let sockets = 0, dns = 0, loseResponse = false;
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(request.url!);
    if (loseResponse) { request.socket.destroy(); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ sequence: received.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const binding = { owner: "owner", environmentDigest, journal, http: {
    lookup: async () => { dns++; return ["93.184.216.34"]; },
    // The real primitive still prepares and pins the public request. Only the
    // socket destination is substituted with this test's local HTTP server.
    request: ((_target: string, options: any, callback: any) => {
      sockets++; return httpRequest({ ...options, hostname: "127.0.0.1", port, path: new URL(_target).pathname }, callback);
    }) as typeof httpRequest,
  } };
  const helpers: ReturnType<typeof createSandboxDispatch>[] = [];
  const make = (override = binding, maxPending = 16) => { const helper = createSandboxDispatch(override, { maxPending }); helpers.push(helper); return helper; };
  return { binding, make, dbPath, keyPath, received, get sockets() { return sockets; }, get dns() { return dns; },
    loseResponse() { loseResponse = true; },
    async close() {
      helpers.forEach(h => h.close());
      // Let the existing job runner retain its final failure after cancellation.
      await Bun.sleep(20); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close(); await rm(directory, { recursive: true, force: true });
    } };
}

test("denial after DNS prevents sockets and retains a failed receipt without a replay", () => fixture(async f => {
  const helper = f.make(), input = await job();
  const pending = challenge(await helper.start(input));
  expect(f.dns).toBe(1); expect(f.sockets).toBe(0); expect(helper.pendingCount).toBe(1);
  expect(pending.jobDigest).toBe(await sandboxDigest(input));
  expect(pending.requestDigest).toBe(await sandboxDigest(pending.prepared));
  expect(pending.prepared).toMatchObject({ url: `${origin}/items/first`, method: "POST", address: "93.184.216.34" });
  const denied = await helper.continue(decision(pending, false));
  expect(denied.status).toBe("receipt");
  if (denied.status === "receipt") expect(denied.receipt.status).toBe("failed");
  expect(f.sockets).toBe(0); expect(await helper.start(input)).toEqual(denied);
  await expect(helper.continue(decision(pending))).rejects.toThrow("unavailable");
}));

test("exact one-use permit sends once; changed identities and challenge mutation cannot alter the request", () => fixture(async f => {
  const helper = f.make(), input = await job(), pending = challenge(await helper.start(input));
  const original = structuredClone(pending);
  pending.prepared.url = "https://different.receiver.com/changed";
  expect(await helper.start(input)).toEqual(original);
  for (const change of [{ owner: "foreign" }, { nonce: crypto.randomUUID() }, { operationId: "other" },
    { jobDigest: await sandboxDigest("other") }, { requestDigest: await sandboxDigest("other") }])
    await expect(helper.continue({ ...decision(original), ...change })).rejects.toThrow();
  await expect(helper.start({ ...input, input: { changed: true } })).rejects.toThrow("identity_conflict");
  expect(f.sockets).toBe(0);
  const result = helper.continue(decision(original));
  await expect(helper.continue(decision(original))).rejects.toThrow("unavailable");
  const terminal = await result;
  if (terminal.status !== "receipt") throw Error("missing receipt");
  expect(terminal.receipt.status).toBe("completed");
  expect(await verifySandboxReceipt(input, terminal.receipt)).toEqual(terminal.receipt);
  expect(f.received).toEqual(["/items/first"]); expect(f.sockets).toBe(1);
  expect(await helper.start(input)).toEqual(terminal); expect(f.sockets).toBe(1);
}));

test("sequential DAG requests each require their own nonce and prepared request permit", () => fixture(async f => {
  const helper = f.make(), input = await job(2);
  const first = challenge(await helper.start(input));
  const second = challenge(await helper.continue(decision(first)));
  expect(f.sockets).toBe(1); expect(second.nonce).not.toBe(first.nonce);
  expect(second.requestDigest).not.toBe(first.requestDigest); expect(second.stepId).toBe("send1");
  await expect(helper.continue(decision(first))).rejects.toThrow("conflict");
  expect(f.sockets).toBe(1);
  const result = await helper.continue(decision(second));
  if (result.status !== "receipt") throw Error("missing receipt");
  expect(result.receipt.status).toBe("completed"); expect(result.receipt.requests).toBe(2);
  expect(f.received).toEqual(["/items/first", "/items/second"]);
}));

test("lost write acknowledgement stays unknown across SQLite reopen without a fresh challenge or send", () => fixture(async f => {
  f.loseResponse(); const helper = f.make(), input = await job();
  const result = await helper.continue(decision(challenge(await helper.start(input))));
  if (result.status !== "receipt") throw Error("missing receipt");
  expect(result.receipt.status).toBe("unknown"); expect(f.sockets).toBe(1);
  const reopened = new Database(f.dbPath);
  try {
    const journal = await sandboxJobJournal(reopened, f.keyPath), restarted = f.make({ ...f.binding, journal });
    expect(await restarted.start(input)).toEqual(result); expect(f.sockets).toBe(1); expect(f.dns).toBe(1);
    const interrupted = await job(); await journal.claim(interrupted.owner, interrupted.operationId, await sandboxDigest(interrupted));
    const unknown = await restarted.start(interrupted);
    if (unknown.status !== "receipt") throw Error("regenerated dispatch");
    expect(unknown.receipt.status).toBe("unknown"); expect(f.dns).toBe(1);
  } finally { reopened.close(); }
}));

test("capacity, cancellation and close deny outstanding continuations", () => fixture(async f => {
  const helper = f.make(f.binding, 1), controller = new AbortController();
  const first = challenge(await helper.start(await job(), controller.signal));
  await expect(helper.start(await job())).rejects.toThrow("capacity");
  controller.abort(); expect(helper.pendingCount).toBe(0);
  await expect(helper.continue(decision(first))).rejects.toThrow("unavailable");
  const next = challenge(await helper.start(await job()));
  helper.close(); expect(helper.pendingCount).toBe(0);
  await expect(helper.continue(decision(next))).rejects.toThrow("unavailable");
  await expect(helper.start(await job())).rejects.toThrow("closed"); expect(f.sockets).toBe(0);
}));

test("deadline releases capacity during stalled DNS; late DNS cannot send or regenerate a claimed job", () => fixture(async f => {
  let release!: (addresses: string[]) => void, entered!: () => void;
  const lookupEntered = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  const helper = f.make({ ...f.binding, http: { ...f.binding.http, lookup: async () => {
    if (!first) return ["93.184.216.34"]; first = false; entered();
    return await new Promise<string[]>(resolve => { release = resolve; });
  } } }, 1);
  const input = await job(1, 50), running = helper.start(input);
  await lookupEntered;
  const expired = await running;
  if (expired.status !== "receipt") throw Error("unexpected challenge");
  expect(expired.receipt.status).toBe("unknown"); expect(helper.pendingCount).toBe(0); expect(f.sockets).toBe(0);
  const retained = await helper.start(input);
  if (retained.status !== "receipt") throw Error("regenerated challenge");
  expect(retained.receipt.status).toBe("unknown");
  const next = challenge(await helper.start(await job()));
  expect(helper.pendingCount).toBe(1);
  release(["93.184.216.34"]); await Bun.sleep(10);
  expect(f.sockets).toBe(0); expect(helper.pendingCount).toBe(1);
  await helper.continue(decision(next, false)); expect(f.sockets).toBe(0);
}));

test("guard requirement is digest-bound and rejects legacy transport overrides before claiming", () => fixture(async f => {
  const input = await job(); let legacyCalls = 0, claims = 0;
  const binding = { ...f.binding, journal: { ...f.binding.journal, claim: async (...args: Parameters<typeof f.binding.journal.claim>) => {
    claims++; return f.binding.journal.claim(...args);
  } } };
  await expect(runSandboxJob(input, binding)).rejects.toThrow();
  await expect(runSandboxJob(input, { ...binding, beforeNetworkDispatch: async () => undefined,
    send: async () => { legacyCalls++; throw Error("must not send"); } })).rejects.toThrow();
  expect(claims).toBe(0); expect(legacyCalls).toBe(0); expect(f.sockets).toBe(0);
  const helper = f.make(), pending = challenge(await helper.start(input));
  const { dispatch: _dispatch, ...unguarded } = input;
  expect(await sandboxDigest(unguarded)).not.toBe(pending.jobDigest);
  await expect(runSandboxJob(unguarded, f.binding)).rejects.toThrow("identity conflict");
  expect(f.sockets).toBe(0);
  await helper.continue(decision(pending, false));
}));
