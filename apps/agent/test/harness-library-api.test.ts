import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "tardie/core/event";
import { harnessLibraryApi, harnessLibraryReadRequest } from "../src/harness-library-api.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryEventKey,
  type HarnessLibraryBinding, type HarnessVerifier } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = "123";
const request = (path: string, body?: unknown, prefix = "/api") => new Request(`http://localhost${prefix}/harness/library${path}`, {
  method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function fixture() {
  const dir = await mkdtemp("/tmp/harness-library-api-");
  let db = new Database(join(dir, "library.sqlite")), active = true, authority = true, revision = 1, executions = 0, wakes = 0;
  cleanups.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  db.exec("CREATE TABLE receipts(key TEXT PRIMARY KEY,body TEXT NOT NULL)");
  const rows = (): Event[] => db.query("SELECT body FROM receipts ORDER BY rowid").all().map((row: any) => JSON.parse(row.body));
  const journal = { read: async () => rows(), append: async (batch: Event[]) => db.transaction(() => {
    const retained = rows(), fresh = batch.filter(row => !retained.some(old => harnessLibraryEventKey(old) === harnessLibraryEventKey(row)));
    if (!harnessLibraryAppendAllowed(fresh, () => retained)) throw Error("native append denied");
    for (const row of fresh) db.query("INSERT INTO receipts VALUES(?,?)").run(harnessLibraryEventKey(row)!, JSON.stringify(row));
  })() };
  const verifier: HarnessVerifier = { digest: harnessDigest("api-double-verifier"), evaluatorDigest: harnessDigest("api-double-cases"),
    cases: [{ id: "development", input: { n: 4 }, split: "development" }, { id: "held-out", input: { n: -29 }, split: "held-out" }],
    verify: async ({ input, output }) => ({ passed: output === (input as { n: number }).n * 2, evidence: ["independent-double-check"], quality: 1 }) };
  let binding: HarnessLibraryBinding;
  const make = () => {
    binding = { owner, thread: `user-${owner}`, blobs: harnessBlobStore(sqliteWorkflowKV(db)), verifiers: new Map([[verifier.digest, verifier]]), guard: () => {},
      context: async () => ({ placement: "local", runtimeDigest: harnessDigest(revision), bindings: {} }), authorize: async () => authority,
      execute: async (job, signal) => {
        executions++;
        const run = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input }, ambient: { at: 0, seed: job.operationId }, history: [] }, signal);
        return run.error ? { status: "failed", evidence: ["quickjs-failed"] } : { status: "succeeded", output: run.result as number, evidence: ["quickjs-executed"] };
      } };
    return new HarnessLibrary(binding, journal);
  };
  let library = make();
  const contractDigest = await library.registerContract({ version: 1, outcome: "Double the fresh number", effect: "read", timeoutMs: 2000,
    inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, outputSchema: { type: "number" },
    verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, applicability: {} });
  const digest = await library.record({ version: 1, name: "api.double", description: "Double", runtime: "javascript", entrypoint: "main.js", files: { "main.js": "return input.n * 2;" }, dependencies: [],
    sources: [{ uri: "fixture:original", revision: "1", digest: harnessDigest("observed"), license: "fixture" }], contractDigest });
  const api = (path: string, body?: unknown, scopes = ["read", "write"], account = owner) => harnessLibraryApi(request(path, body), owner, library, { owner: account, scopes }, { current: () => active, wake: () => { wakes++; } });
  const result = async (path: string, body?: unknown) => { const response = await api(path, body); expect(response.status).toBe(200); return (await response.json() as any).result; };
  return { api, result, digest, contractDigest, rows, journal, library: () => library, binding: () => binding!, calls: () => executions, wakes: () => wakes,
    restart: () => { db.close(); db = new Database(join(dir, "library.sqlite")); library = make(); },
    revoke: () => { authority = false; }, revokeOwner: () => { active = false; }, drift: () => { revision++; } };
}

