import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serialize, deserialize } from "node:v8";
import { Effect } from "effect";
import { EventLog, withWatermark } from "tardie/core/log";
import { credentialDigest } from "../src/plane-auth.ts";
import { createPromises } from "../src/promises.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";

/** Only platform primitives are adapted. Authentication, routes, actor assembly,
 * native execution, private custody and account persistence are production code. */
function storageFor(db: Database): any {
  db.exec("CREATE TABLE IF NOT EXISTS fixture_kv(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  let tail: Promise<unknown> = Promise.resolve();
  const storage: any = {
    get: async (key: string) => { const row = db.query("SELECT value FROM fixture_kv WHERE key=?").get(key) as { value: Uint8Array } | null; return row ? deserialize(row.value) : undefined; },
    put: async (key: string, value: unknown) => { db.query("INSERT OR REPLACE INTO fixture_kv VALUES(?,?)").run(key, serialize(value)); },
    delete: async (key: string) => { db.query("DELETE FROM fixture_kv WHERE key=?").run(key); },
    list: async ({ prefix = "" } = {}) => new Map((db.query("SELECT key,value FROM fixture_kv WHERE key LIKE ?").all(prefix + "%") as { key: string; value: Uint8Array }[]).map(row => [row.key, deserialize(row.value)])),
    sql: { exec: (sql: string, ...args: any[]) => { const rows = sql.trimStart().startsWith("CREATE") ? (db.exec(sql), []) : db.query(sql).all(...args.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v)); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } },
    transactionSync: (fn: () => unknown) => db.transaction(fn)(),
    transaction: (fn: (tx: any) => Promise<unknown>) => { const next = tail.then(async () => { db.exec("SAVEPOINT fixture_atomic"); try { const result = await fn(storage); db.exec("RELEASE fixture_atomic"); return result; } catch (error) { db.exec("ROLLBACK TO fixture_atomic"); db.exec("RELEASE fixture_atomic"); throw error; } }); tail = next.catch(() => undefined); return next; },
    getAlarm: async () => (await storage.get("fixture:alarm")) ?? null,
    setAlarm: (at: number) => storage.put("fixture:alarm", Number(at)), deleteAlarm: () => storage.delete("fixture:alarm"), sync: async () => {},
  };
  return storage;
}

