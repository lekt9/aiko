import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { serialize, deserialize } from "node:v8";
import { credentialDigest } from "../src/plane-auth.ts";
import { Memory, cloudflareStorage } from "entity-learn/cloudflare";
import { stagedEntityTables, stagedEntityRefresh } from "./database-refresh.fixture.ts";

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
    sql: { exec: (sql: string, ...args: any[]) => {
      // https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec
      // Schema batches execute in full, as Cloudflare SQL does.
      const rows = sql.trimStart().startsWith("CREATE") ? (db.exec(sql), []) : db.query(sql).all(...args.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v));
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
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
  const installed = new Map(["effect", "zod"].map(name => [name, Bun.resolveSync(name, new URL("../", import.meta.url).pathname)]));
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
    await command("board-view", { kind: "view.save", expectedRevision: 0, view: { id: "projects-board", title: "Projects board", layout: "board", groupField: "name", titleField: "name", query: { tableId: "projects" } } });
    await command("board-artifact", { kind: "artifact.create", artifactId: "projects-board", viewId: "projects-board", viewRevision: 1, title: "Projects board", dataMode: "live" });
    await command("snapshot", { kind: "artifact.create", artifactId: "projects-snapshot", viewId: "projects-view", viewRevision: 1, title: "Projects snapshot", dataMode: "snapshot" });
    const snapshot = await request("/artifacts/projects-snapshot", undefined, readToken);
    expect(snapshot.status).toBe(200); expect((await snapshot.json()).result.rows[0].cells.name.value).toBe("WORKER_PRIVATE_ROW_CANARY");
    const read = await request("/query", { query: { tableId: "projects" } }, readToken); expect(read.status).toBe(200); expect((await read.json()).rows[0].cells.name.value).toBe("WORKER_PRIVATE_ROW_CANARY");
    const memory = new Memory({ scope: `aiko:${owner}`, storage: cloudflareStorage(storageFor(db)) });
    const directoryEvidence = memory.remember({ subject: "refresh/directory", title: "Directory", type: "directory", payload: { company: "acme" } }, { key: "refresh-directory", producer: { kind: "user", reference: "fixture" } });
    memory.remember({ subject: "refresh/companies/acme", title: "Company", type: "company", payload: { tier: "WORKER_STAGED_PRIVATE_TIER" } }, { key: "refresh-company", producer: { kind: "user", reference: "fixture" } });
    for (const [index, seed] of stagedEntityTables("work").entries()) await command(`staged-seed-${index}`, seed);
    const staged = await command("staged-refresh", stagedEntityRefresh);
    expect(staged.receipt.result).toMatchObject({ coverage: "complete", plannedStages: 2, stages: 2, committed: 2, groups: 2, calls: 0, budgetAccounting: "measured" });
    const stagedQuery = { tableId: "refresh-projects", select: ["tier"] };
    expect((await (await request("/query", { query: stagedQuery }, readToken)).json()).rows.map((row: any) => row.cells.tier.value)).toEqual(["WORKER_STAGED_PRIVATE_TIER", "WORKER_STAGED_PRIVATE_TIER"]);
    await command("staged-view", { kind: "view.save", expectedRevision: 0, view: { id: "staged-view", title: "Tiers", query: stagedQuery, layout: "table" } });
    await command("staged-snapshot", { kind: "artifact.create", artifactId: "staged-snapshot", title: "Tiers", viewId: "staged-view", viewRevision: 1, dataMode: "snapshot" });
    const person = memory.remember({ subject: "people/maya", title: "Maya", type: "person", payload: { name: "WORKER_ENTITY_PRIVATE_VALUE" } }, { key: "entity-person", producer: { kind: "user", reference: "fixture:user" } });
    await command("entity-table", { kind: "table.define", expectedRevision: 0, table: { id: "people", databaseId: "work", name: "People", mode: "stored", columns: [{ id: "name", name: "Name", type: "text", binding: { kind: "entity", subject: person.subject, path: "/name", retention: "materialized" } }] } });
    await command("entity-row", { kind: "rows.upsert", tableId: "people", rows: [{ id: "maya", expectedRevision: 0, values: {} }] });
    const refreshed = await command("entity-refresh", { kind: "table.refresh", tableId: "people" });
    expect(refreshed.receipt.result).toMatchObject({ calls: 0, coverage: "complete" });
    const entityQuery = () => request("/query", { query: { tableId: "people" } }, readToken);
    expect((await (await entityQuery()).json()).rows[0].cells.name.value).toBe("WORKER_ENTITY_PRIVATE_VALUE");
    await command("project-mapping", { kind: "mapping.define", expectedRevision: 0, expectedRowRevision: 1, mapping: { id: "project-memory", tableId: "projects", rowId: "p1", subject: "projects/one", fields: [{ columnId: "name", path: "/name", authority: "table" }] } });
    const publication = await command("project-publish", { kind: "mapping.promote", mappingId: "project-memory", expectedMappingRevision: 1, expectedRowRevision: 2, expectedObservationId: null, title: "Project", type: "project" });
    expect(memory.get(publication.receipt.result.observationId)?.observation.payload).toEqual({ name: "WORKER_PRIVATE_ROW_CANARY" });
    await command("person-mapping", { kind: "mapping.define", expectedRevision: 0, expectedRowRevision: 1, mapping: { id: "person-memory", tableId: "people", rowId: "maya", subject: person.subject, fields: [{ columnId: "name", path: "/name", authority: "entity" }] } });
    const fieldInput = { tableId: "people", rowId: "maya", columnId: "name" };
    const readonlyField = await request("/field", fieldInput, readToken);
    expect(readonlyField.status).toBe(200);
    expect((await readonlyField.json()).memory).toMatchObject({ observationId: person.id, current: { value: "WORKER_ENTITY_PRIVATE_VALUE" }, canCorrect: false });
    expect((await (await request("/field", fieldInput)).json()).memory.canCorrect).toBe(true);
    const correctionCommand = { kind: "mapping.correct", mappingId: "person-memory", expectedMappingRevision: 1, expectedRowRevision: 2, expectedObservationId: person.id, values: { name: "WORKER_CORRECTION_PRIVATE_VALUE" } };
    const correction = await command("person-correct", correctionCommand);
    expect(correction.receipt.result).toMatchObject({ appliedToMemory: true, projectionUpdated: true, baselineUpdated: true });
    expect(memory.get(correction.receipt.result.observationId)?.observation.payload).toEqual({ name: "WORKER_CORRECTION_PRIVATE_VALUE" });
    expect((await (await entityQuery()).json()).rows[0].cells.name.value).toBe("WORKER_CORRECTION_PRIVATE_VALUE");
    memory.close();
    await (await account.runtime).host.close(); await Promise.allSettled([...work]); db.close(); db = new Database(join(directory, "account.sqlite")); account = new module.AikoAccountDO(context(), env);
    expect((await command("rows", rows)).receipt).toEqual(committed.receipt);
    expect((await command("staged-refresh", stagedEntityRefresh)).receipt).toEqual(staged.receipt);
    expect((await request("/artifacts/staged-snapshot", undefined, readToken)).status).toBe(200);
    expect(JSON.stringify(db.query("SELECT event FROM aiko_thread_events").all())).not.toContain("WORKER_STAGED_PRIVATE_TIER");
    expect((await request("/artifacts/projects-snapshot", undefined, readToken)).status).toBe(200);
    const board = await (await request("/artifacts/projects-board", undefined, readToken)).json();
    expect(board.view).toMatchObject({ layout: "board", groupField: "name", titleField: "name" });
    expect(board.result.capabilities).toMatchObject({ write: false, saveView: false, createRows: false });
    expect(board.result.capabilities.records.p1.editFields).toEqual([]);
    expect((await (await request("/artifacts/projects-board")).json()).result.capabilities.records.p1.editFields).toEqual(["name"]);
    expect((await (await entityQuery()).json()).capabilities.records.maya).toMatchObject({ editFields: [], reviewMemoryFields: ["name"] });
    expect((await (await entityQuery()).json()).rows[0].cells.name.value).toBe("WORKER_CORRECTION_PRIVATE_VALUE");
    expect((await command("person-correct", correctionCommand)).receipt).toEqual(correction.receipt);
    const reopenedMemory = new Memory({ scope: `aiko:${owner}`, storage: cloudflareStorage(storageFor(db)) });
    reopenedMemory.forget(directoryEvidence.subject, directoryEvidence.id, "forget-refresh-directory");
    expect((await request("/query", { query: stagedQuery }, readToken)).status).toBe(403);
    expect((await request("/artifacts/staged-snapshot", undefined, readToken)).status).toBe(403);
    reopenedMemory.forget(person.subject, correction.receipt.result.observationId, "forget-person"); reopenedMemory.close();
    expect((await entityQuery()).status).toBe(403);
    expect((await request("/field", fieldInput, readToken)).status).toBe(403);
    expect(JSON.stringify(db.query("SELECT event FROM aiko_thread_events").all())).not.toContain("WORKER_PRIVATE_ROW_CANARY");
    expect(JSON.stringify(db.query("SELECT event FROM aiko_thread_events").all())).not.toContain("WORKER_ENTITY_PRIVATE_VALUE");
    expect(JSON.stringify(db.query("SELECT event FROM aiko_thread_events").all())).not.toContain("WORKER_CORRECTION_PRIVATE_VALUE");
    env.AIKO_DATABASES = "false";
    expect((await request("/commands", { idempotencyKey: "disabled", command: rows })).status).toBe(403);
    expect((await request("/query", { query: { tableId: "projects" } }, readToken)).status).toBe(200);
  } finally {
    await (await account?.runtime)?.host.close(); await Promise.allSettled([...work]); db.close(); registryDb.close(); URL.revokeObjectURL(moduleUrl); await rm(directory, { recursive: true, force: true });
  }
}, 30000);