test("API revision journey retains failed candidates and source lineage, promotes only eligible versions, and recalls fresh inputs after SQLite restart", async () => {
  const f = await fixture();
  const bad = await f.result("/revise", { predecessorDigest: f.digest, changes: { files: { "main.js": "return 8;" } } });
  expect((await f.result("/evaluate", { digest: bad.digest, evaluationId: "bad-cases" })).status).toBe("failed");
  expect((await f.api("/promote", { digest: bad.digest, evaluationId: "bad-cases", expectedGeneration: 0 })).status).toBe(409);
  f.restart();
  expect((await f.result("/inspect", { digest: bad.digest })).artifact.files["main.js"]).toBe("return 8;");
  const next = await f.result("/revise", { predecessorDigest: f.digest, changes: { files: { "main.js": "const n=input.n; return n+n;" } } });
  const inspect = await f.result("/inspect", { digest: next.digest });
  expect(inspect.lineage).toMatchObject({ predecessorDigest: f.digest, changedFields: ["files"] });
  expect(inspect.artifact.sources).toEqual((await f.result("/inspect", { digest: f.digest })).artifact.sources);
  expect((await f.result("/evaluate", { digest: next.digest, evaluationId: "good-cases" })).status).toBe("eligible");
  expect((await f.result("/promote", { digest: next.digest, evaluationId: "good-cases", expectedGeneration: inspect.expectedGeneration })).status).toBe("promoted");
  f.restart(); const before = f.calls(), receipts = f.rows().length;
  expect(await f.result("/recall", { name: "api.double", contractDigest: f.contractDigest, input: { n: 113 } })).toMatchObject({ status: "available", digest: next.digest });
  expect(f.calls()).toBe(before); expect(f.rows()).toHaveLength(receipts);
  expect((await f.result("/run", { digest: next.digest, input: { n: 113 }, operationId: "fresh-113" })).status).toBe("satisfied");
  expect(await f.result("/output", { operationId: "fresh-113" })).toMatchObject({ output: 226, freshness: "historical-operation" });
  f.restart(); await f.result("/run", { digest: next.digest, input: { n: 113 }, operationId: "fresh-113" });
  expect(f.calls()).toBe(before + 1);
  expect((await f.api("/run", { digest: next.digest, input: { n: 114 }, operationId: "fresh-113" })).status).toBe(409);
  const listed = await f.result("");
  expect(listed.operations).toEqual([expect.objectContaining({ operationId: "fresh-113", status: "satisfied", outputAvailable: true })]);
  expect(listed.evaluations.map((e: any) => e.id)).toEqual(["good-cases", "bad-cases"]);
  expect(JSON.stringify(listed)).not.toContain('"n":-29');
});

test("API owner and exact read/write scopes cannot be widened by method or body fields", async () => {
  const f = await fixture();
  expect((await f.api("/inspect", { digest: f.digest }, ["read"])).status).toBe(200);
  expect((await f.api("/recall", { name: "api.double", contractDigest: f.contractDigest, input: {} }, ["read"])).status).toBe(200);
  expect((await f.api("/output", { operationId: "absent" }, ["read"])).status).toBe(409);
  for (const [path, body] of [["/revise", { predecessorDigest: f.digest, changes: { description: "x" } }], ["/evaluate", { digest: f.digest, evaluationId: "x" }],
    ["/run", { digest: f.digest, input: { n: 1 }, operationId: "x" }], ["/from-request", { toolDigest: f.digest, name: "x", contractDigest: f.contractDigest }]] as const)
    expect((await f.api(path, body, ["read"])).status).toBe(403);
  expect((await f.api("/inspect", { digest: f.digest }, ["write"])).status).toBe(403);
  expect((await f.api("", undefined, ["read"], "foreign")).status).toBe(403);
  expect((await f.api("/inspect", { digest: f.digest, owner: "foreign" })).status).toBe(400);
  expect((await f.api("/revise", { predecessorDigest: f.digest, changes: { name: "replacement" } })).status).toBe(400);
  expect((await f.api("/run", { digest: f.digest, input: {}, operationId: "x", receiptOf: "forged" })).status).toBe(400);
  expect((await f.api("/inspect?owner=foreign", { digest: f.digest })).status).toBe(400);
  expect(f.calls()).toBe(0); expect(f.wakes()).toBe(0);
  for (const prefix of ["/api", "/v1"]) {
    expect(harnessLibraryReadRequest(request("/inspect", {}, prefix))).toBe(true);
    expect(harnessLibraryReadRequest(request("/inspect/extra", {}, prefix))).toBe(false);
    expect(harnessLibraryReadRequest(request("/run", {}, prefix))).toBe(false);
  }
});

test("current effect authority and runtime drift are rechecked; a revoked account during await cannot dispatch", async () => {
  const f = await fixture();
  await f.result("/evaluate", { digest: f.digest, evaluationId: "baseline" });
  await f.result("/promote", { digest: f.digest, evaluationId: "baseline", expectedGeneration: 0 });
  const calls = f.calls(); f.revoke();
  expect(await f.result("/recall", { name: "api.double", contractDigest: f.contractDigest, input: { n: 1 } })).toMatchObject({ status: "unavailable" });
  expect((await f.result("/run", { digest: f.digest, input: { n: 1 }, operationId: "denied" })).status).toBe("blocked");
  f.drift(); expect(await f.result("/recall", { name: "api.double", contractDigest: f.contractDigest, input: { n: 2 } })).toMatchObject({ status: "unavailable" });
  expect(f.calls()).toBe(calls);
  const g = await fixture(), context = g.binding().context;
  g.binding().context = async signal => { const value = await context(signal); g.revokeOwner(); return value; };
  expect((await g.api("/run", { digest: g.digest, input: { n: 2 }, operationId: "revoked-await" })).status).toBe(403);
  expect(g.calls()).toBe(0); expect(g.rows().some(e => e.id === "revoked-await")).toBe(false);
});

