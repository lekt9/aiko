import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { serialize, deserialize } from "node:v8";
import { credentialDigest } from "../src/plane-auth.ts";

/** Only Cloudflare's platform primitives are adapted; the Worker router,
 * account host, actor component, custody, and database API are production code. */
function storageFor(db: Database): any {
  db.exec("CREATE TABLE IF NOT EXISTS fixture_kv(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  const get = async (key: string) => { const row = db.query("SELECT value FROM fixture_kv WHERE key=?").get(key) as { value: Uint8Array } | null; return row ? deserialize(row.value) : undefined; };
  const put = async (key: string, value: unknown) => { db.query("INSERT OR REPLACE INTO fixture_kv VALUES(?,?)").run(key, serialize(value)); };
  let tail: Promise<unknown> = Promise.resolve();
  const storage: any = { get, put,
    delete: async (key: string) => { db.query("DELETE FROM fixture_kv WHERE key=?").run(key); },
    list: async ({ prefix = "" } = {}) => new Map((db.query("SELECT key,value FROM fixture_kv WHERE key LIKE ? ORDER BY key").all(prefix + "%") as { key: string; value: Uint8Array }[]).map(row => [row.key, deserialize(row.value)])),
    sql: { exec: (sql: string, ...args: any[]) => { const rows = db.query(sql).all(...args.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v)); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } },
    transactionSync: (fn: () => unknown) => db.transaction(fn)(),
    transaction: (fn: (tx: any) => Promise<unknown>) => {
      const next = tail.then(async () => { db.exec("SAVEPOINT fixture_atomic"); try { const value = await fn(storage); db.exec("RELEASE fixture_atomic"); return value; } catch (e) { db.exec("ROLLBACK TO fixture_atomic"); db.exec("RELEASE fixture_atomic"); throw e; } });
      tail = next.catch(() => undefined); return next;
    },
    getAlarm: async () => (await get("fixture:alarm")) ?? null,
    setAlarm: (at: number | Date) => put("fixture:alarm", Number(at)),
    deleteAlarm: () => storage.delete("fixture:alarm"), sync: async () => {},
  };
  return storage;
}
test("production Worker admits database commands, drives native effects and reopens scoped state", async () => {
  const installed = new Map(["effect", "zod"].map(name => [name, Bun.resolveSync(name, new URL(`../../../packages/${name === "effect" ? "browser-harness" : "protocol"}/`, import.meta.url).pathname)]));
  const build = await Bun.build({ entrypoints: [new URL("../src/cloudflare.ts", import.meta.url).pathname], target: "bun", format: "esm", conditions: ["workerd"], external: ["node:*"],
    plugins: [{ name: "database-worker-platform", setup(builder) {
      // Bun's build resolver can miss workspace package symlinks in a cold test
      // process. Resolve these actual installed packages; no library is mocked.
      builder.onResolve({ filter: /^(effect|zod)$/ }, ({ path }) => ({ path: installed.get(path)! }));
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers", namespace: "platform" }));
      builder.onLoad({ filter: /.*/, namespace: "platform" }, () => ({ loader: "js", contents: "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }" }));
      builder.onLoad({ filter: /\.(sh|py|txt)$/ }, async ({ path }) => ({ loader: "text", contents: await readFile(path, "utf8") }));
    } }],
  });
  if (!build.success) throw Error(build.logs.map(String).join("\n"));
  const moduleUrl = URL.createObjectURL(new Blob([await build.outputs[0]!.text()], { type: "application/javascript" }));
  const directory = await mkdtemp("/tmp/database-worker-");
  let db = new Database(join(directory, "account.sqlite")), account: any;
  const registryDb = new Database(":memory:");
  const work = new Set<Promise<unknown>>();
  try {
    const module = await import(moduleUrl);
    const owner = "123", token = "database-worker-owner-token-123456789", readToken = "database-worker-readonly-123456789";
    const id = (name: string) => ({ name, equals: (other: any) => name === other?.name, toString: () => name });
    const env: any = { AIKO_MODE: "demo", AIKO_ALLOWED_USERS: owner, AIKO_VOICE_ENABLED: "false", AIKO_REPLY_STYLE: "direct", AIKO_OPERATOR_TOKEN: "database-worker-operator-123456789",
      AIKO_PLANE_CREDENTIALS: JSON.stringify([{ account: owner, digest: credentialDigest(token), scopes: ["read", "write"] }, { account: owner, digest: credentialDigest(readToken), scopes: ["read"] }]),
    };
    const context = () => ({ id: id(module.accountObjectName(owner)), storage: storageFor(db), waitUntil: (promise: Promise<unknown>) => { work.add(promise); void promise.finally(() => work.delete(promise)); }, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn() });
    env.AIKO_ACCOUNTS = { idFromName: id, getByName: (name: string) => { if (name !== module.accountObjectName(owner)) throw Error("Foreign account"); return account; } };
    const registry = new module.AikoRegistryDO({ storage: storageFor(registryDb) }, env);
    env.AIKO_REGISTRY = { getByName: () => registry };
    account = new module.AikoAccountDO(context(), env);
    const request = (path: string, body?: unknown, bearer = token) => module.default.fetch(new Request("https://fixture.invalid/api/databases" + path, {
      method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    const command = async (key: string, command: unknown) => {
      const response = await request("/commands", { idempotencyKey: key, command }); expect([200, 202]).toContain(response.status);
      const admitted = await response.json(); expect(typeof admitted.operationId).toBe("string"); await account.alarm();
      const state = await request(`/operations/${admitted.operationId}`); const operation = await state.json();
      expect({ status: state.status, error: operation.error }).toEqual({ status: 200, error: undefined }); expect(operation.status).toBe("committed"); return operation;
    };
    expect((await request("", undefined, "wrong")).status).toBe(401);
    expect((await request("/commands", {}, readToken)).status).toBe(403);
    await command("database", { kind: "database.create", database: { id: "work", name: "Work", lifecycle: "visible" } });
    await command("table", { kind: "table.define", expectedRevision: 0, table: { id: "projects", databaseId: "work", name: "Projects", mode: "stored", columns: [{ id: "name", name: "Name", type: "text" }] } });
    const rows = { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 0, values: { name: "WORKER_PRIVATE_ROW_CANARY" } }] };
    const committed = await command("rows", rows);
    await command("view", { kind: "view.save", expectedRevision: 0, view: { id: "projects-view", title: "Projects", layout: "table", query: { tableId: "projects" } } });
    await command("snapshot", { kind: "artifact.create", artifactId: "projects-snapshot", viewId: "projects-view", viewRevision: 1, title: "Projects snapshot", dataMode: "snapshot" });
    const snapshot = await request("/artifacts/projects-snapshot", undefined, readToken);
    expect(snapshot.status).toBe(200); expect((await snapshot.json()).result.rows[0].cells.name.value).toBe("WORKER_PRIVATE_ROW_CANARY");
    const read = await request("/query", { query: { tableId: "projects" } }, readToken); expect(read.status).toBe(200); expect((await read.json()).rows[0].cells.name.value).toBe("WORKER_PRIVATE_ROW_CANARY");
    await (await account.runtime).host.close(); await Promise.allSettled([...work]); db.close(); db = new Database(join(directory, "account.sqlite")); account = new module.AikoAccountDO(context(), env);
    expect((await command("rows", rows)).receipt).toEqual(committed.receipt);
    expect((await request("/artifacts/projects-snapshot", undefined, readToken)).status).toBe(200);
    expect(JSON.stringify(db.query("SELECT event FROM aiko_thread_events").all())).not.toContain("WORKER_PRIVATE_ROW_CANARY");
    env.AIKO_DATABASES = "false";
    expect((await request("/commands", { idempotencyKey: "disabled", command: rows })).status).toBe(403);
    expect((await request("/query", { query: { tableId: "projects" } }, readToken)).status).toBe(200);
  } finally {
    await (await account?.runtime)?.host.close(); await Promise.allSettled([...work]); db.close(); registryDb.close(); URL.revokeObjectURL(moduleUrl); await rm(directory, { recursive: true, force: true });
  }
}, 30000);