test("production Worker authenticates owner review and exact consent, runs native tools locally and survives account reopen", async () => {
  const installed = new Map(["effect", "zod"].map(name => [name, Bun.resolveSync(name, new URL("../", import.meta.url).pathname)]));
  installed.set("@json-render/core", Bun.resolveSync("@json-render/core", new URL("../../../packages/protocol/", import.meta.url).pathname));
  const build = await Bun.build({ entrypoints: [new URL("../src/cloudflare.ts", import.meta.url).pathname], target: "bun", format: "esm", sourcemap: "external", conditions: ["workerd"], external: ["node:*"], plugins: [{ name: "promise-platform", setup(builder) {
    builder.onResolve({ filter: /^(effect|zod|@json-render\/core)$/ }, ({ path }) => ({ path: installed.get(path)! }));
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers", namespace: "platform" }));
    builder.onLoad({ filter: /.*/, namespace: "platform" }, () => ({ loader: "js", contents: "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }" }));
    builder.onLoad({ filter: /\.(sh|py|txt)$/ }, async ({ path }) => ({ loader: "text", contents: await readFile(path, "utf8") }));
  } }] });
  if (!build.success) throw Error(build.logs.map(String).join("\n"));
  const source = await build.outputs[0]!.text();
  if (process.env.PROMISES_EVIDENCE_DIR) {
    await mkdir(process.env.PROMISES_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.PROMISES_EVIDENCE_DIR, "worker-frozen.js"), source);
    const map = build.outputs.find(output => output.kind === "sourcemap");
    if (map) await writeFile(join(process.env.PROMISES_EVIDENCE_DIR, "worker-frozen.js.map"), await map.text());
  }
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  const directory = await mkdtemp("/tmp/promises-worker-");
  let db = new Database(join(directory, "account.sqlite")), account: any;
  const registryDb = new Database(":memory:"), work = new Set<Promise<unknown>>();
  const savedFetch = globalThis.fetch;
  let externalCalls = 0, modelCalls = 0, segments = 0;
  globalThis.fetch = Object.assign(async () => { externalCalls++; throw Error("Promise fixture forbids all external network"); }, { preconnect: () => { throw Error("No provider preconnect"); } });
  try {
    const module = await import(moduleUrl);
    const owner = "123", thread = "user-123", token = "promise-owner-synthetic-123456789012345", readonly = "promise-readonly-synthetic-123456789012345", operator = "promise-operator-synthetic-123456789012345";
    const id = (name: string) => ({ name, equals: (other: any) => name === other?.name, toString: () => name });
    const env: any = { AIKO_MODE: "live", AIKO_CODE_MODE: "true", AIKO_INSTANCE_ID: "promise-host", AIKO_REPLY_STYLE: "direct", AIKO_VOICE_ENABLED: "false", AIKO_ALLOWED_USERS: owner,
      CODEGRAFF_API_KEY: "promise-fixture-not-a-real-key", AIKO_OPERATOR_TOKEN: operator,
      AIKO_PLANE_CREDENTIALS: JSON.stringify([{ account: owner, digest: credentialDigest(token), scopes: ["read", "write"] }, { account: owner, digest: credentialDigest(readonly), scopes: ["read"] }]),
      AIKO_MODEL_FETCH: async () => { modelCalls++; throw Error("Frozen promise must not invoke inference"); },
      AIKO_REGISTRY_SANDBOX: () => ({ placement: "local", codeTransport: async (...args: Parameters<typeof runCodeSegment>) => { segments++; return runCodeSegment(...args); }, sandbox: { harnessEnvironment: async () => "sha256:" + "a".repeat(64), harnessJob: async () => { throw Error("No job execution in review fixture"); } } }),
    };
    const context = () => ({ id: id(module.accountObjectName(owner)), storage: storageFor(db), waitUntil: (promise: Promise<unknown>) => { work.add(promise); void promise.finally(() => work.delete(promise)); }, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn() });
    env.AIKO_ACCOUNTS = { idFromName: id, getByName: (name: string) => { if (name !== module.accountObjectName(owner)) throw Error("Foreign account"); return account; } };
    env.AIKO_REGISTRY = { getByName: () => registry };
    const registry = new module.AikoRegistryDO({ storage: storageFor(registryDb) }, env);
    account = new module.AikoAccountDO(context(), env);
    const request = (path: string, body?: unknown, bearer = token, origin?: string) => module.default.fetch(new Request("https://fixture.invalid" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(origin ? { origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    expect((await request("/api/promises", undefined, "invalid")).status).toBe(401);
    expect((await request("/api/promises/decision", {}, readonly)).status).toBe(403);
    expect((await request("/api/promises")).status).toBe(200);
    const host = (await account.runtime).host;
    const log = withWatermark({ read: Effect.promise(() => host.read(thread)), append: events => Effect.promise(async () => { for (const event of events) await host.commitRoot(host.self(thread), event); }) });
    const prepared = await Effect.runPromise(createPromises({ owner, thread }).prepare({ payload: { kind: "harness", segment: { version: 1, code: 'await tools.call({name:"promise_list",arguments:{}}); return finalPayload.text;', packages: { tools: ["call"] }, values: { finalPayload: { text: "Final ThinkFeel text, frozen before human consent" } }, ambient: { at: Date.now(), seed: "owner-intent" }, history: [] } }, when: { kind: "approval" } }).pipe(Effect.provideService(EventLog, log)));
    const review = (await (await request("/api/promises", undefined, readonly)).json()).promises[0];
    expect(review.hash).toBe(prepared.hash); expect(review.payload.segment.values.finalPayload.text).toBe("Final ThinkFeel text, frozen before human consent");
    expect(segments).toBe(0);
    const body = { id: review.id, hash: review.hash, decision: "approve" };
    expect((await request("/api/promises/decision", { ...body, hash: "changed" })).status).toBe(409);
    expect((await request("/api/promises/decision", body, token, "https://foreign.invalid")).status).toBe(403);
    expect((await request("/api/promises/decision", body)).status).toBe(200);
    await account.alarm(); await Promise.allSettled([...work]);
    const after = (await (await request("/api/promises")).json()).promises[0];
    expect(after).toMatchObject({ state: "settled", outcome: "succeeded", hash: review.hash });
    const rows = await host.read(thread);
    expect(rows.filter((e: any) => e.type === "CodeDispatched")).toHaveLength(1);
    expect(rows.filter((e: any) => e.type === "PackageCalled")).toHaveLength(1);
    expect(rows.filter((e: any) => e.type === "AikoCodeToolSettled")).toHaveLength(1);
    expect(segments).toBeGreaterThan(1); const before = segments;
    await host.close(); await Promise.allSettled([...work]); db.close(); db = new Database(join(directory, "account.sqlite")); account = new module.AikoAccountDO(context(), env);
    expect((await request("/api/promises/decision", body)).status).toBe(200);
    await account.alarm(); await Promise.allSettled([...work]);
    expect(segments).toBe(before); expect(modelCalls).toBe(0); expect(externalCalls).toBe(0);
    expect((await (await request("/v1/promises")).json()).promises[0].state).toBe("settled");
    expect((await request("/api/promises", undefined, operator)).status).toBe(403);
  } finally {
    await (await account?.runtime)?.host.close(); await Promise.allSettled([...work]); globalThis.fetch = savedFetch;
    db.close(); registryDb.close(); URL.revokeObjectURL(moduleUrl); await rm(directory, { recursive: true, force: true });
  }
}, 30000);