test("unknown execution remains held across restart and output never exposes fixture custody", async () => {
  const f = await fixture(); let dispatched = 0;
  f.binding().execute = async () => { dispatched++; throw Error("secret-provider-detail"); };
  expect((await f.result("/run", { digest: f.digest, input: { n: 6 }, operationId: "uncertain" })).status).toBe("unknown");
  f.restart();
  expect((await f.result("/run", { digest: f.digest, input: { n: 6 }, operationId: "uncertain" })).status).toBe("unknown");
  expect(dispatched).toBe(1); expect(f.calls()).toBe(0);
  expect((await f.result("")).operations).toEqual([expect.objectContaining({ operationId: "uncertain", status: "unknown", outputAvailable: false })]);
  const unavailable = await f.api("/output", { operationId: "uncertain" });
  expect(unavailable.status).toBe(409); expect(await unavailable.text()).not.toContain("secret-provider-detail");
  await f.result("/evaluate", { digest: f.digest, evaluationId: "fixtures" });
  const fixtureRun = f.rows().find(e => e.type === "AikoHarnessRunStarted" && e.caseId === "held-out")!;
  expect((await f.api("/output", { operationId: fixtureRun.id })).status).toBe(409);
  expect((await f.result("")).operations).toHaveLength(1);
});

test("API cannot invent observed evidence or effect approval, and unavailable binding remains explicit", async () => {
  const f = await fixture();
  expect(await f.result("/from-request", { toolDigest: harnessDigest("missing"), name: "request", contractDigest: f.contractDigest })).toMatchObject({ status: "unavailable" });
  const { contract } = await f.library().resolve(f.digest);
  const write = await f.library().registerContract({ ...contract, effect: "write" });
  const candidate = await f.result("/revise", { predecessorDigest: f.digest, changes: { contractDigest: write } });
  expect((await f.api("/evaluate", { digest: candidate.digest, evaluationId: "unapproved-fixtures" })).status).toBe(409);
  expect(f.calls()).toBe(0);
  const response = await harnessLibraryApi(request(""), owner, undefined, { owner, scopes: ["read"] }, { current: () => true, wake() {} });
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ available: false });
});

test("actual Bun owner API permits structured read lookups while denying mutation for read-only credentials", async () => {
  const dir = await mkdtemp("/tmp/harness-library-api-host-");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const token = "api-library-read-123456789012345678901234567890";
  const f = await fixture();
  const config: AikoConfig = { mode: "demo", codeMode: true, port: 4242, stateDir: dir, persona: PERSONA, voiceEnabled: false, allowedUsers: new Set([owner]),
    operatorToken: "api-library-operator-12345678901234567890", planeCredentials: [{ account: owner, digest: credentialDigest(token), scopes: ["read"] }] };
  const service = await createService(config, { registry: context => ({ library: { ...f.binding(), owner: context.owner, thread: context.thread }, codeTransport: runCodeSegment }) });
  cleanups.push(() => service.close());
  const call = (path: string, body?: unknown) => { const req = request(path, body); req.headers.set("authorization", `Bearer ${token}`); return service.fetch(req); };
  expect((await call("")).status).toBe(200);
  // An absent owned artifact reaches the native lookup and returns 409, rather
  // than the old generic POST/write gate incorrectly denying it as 403.
  expect((await call("/inspect", { digest: f.digest })).status).toBe(409);
  expect((await call("/recall", { name: "api.double", contractDigest: f.contractDigest, input: { n: 1 } })).status).toBe(200);
  expect((await call("/run", { digest: f.digest, input: { n: 1 }, operationId: "forbidden" })).status).toBe(403);
  expect(f.calls()).toBe(0);
  for (const row of f.rows()) await service.host.commitRoot(service.host.self(`user-${owner}`), row);
  expect((await call("/inspect", { digest: f.digest })).status).toBe(200);
  config.planeCredentials![0]!.scopes = ["read", "write"];
  const executed = await call("/run", { digest: f.digest, input: { n: 47 }, operationId: "native-owner-api" });
  expect(executed.status).toBe(200);
  expect(await executed.json()).toMatchObject({ result: { status: "satisfied" } });
  expect((await service.host.read(`user-${owner}`)).some(e => e.type === "AikoHarnessChecked" && e.id === "native-owner-api")).toBe(true);
  expect(await (await call("/output", { operationId: "native-owner-api" })).json()).toMatchObject({ result: { output: 94 } });
});
