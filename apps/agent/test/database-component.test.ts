import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { StructuredStore, type Binding, type Command, type Storage } from "../../../packages/structured-data/src/index.ts";
import { databaseComponent, databaseEventKey, databaseExternalEventAllowed, databaseState, prepareDatabaseCommand, type DatabaseBinding } from "../src/database-component.ts";
import { readDatabaseValue } from "../src/database.ts";
import { executeDatabaseRefresh } from "../src/database-refresh.ts";
import { executeDatabaseRefreshGraph } from "../src/database-refresh-graph.ts";
import { BrowserLearning } from "../src/browser-learning.ts";
import { ownedNetworkDefinitions } from "../src/capability-builder-network.ts";
import { resolveObservedRead } from "../src/observed-network.ts";
import { browserTraceKeys } from "@unbrowse/browser-harness/trace";
import { harKeys } from "@unbrowse/browser-harness/network-facts";
import { requestMemoryEventKey } from "../src/request-memory-events.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = await mkdtemp("/tmp/aiko-native-databases-");
  const db = new Database(join(dir, "structured.sqlite"));
  const storage: Storage = { exec: sql => { db.exec(sql); }, prepare: sql => db.query(sql) as ReturnType<Storage["prepare"]>, transaction: run => db.transaction(run)(), read: run => db.transaction(run)() };
  let now = 1000;
  const store = new StructuredStore(storage, "alice", { now: () => now });
  db.exec("CREATE TABLE private_commands(owner TEXT, ref TEXT, body TEXT, PRIMARY KEY(owner,ref))");
  let allowed = true;
  const binding: DatabaseBinding = { owner: "alice", thread: "user-alice", store, now: () => now, authorize: async () => allowed,
    custody: {
      put: async (owner, value) => { const encoded = JSON.stringify(value), ref = createHash("sha256").update(owner + encoded).digest("hex"); db.query("INSERT OR IGNORE INTO private_commands VALUES (?,?,?)").run(owner, ref, encoded); return ref; },
      get: async (owner, ref) => { const found = db.query("SELECT body FROM private_commands WHERE owner=? AND ref=?").get(owner, ref) as { body: string } | null; if (!found) throw Error("Unavailable"); return JSON.parse(found.body); },
    },
  };
  const definition = actor({ name: "aiko", methods: {}, components: [databaseComponent(binding)] });
  const options = { database: join(dir, "actor.sqlite"), actorName: "aiko", actorInstance: "test", keyOf: (event: import("tardie/core/event").Event) => databaseEventKey(event) ?? browserTraceKeys.keyOf(event) ?? harKeys.keyOf(event) ?? requestMemoryEventKey(event), actorFor: (thread: string) => thread === binding.thread ? definition : undefined };
  let host = await createBunHost(options);
  cleanups.push(async () => { await host.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  const prepare = (id: string, command: Command) => prepareDatabaseCommand(binding, { operationId: id, command, producer: "user:alice", cause: "task" }, new AbortController().signal);
  return { store, binding, prepare, db, advance: (milliseconds: number) => { now += milliseconds; }, allow: (value: boolean) => { allowed = value; },
    admit: async (event: import("tardie/core/event").Event) => { await host.commitRoot(host.self(binding.thread), event); },
    drive: () => host.wake(binding.thread),
    events: () => host.read(binding.thread),
    reopen: async () => { await host.close(); host = await createBunHost(options); },
    cancel: async (id: string) => { await host.commitRoot(host.self(binding.thread), { type: "AikoDatabaseOperationCancelled", id, owner: binding.owner, thread: binding.thread, at: 1001 }); },
  };
}
const command: Command = { kind: "database.create", database: { id: "launch", name: "Private project canary", lifecycle: "visible" } };

test("native component executes a sealed command and reopens without duplicate revisions", async () => {
  const f = await fixture(), request = await f.prepare("create", command);
  await f.admit(request); await f.drive();
  expect(f.store.database("launch").revision).toBe(1);
  const events = await f.events();
  expect(databaseState(events, f.binding).get("create")?.status).toBe("committed");
  expect(JSON.stringify(events)).not.toContain("Private project canary");
  await f.reopen(); await f.admit(request); await f.drive();
  expect(f.store.database("launch").revision).toBe(1);
  expect((await f.events()).filter(e => e.type === "AikoDatabaseOperationSettled")).toHaveLength(1);
});

test("native recovery reconciles a committed store receipt with an unsettled event log", async () => {
  const f = await fixture(), request = await f.prepare("create", command);
  await f.admit(request);
  // The actual crash boundary: the domain transaction committed, the native effect receipt did not.
  const committed = f.store.execute("create", command, { at: request.at, producer: "user:alice" });
  expect((await f.events()).some(e => e.type === "AikoDatabaseOperationSettled")).toBe(false);
  await f.reopen(); await f.drive();
  const state = databaseState(await f.events(), f.binding).get("create");
  expect(state?.status).toBe("committed"); expect(state?.revision).toBe(committed.revision);
  expect(f.store.revision()).toBe(1);
});

test("revoked authority and cancellation settle without executing pending commands", async () => {
  const f = await fixture(); await f.admit(await f.prepare("revoked", command)); f.allow(false); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("revoked")?.status).toBe("rejected");
  expect(f.store.receipt("revoked")).toBeUndefined();
  f.allow(true); await f.admit(await f.prepare("cancel", command)); await f.cancel("cancel"); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("cancel")?.status).toBe("cancelled");
  expect(f.store.receipt("cancel")).toBeUndefined();
});

test("public ingress cannot mint database receipts or host-only wait invocations", () => {
  expect(databaseExternalEventAllowed({ type: "AikoDatabaseOperationSettled", id: "fake" })).toBe(false);
  expect(databaseExternalEventAllowed({ type: "MessageReceived", call: { invocation: { method: "databaseWait" } } })).toBe(false);
  expect(databaseExternalEventAllowed({ type: "MessageReceived", text: "Show my tables" })).toBe(true);
});

async function chainFixture() {
  const f = await fixture(), context = { at: 1000, producer: "fixture" };
  f.store.execute("db", command, context);
  const request = (sourceId: string, field?: string): Extract<Binding, { kind: "request" }> => ({ kind: "request" as const, sourceId, contractDigest: sourceId, inputs: field ? { key: { rowField: field } } : {}, select: { stepId: "read", jsonPointer: "/value" }, refresh: { mode: "on-demand" as const, maxAgeSeconds: 60 }, retention: "materialized" as const });
  f.store.execute("table", { kind: "table.define", expectedRevision: 0, table: { id: "items", databaseId: "launch", name: "Items", mode: "stored", columns: [
    { id: "account", name: "Account", type: "text", binding: request("account") },
    { id: "key", name: "Key", type: "text", binding: { kind: "formula", expression: { op: "concat", args: [{ literal: "customer/" }, { field: "account" }] } } },
    { id: "balance", name: "Balance", type: "integer", binding: request("balance", "key") },
  ] } }, context);
  f.store.execute("rows", { kind: "rows.upsert", tableId: "items", rows: ["one", "two"].map(id => ({ id, expectedRevision: 0, values: {} })) }, context);
  const calls: string[] = [], budgets: { maxCalls: number; maxBytes: number }[] = [];
  f.binding.sources = async id => ({ digest: id, generation: "generation:1", stepIds: ["read"], inputs: id === "balance" ? [{ name: "key", type: "string", required: true }] : [], execute: async (input, consume, _signal, budget) => {
    calls.push(id); budgets.push(budget);
    if (id === "balance") expect(input).toEqual({ key: "customer/42" });
    consume("read", { value: id === "account" ? "42" : 27 }); return { calls: 1, bytes: 20 };
  } });
  const refresh: Extract<Command, { kind: "table.refresh" }> = { kind: "table.refresh", tableId: "items", columnIds: ["balance"], budget: { maxCalls: 2, maxBytes: 2048 } };
  return { ...f, calls, budgets, refresh, context, request };
}

test("native refresh hydrates requested source prerequisites through formulas and shares one budget", async () => {
  const f = await chainFixture();
  await f.admit(await f.prepare("chain", f.refresh)); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("chain")?.status).toBe("committed");
  expect(f.store.receipt("chain")?.result).toMatchObject({ coverage: "complete", plannedStages: 2, stages: 2, calls: 2, bytes: 40, groups: 2 });
  expect(f.calls).toEqual(["account", "balance"]); expect(f.budgets).toEqual([{ maxCalls: 2, maxBytes: 2048 }, { maxCalls: 1, maxBytes: 2028 }]);
  expect(f.store.query({ tableId: "items" }).rows.map(row => row.cells.balance?.value)).toEqual([27, 27]);
  const events = await f.events(); expect(JSON.stringify(events)).not.toContain("customer/42");
  expect(events.filter(event => event.type === "AikoDatabaseRefreshGraphPlanned")).toHaveLength(1);
  await f.reopen(); await f.drive(); expect(f.calls).toHaveLength(2);
});

test("native staged refresh executes the actual learned Merkle read adapter with a synthetic transport", async () => {
  const f = await chainFixture(), contracts: ReturnType<typeof ownedNetworkDefinitions> = [];
  for (const name of ["account", "balance"]) {
    const events: import("tardie/core/event").Event[] = []; let sequence = 0;
    const learning = new BrowserLearning({ threadId: `fixture-${name}`, nextSequence: () => ++sequence, emit: async event => { events.push(event); } });
    const entry = { startedDateTime: new Date(1000).toISOString(), time: 20, _observationComplete: true,
      request: { method: "GET", url: `https://${name}.example.com/items`, headers: [], cookies: [] },
      response: { status: 200, headers: [], cookies: [], content: { mimeType: "application/json", size: 12, text: '{"value":0}' } } };
    await learning.observe(entry, 0, true);
    await learning.compile([entry], [{ callId: "fixture", action: "navigate", startedAtMs: 999, endedAtMs: 1050, direct: true, resultObserved: true }], `https://${name}.example.com`);
    const learned = ownedNetworkDefinitions(events)[0]!;
    // Only the native structural read manifest is needed for execution. Newly
    // emitted optional endpoint descriptions have separate browser-host ownership.
    for (const event of [...events.filter(event => event.type !== "AikoObservedEndpointDescribed"), { type: "AikoRequestMemoryIndexed", id: crypto.randomUUID(), toolDigest: learned.toolDigest, owner: f.binding.owner, pointerId: `obs_${"a".repeat(64)}`, model: "fixture" }]) await f.admit({ ...event, at: 2000 });
    contracts.push(learned);
  }
  const requests: string[] = [], failures: string[] = [];
  f.binding.sources = async (sourceId, digest, signal) => {
    expect(sourceId).toBe(digest);
    const resolved = await resolveObservedRead({ owner: f.binding.owner, thread: f.binding.thread, redact: text => text, readEvents: f.events, checkArcade: async () => true,
      send: async request => {
        requests.push(request.url);
        return { status: 200, headers: { "content-type": "application/json" }, classification: "application", body: { value: new URL(request.url).hostname.startsWith("account.") ? "42" : 27, ignored: "UNSELECTED_LEARNED_RESPONSE" } };
      },
    }, digest, signal);
    return { ...resolved, execute: async (...args) => { try { return await resolved.execute(...args); } catch (error) { failures.push(String(error)); throw error; } } };
  };
  const table = f.store.table("items");
  f.store.execute("learned-bindings", { kind: "table.define", expectedRevision: table.revision, table: { ...table.value, columns: table.value.columns.map(column => {
    if (column.binding?.kind !== "request") return column;
    const learned = contracts[column.id === "account" ? 0 : 1]!;
    return { ...column, binding: { ...column.binding, sourceId: learned.toolDigest, contractDigest: learned.toolDigest,
      inputs: Object.fromEntries(learned.definition.inputs.map(input => [input.name, column.id === "account" ? { literal: "items" } : { rowField: "key" }])),
      select: { stepId: learned.definition.steps[0]!.id, jsonPointer: "/value" },
    } };
  }) } }, f.context);
  await f.admit(await f.prepare("learned-chain", f.refresh)); await f.drive();
  expect(failures).toEqual([]);
  expect(f.store.receipt("learned-chain")?.result).toMatchObject({ coverage: "complete", calls: 2, committed: 2, groups: 2 });
  expect(requests).toHaveLength(2); expect(requests[1]).toContain("customer");
  expect(f.store.query({ tableId: "items" }).rows.map(row => row.cells.balance?.value)).toEqual([27, 27]);
  expect(JSON.stringify(await f.events())).not.toContain("UNSELECTED_LEARNED_RESPONSE");
  expect(JSON.stringify(f.db.query("SELECT * FROM private_commands").all())).not.toContain("UNSELECTED_LEARNED_RESPONSE");
  await f.reopen(); await f.drive(); expect(requests).toHaveLength(2);
});

test("staged refresh resumes a group commit after interruption without refetching its prerequisite", async () => {
  const f = await chainFixture(), request = await f.prepare("chain-recovery", f.refresh), events: import("tardie/core/event").Event[] = [];
  const journal = { read: async () => events, append: async (rows: typeof events) => { if (rows.some(row => row.type === "AikoDatabaseRefreshGroupSettled")) throw Error("process loss"); events.push(...rows); } };
  await expect(executeDatabaseRefreshGraph(f.binding, request, f.refresh, journal, new AbortController().signal)).rejects.toThrow("process loss");
  expect(f.calls).toEqual(["account"]);
  const recovered = await executeDatabaseRefreshGraph(f.binding, request, f.refresh, { ...journal, append: async rows => { events.push(...rows); } }, new AbortController().signal);
  expect(recovered.result).toMatchObject({ coverage: "complete", calls: 2, stages: 2 }); expect(f.calls).toEqual(["account", "balance"]);
});

test("staged refresh reports earlier commits and measured costs when the final stage conflicts", async () => {
  const f = await chainFixture(), resolve = f.binding.sources!;
  f.binding.sources = async (...args) => {
    const source = await resolve(...args);
    return { ...source, execute: async (...args) => {
      const result = await source.execute(...args);
      if (f.calls.at(-1) === "balance") f.store.execute("racing-edit", { kind: "rows.upsert", tableId: "items", rows: [{ id: "one", expectedRevision: 1, values: {} }] }, f.context);
      return result;
    } };
  };
  await f.admit(await f.prepare("partial-conflict", f.refresh)); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("partial-conflict")?.status).toBe("conflict");
  expect(f.store.receipt("partial-conflict")?.result).toMatchObject({ coverage: "partial", reasons: ["conflict"], committed: 1, calls: 2, bytes: 40, budgetAccounting: "measured" });
  expect(f.store.cell("items", "two", "account")?.cell.value).toBe("42");
  expect(f.store.cell("items", "two", "balance")).toBeUndefined();
  const receipt = f.store.receipt("partial-conflict"); await f.reopen(); await f.drive();
  expect(f.store.receipt("partial-conflict")).toEqual(receipt); expect(f.calls).toEqual(["account", "balance"]);
});

for (const stop of ["cancelled", "forbidden"] as const) test(`native staged refresh reconciles a committed group after restart with ${stop}`, async () => {
  const f = await chainFixture(), request = await f.prepare(`stopped-${stop}`, f.refresh);
  await f.admit(request);
  const events = [...await f.events()];
  const journal = { read: async () => events, append: async (rows: typeof events) => {
    if (rows.some(row => row.type === "AikoDatabaseRefreshGroupSettled")) throw Error("process loss");
    events.push(...rows);
  } };
  await expect(executeDatabaseRefreshGraph(f.binding, request, f.refresh, journal, new AbortController().signal)).rejects.toThrow("process loss");
  // Restore the durable plan/start events to the real native journal; no settlement was appended.
  for (const event of events.filter(event => event.type.startsWith("AikoDatabaseRefresh"))) await f.admit(event);
  if (stop === "cancelled") await f.cancel(request.id); else f.allow(false);
  await f.reopen(); await f.drive();
  expect(databaseState(await f.events(), f.binding).get(request.id)?.status).toBe(stop === "cancelled" ? "cancelled" : "rejected");
  expect(f.store.receipt(request.id)?.result).toMatchObject({ coverage: "partial", reasons: [stop], committed: 1, calls: 1, bytes: 20, budgetAccounting: "measured" });
  expect(f.calls).toEqual(["account"]);
  expect(f.store.cell("items", "two", "account")?.cell.value).toBe("42");
  expect(f.store.cell("items", "two", "balance")).toBeUndefined();
});

for (const staged of [false, true]) for (const stop of ["cancelled", "forbidden", "lost-ack"] as const) test(`fully committed ${staged ? "staged" : "flat"} refresh remains complete after ${stop}`, async () => {
  const f = await chainFixture(), refresh = staged ? f.refresh : { ...f.refresh, columnIds: ["account"] };
  const request = await f.prepare(`finished-${staged}-${stop}`, refresh), count = staged ? 2 : 1;
  await f.admit(request);
  if (stop === "lost-ack") {
    const commit = f.store.commitCells.bind(f.store); let committed = 0;
    f.store.commitCells = async (...args) => {
      const receipt = await commit(...args);
      if (++committed === count) throw Error("Final group acknowledgement lost");
      return receipt;
    };
  } else {
    const events = [...await f.events()]; let settled = 0;
    const journal = { read: async () => events, append: async (rows: typeof events) => {
      if (rows.some(row => row.type === "AikoDatabaseRefreshGroupSettled") && ++settled === count) throw Error("process loss");
      events.push(...rows);
    } };
    await expect(executeDatabaseRefreshGraph(f.binding, request, refresh, journal, new AbortController().signal)).rejects.toThrow("process loss");
    for (const event of events.filter(event => event.type.startsWith("AikoDatabaseRefresh"))) await f.admit(event);
    if (stop === "cancelled") await f.cancel(request.id); else f.allow(false);
    await f.reopen();
  }
  await f.drive();
  expect(databaseState(await f.events(), f.binding).get(request.id)?.status).toBe("committed");
  expect(f.store.receipt(request.id)?.result).toMatchObject({ coverage: "complete", reasons: [], committed: count, calls: count, bytes: count * 20, budgetAccounting: "measured" });
  expect(f.calls).toEqual(staged ? ["account", "balance"] : ["account"]);
  const receipt = f.store.receipt(request.id);
  await f.reopen(); await f.drive();
  expect(f.store.receipt(request.id)).toEqual(receipt); expect(f.calls).toHaveLength(count);
});

test("native refresh reconciles a lost group acknowledgement without dispatching its dependent stage", async () => {
  const f = await chainFixture(), commit = f.store.commitCells.bind(f.store); let lost = false;
  f.store.commitCells = async (...args) => {
    const receipt = await commit(...args);
    if (!lost) { lost = true; throw Error("Synthetic lost group acknowledgement"); }
    return receipt;
  };
  await f.admit(await f.prepare("lost-group-ack", f.refresh)); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("lost-group-ack")?.status).toBe("unavailable");
  expect(f.store.receipt("lost-group-ack")?.result).toMatchObject({ coverage: "partial", committed: 1, calls: 1, bytes: 20, reasons: ["unavailable"] });
  expect(f.calls).toEqual(["account"]);
  await f.reopen(); await f.drive(); expect(f.calls).toEqual(["account"]);
});

test("an unavailable later contract still discloses earlier committed checks", async () => {
  const f = await chainFixture(), resolve = f.binding.sources!;
  f.binding.sources = async (...args) => { if (args[0] === "balance") throw Error("Source contract no longer available"); return resolve(...args); };
  await f.admit(await f.prepare("removed-contract", f.refresh)); await f.drive();
  expect(f.store.receipt("removed-contract")?.result).toMatchObject({ coverage: "partial", committed: 1, calls: 1, bytes: 20, reasons: ["unavailable"] });
  expect(f.calls).toEqual(["account"]);
});

test("revoked target-field access fences a later selected-cell commit", async () => {
  const f = await chainFixture(), resolve = f.binding.sources!;
  f.binding.sources = async (...args) => {
    const source = await resolve(...args);
    return { ...source, execute: async (...input) => {
      const result = await source.execute(...input);
      if (args[0] === "balance") f.store.options.canRead = (_table, field) => field !== "balance";
      return result;
    } };
  };
  await f.admit(await f.prepare("revoked-field", f.refresh)); await f.drive();
  expect(f.store.receipt("revoked-field")?.result).toMatchObject({ coverage: "partial", committed: 1, calls: 2, bytes: 40, reasons: ["forbidden"] });
  f.store.options.canRead = undefined;
  expect(f.store.cell("items", "one", "balance")).toBeUndefined();
  expect(f.store.cell("items", "one", "account")?.cell.value).toBe("42");
});

test("cancellation during selected-cell hashing cannot commit a late value", async () => {
  const f = await chainFixture(), controller = new AbortController(), commit = f.store.commitCells.bind(f.store);
  f.store.commitCells = (...args) => {
    const result = commit(...args);
    controller.abort(); // commitCells yielded for its digest, before its transaction.
    return result;
  };
  const request = await f.prepare("hash-cancel", f.refresh), events: import("tardie/core/event").Event[] = [];
  const receipt = await executeDatabaseRefreshGraph(f.binding, request, f.refresh, { read: async () => events, append: async rows => { events.push(...rows); } }, controller.signal);
  expect(receipt.outcome).toBe("cancelled");
  expect(receipt.result).toMatchObject({ committed: 0, calls: 1, bytes: 20, coverage: "partial" });
  expect(f.store.cell("items", "one", "account")).toBeUndefined();
});

test("staged refresh cannot spend a second budget when the first stage exhausts the occurrence", async () => {
  const f = await chainFixture(), refresh = { ...f.refresh, budget: { maxCalls: 1, maxBytes: 2048 } };
  await f.admit(await f.prepare("chain-budget", refresh)); await f.drive();
  expect(f.calls).toEqual(["account"]); expect(f.store.receipt("chain-budget")?.result).toMatchObject({ coverage: "partial", reasons: ["refresh_budget"], calls: 1, stages: 1 });
  expect(f.store.query({ tableId: "items", select: ["balance"] }).rows[0]?.cells.balance?.state).toBe("unavailable");
});

test("refresh follows a related table source before its dependent request", async () => {
  const f = await chainFixture();
  f.store.execute("related", { kind: "table.define", expectedRevision: 0, table: { id: "related", databaseId: "launch", name: "Related", mode: "stored", columns: [
    { id: "item", name: "Item", type: "relation", relation: { tableId: "items", cardinality: "many-to-one" } },
    { id: "key", name: "Key", type: "text", binding: { kind: "lookup", relation: "item", field: "key", aggregate: "first" } },
    { id: "balance", name: "Balance", type: "integer", binding: f.request("balance", "key") },
  ] } }, f.context);
  f.store.execute("related-row", { kind: "rows.upsert", tableId: "related", rows: [{ id: "related", expectedRevision: 0, values: { item: "one" } }] }, f.context);
  await f.admit(await f.prepare("foreign-chain", { ...f.refresh, tableId: "related" })); await f.drive();
  expect(f.calls).toEqual(["account", "balance"]);
  expect(f.store.receipt("foreign-chain")?.result).toMatchObject({ coverage: "complete", stages: 2 });
  expect(f.store.query({ tableId: "related" }).rows[0]?.cells.balance?.value).toBe(27);
  expect(f.store.cell("items", "two", "account")).toBeUndefined();
});

test("native cancellation during a later read preserves earlier commits and reserves unknown costs", async () => {
  const f = await chainFixture(), resolve = f.binding.sources!;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  f.binding.sources = async (...args) => {
    const source = await resolve(...args);
    return args[0] === "balance" ? { ...source, execute: async () => { f.calls.push("balance"); started(); return new Promise(() => {}); } } : source;
  };
  await f.admit(await f.prepare("cancel-running-chain", f.refresh));
  const driving = f.drive();
  await Promise.race([running, Bun.sleep(2000).then(() => { throw Error("Refresh did not start"); })]);
  await f.cancel("cancel-running-chain"); await driving; await f.drive();
  expect(databaseState(await f.events(), f.binding).get("cancel-running-chain")?.status).toBe("cancelled");
  expect(f.store.receipt("cancel-running-chain")?.result).toMatchObject({ coverage: "partial", committed: 1, calls: 2, bytes: 2048, budgetAccounting: "reserved" });
  expect(f.store.cell("items", "one", "balance")).toBeUndefined();
  await f.reopen(); await f.drive(); expect(f.calls).toEqual(["account", "balance"]);
});

test("staged recovery retains committed groups after the shared deadline expires", async () => {
  const f = await chainFixture(), request = await f.prepare("expired-chain", f.refresh), events: import("tardie/core/event").Event[] = [];
  const journal = { read: async () => events, append: async (rows: typeof events) => {
    if (rows.some(row => row.type === "AikoDatabaseRefreshGroupSettled")) throw Error("process loss");
    events.push(...rows);
  } };
  await expect(executeDatabaseRefreshGraph(f.binding, request, f.refresh, journal, new AbortController().signal)).rejects.toThrow("process loss");
  f.advance(60001);
  const receipt = await executeDatabaseRefreshGraph(f.binding, request, f.refresh, { ...journal, append: async rows => { events.push(...rows); } }, new AbortController().signal);
  expect(receipt.result).toMatchObject({ coverage: "partial", committed: 1, calls: 1, bytes: 20, reasons: ["refresh_budget"] });
  expect(f.calls).toEqual(["account"]);
});

test("changed source authority between stages cannot dispatch or expose the dependent value", async () => {
  const f = await chainFixture(), request = await f.prepare("revoked-source-chain", f.refresh), events: import("tardie/core/event").Event[] = [];
  const journal = { read: async () => events, append: async (rows: typeof events) => {
    if (rows.some(row => row.type === "AikoDatabaseRefreshGroupSettled")) throw Error("process loss");
    events.push(...rows);
  } };
  await expect(executeDatabaseRefreshGraph(f.binding, request, f.refresh, journal, new AbortController().signal)).rejects.toThrow("process loss");
  const resolve = f.binding.sources!;
  f.binding.sources = async (...args) => ({ ...await resolve(...args), generation: "generation:2" });
  const receipt = await executeDatabaseRefreshGraph(f.binding, request, f.refresh, { ...journal, append: async rows => { events.push(...rows); } }, new AbortController().signal);
  expect(receipt.outcome).toBe("rejected");
  expect(receipt.result).toMatchObject({ coverage: "partial", committed: 1, calls: 1, reasons: ["forbidden"] });
  expect(f.calls).toEqual(["account"]);
  await expect(readDatabaseValue(f.binding, "table_query", { query: { tableId: "items" } }, events)).rejects.toThrow("generation");
});

test("reference-only prerequisites never enter persisted downstream plans", async () => {
  const f = await chainFixture(), table = f.store.table("items");
  f.store.execute("reference-policy", { kind: "table.define", expectedRevision: table.revision, table: { ...table.value, columns: table.value.columns.map(column => column.id === "account" ? { ...column, binding: { ...f.request("account"), retention: "reference-only" } } : column) } }, f.context);
  await f.admit(await f.prepare("reference-chain", f.refresh)); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("reference-chain")?.status).toBe("unavailable");
  expect(f.calls).toEqual([]);
  expect((await f.events()).some(event => event.type === "AikoDatabaseRefreshGraphPlanned")).toBe(false);
});

test("native refresh groups fields once, preserves value heads, withholds reference-only values and rechecks generations", async () => {
  const f = await fixture(); let calls = 0, generation = "session:1", fail = false;
  f.binding.sources = async () => ({ digest: "contract", generation, stepIds: ["repository"], inputs: [{ name: "repo", type: "string", required: true }], execute: async (input, consume) => {
    calls++; expect(input.repo).toBe("launch"); if (fail) throw Error("Provider failed");
    consume("repository", { issues: 12, title: "SELECTED_PRIVATE_VALUE", transient: "REFERENCE_ONLY_VALUE", unselected: "RAW_RESPONSE_VALUE" }); return { calls: 1, bytes: 100 };
  } });
  f.store.execute("db", command, { at: 1000, producer: "fixture" });
  const request = (pointer: string, retention: "materialized" | "reference-only" = "materialized") => ({ kind: "request" as const, sourceId: "repo", contractDigest: "contract", inputs: { repo: { rowField: "repo" } }, select: { stepId: "repository", jsonPointer: pointer }, refresh: { mode: "on-demand" as const, maxAgeSeconds: 30 }, retention });
  f.store.execute("table", { kind: "table.define", expectedRevision: 0, table: { id: "projects", databaseId: "launch", name: "Projects", mode: "stored", columns: [{ id: "repo", name: "Repository", type: "text" }, { id: "issues", name: "Issues", type: "integer", binding: request("/issues") }, { id: "title", name: "Title", type: "text", binding: request("/title") }, { id: "transient", name: "Transient", type: "text", binding: request("/transient", "reference-only") }] } }, { at: 1000, producer: "fixture" });
  f.store.execute("row", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "one", expectedRevision: 0, values: { repo: "launch" } }] }, { at: 1000, producer: "fixture" });
  await readDatabaseValue(f.binding, "table_query", { query: { tableId: "projects" } }, await f.events()); expect(calls).toBe(0);
  const refresh = async (id: string) => { await f.admit(await f.prepare(id, { kind: "table.refresh", tableId: "projects" })); await f.drive(); return f.store.receipt(id); };
  expect((await refresh("refresh-1"))?.result).toMatchObject({ coverage: "complete", groups: 1, calls: 1 }); expect(calls).toBe(1);
  const first = f.store.query({ tableId: "projects" }).rows[0]!.cells;
  expect(first.issues?.value).toBe(12); expect(first.transient?.state).toBe("unavailable");
  f.advance(1000); expect((await refresh("refresh-2"))?.result).toMatchObject({ changed: [] });
  const second = f.store.query({ tableId: "projects" }).rows[0]!.cells;
  expect(second.issues?.valueVersion).toBe(first.issues?.valueVersion); expect(second.issues?.checkedAt).toBeGreaterThan(first.issues!.checkedAt!);
  expect(JSON.stringify(await f.events())).not.toContain("SELECTED_PRIVATE_VALUE");
  const persisted = JSON.stringify(f.db.query("SELECT * FROM structured_records").all()) + JSON.stringify(f.db.query("SELECT * FROM structured_operations").all()) + JSON.stringify(f.db.query("SELECT * FROM structured_checks").all());
  expect(persisted).not.toContain("REFERENCE_ONLY_VALUE"); expect(persisted).not.toContain("RAW_RESPONSE_VALUE");
  fail = true; f.advance(1000); expect((await refresh("refresh-failed"))?.result).toMatchObject({ coverage: "partial", failed: 1 });
  expect(f.store.query({ tableId: "projects" }).rows[0]!.cells.issues).toMatchObject({ state: "ready", value: 12, freshness: "stale" });
  generation = "session:2";
  await expect(readDatabaseValue(f.binding, "table_query", { query: { tableId: "projects" } }, await f.events())).rejects.toThrow("generation");
  fail = false; expect((await refresh("refresh-generation"))?.result).toMatchObject({ coverage: "complete" });
  expect((await readDatabaseValue(f.binding, "table_query", { query: { tableId: "projects" } }, await f.events()) as any).rows[0].cells.issues.sourceGeneration).toBe("session:2");
  const before = calls; await f.reopen(); await f.drive(); expect(calls).toBe(before);
});

test("refresh recovers a committed group without another fetch and fences concurrent row edits", async () => {
  const f = await fixture(); let calls = 0;
  f.binding.sources = async () => ({ digest: "contract", generation: "public", stepIds: ["read"], inputs: [], execute: async (_input, consume) => { calls++; consume("read", { count: 5 }); return { calls: 1, bytes: 11 }; } });
  f.store.execute("db", command, { at: 1000, producer: "fixture" });
  f.store.execute("table", { kind: "table.define", expectedRevision: 0, table: { id: "items", databaseId: "launch", name: "Items", mode: "stored", columns: [{ id: "count", name: "Count", type: "integer", binding: { kind: "request", sourceId: "source", contractDigest: "contract", inputs: {}, select: { stepId: "read", jsonPointer: "/count" }, refresh: { mode: "on-demand", maxAgeSeconds: 60 }, retention: "materialized" } }] } }, { at: 1000, producer: "fixture" });
  f.store.execute("row", { kind: "rows.upsert", tableId: "items", rows: [{ id: "one", expectedRevision: 0, values: {} }] }, { at: 1000, producer: "fixture" });
  const refresh = { kind: "table.refresh" as const, tableId: "items" }, request = await f.prepare("refresh", refresh);
  const events: import("tardie/core/event").Event[] = [];
  const journal = { read: async () => events, append: async (rows: typeof events) => { if (rows.some(row => row.type === "AikoDatabaseRefreshGroupSettled")) throw Error("Simulated process loss after group commit"); events.push(...rows); } };
  await expect(executeDatabaseRefresh(f.binding, request, refresh, journal, new AbortController().signal)).rejects.toThrow("process loss");
  expect(calls).toBe(1); expect(f.store.receipt("refresh")).toBeUndefined();
  const recovered = await executeDatabaseRefresh(f.binding, request, refresh, { ...journal, append: async rows => { events.push(...rows); } }, new AbortController().signal);
  expect(calls).toBe(1); expect(recovered.result).toMatchObject({ coverage: "complete", committed: 1, calls: 1, bytes: 11 });
  f.binding.sources = async () => ({ digest: "contract", generation: "public", stepIds: ["read"], inputs: [], execute: async (_input, consume) => {
    f.store.execute("concurrent-row", { kind: "rows.upsert", tableId: "items", rows: [{ id: "one", expectedRevision: 1, values: {} }] }, { at: 1000, producer: "user:other-tab" });
    consume("read", { count: 99 }); return { calls: 1, bytes: 12 };
  } });
  await f.admit(await f.prepare("late-refresh", refresh)); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("late-refresh")?.status).toBe("conflict");
  expect(f.store.row("items", "one")?.revision).toBe(2);
  expect(f.store.query({ tableId: "items" }).rows[0]?.cells.count?.state).toBe("unavailable");
  expect(f.store.cell("items", "one", "count")?.cell.value).toBe(5);
  f.binding.sources = async () => ({ digest: "contract", generation: "public", stepIds: ["read"], inputs: [], execute: async () => new Promise(() => {}) });
  await f.admit(await f.prepare("timed-refresh", { ...refresh, budget: { timeoutMs: 100 } })); await f.drive();
  expect(f.store.receipt("timed-refresh")?.result).toMatchObject({ coverage: "partial", failed: 1 });
  expect(f.store.query({ tableId: "items" }).rows[0]?.cells.count?.state).toBe("error");
});

test("a missing response step records partial measured checks instead of claiming completion", async () => {
  const f = await chainFixture(), resolve = f.binding.sources!;
  f.binding.sources = async (...args) => ({ ...await resolve(...args), execute: async () => ({ calls: 1, bytes: 2 }) });
  await f.admit(await f.prepare("missing-step", { ...f.refresh, columnIds: ["account"] })); await f.drive();
  expect(f.store.receipt("missing-step")?.result).toMatchObject({ coverage: "partial", failed: 1, calls: 1, bytes: 2, budgetAccounting: "measured", reasons: ["missing_response_step"] });
  expect(f.store.query({ tableId: "items", select: ["account"] }).rows[0]?.cells.account?.state).toBe("error");
});

test("native refresh fences foreign lookup inputs and retains their access evidence", async () => {
  const f = await fixture(); let changeDuringRead = false, fail = false, calls = 0;
  f.store.execute("db", command, { at: 1000, producer: "fixture" });
  f.store.execute("companies", { kind: "table.define", expectedRevision: 0, table: { id: "companies", databaseId: "launch", name: "Companies", mode: "stored", columns: [{ id: "name", name: "Name", type: "text" }] } }, { at: 1000, producer: "fixture" });
  f.store.execute("company", { kind: "rows.upsert", tableId: "companies", rows: [{ id: "acme", expectedRevision: 0, values: { name: "Acme" } }] }, { at: 1000, producer: "fixture" });
  f.store.execute("projects", { kind: "table.define", expectedRevision: 0, table: { id: "projects", databaseId: "launch", name: "Projects", mode: "stored", columns: [
    { id: "company", name: "Company", type: "relation", relation: { tableId: "companies", cardinality: "many-to-one" } },
    { id: "key", name: "Remote key", type: "text", binding: { kind: "lookup", relation: "company", field: "name", aggregate: "first" } },
    { id: "count", name: "Count", type: "integer", binding: { kind: "request", sourceId: "source", contractDigest: "contract", inputs: { key: { rowField: "key" } }, select: { stepId: "read", jsonPointer: "/count" }, refresh: { mode: "on-demand", maxAgeSeconds: 60 }, retention: "materialized" } },
  ] } }, { at: 1000, producer: "fixture" });
  f.store.execute("row", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "one", expectedRevision: 0, values: { company: "acme" } }] }, { at: 1000, producer: "fixture" });
  f.binding.sources = async () => ({ digest: "contract", generation: "public", stepIds: ["read"], inputs: [{ name: "key", required: true, type: "string" }], execute: async (inputs, consume) => {
    calls++; expect(inputs.key).toBe(changeDuringRead || calls === 1 ? "Acme" : "Changed");
    if (fail) throw Error("Synthetic provider failure");
    if (changeDuringRead) f.store.execute("foreign-edit", { kind: "rows.upsert", tableId: "companies", rows: [{ id: "acme", expectedRevision: 1, values: { name: "Changed" } }] }, { at: 1000, producer: "user:other-tab" });
    consume("read", { count: calls }); return { calls: 1, bytes: 11 };
  } });
  const refresh = async (id: string, mode: "all" | "stale" = "all") => { await f.admit(await f.prepare(id, { kind: "table.refresh", tableId: "projects", mode })); await f.drive(); };
  await refresh("first");
  const query = { tableId: "projects", select: ["count"] };
  expect(f.store.query(query).rows[0]?.cells.count?.value).toBe(1);
  expect(f.store.query(query).dependencies.some(d => d.tableId === "companies" && d.rowId === "acme")).toBe(true);
  f.store.execute("view", { kind: "view.save", expectedRevision: 0, view: { id: "counts", title: "Counts", layout: "table", query } }, { at: 1000, producer: "fixture" });
  f.store.execute("snapshot", { kind: "artifact.create", artifactId: "counts", title: "Counts", viewId: "counts", viewRevision: 1, dataMode: "snapshot" }, { at: 1000, producer: "fixture" });
  changeDuringRead = true; await refresh("racing");
  expect(databaseState(await f.events(), f.binding).get("racing")?.status).toBe("conflict");
  expect(f.store.cell("projects", "one", "count")?.cell.value).toBe(1);
  expect(f.store.query(query).rows[0]?.cells.count?.state).toBe("unavailable");
  changeDuringRead = false; fail = true; await refresh("changed-input-failure", "stale");
  expect(f.store.query(query).rows[0]?.cells.count?.value).toBeUndefined();
  fail = false; await refresh("changed-input", "stale");
  expect(f.store.query(query).rows[0]?.cells.count?.value).toBe(4);
  f.store.options.canReadDependency = dependency => dependency.tableId !== "companies";
  expect(() => f.store.query(query)).toThrow("current access");
  expect(() => f.store.artifact("counts")).toThrow("current access");
});

test("refresh replay reserves uncertain attempt costs and never dispatches the next group", async () => {
  const f = await fixture(); let calls = 0;
  f.binding.sources = async () => ({ digest: "contract", generation: "public", stepIds: ["read"], inputs: [{ name: "key", required: true, type: "string" }], execute: async (_input, consume) => { calls++; consume("read", { count: 1 }); return { calls: 1, bytes: 11 }; } });
  f.store.execute("db", command, { at: 1000, producer: "fixture" });
  f.store.execute("table", { kind: "table.define", expectedRevision: 0, table: { id: "items", databaseId: "launch", name: "Items", mode: "stored", columns: [{ id: "key", name: "Key", type: "text" }, { id: "count", name: "Count", type: "integer", binding: { kind: "request", sourceId: "source", contractDigest: "contract", inputs: { key: { rowField: "key" } }, select: { stepId: "read", jsonPointer: "/count" }, refresh: { mode: "on-demand", maxAgeSeconds: 60 }, retention: "materialized" } }] } }, { at: 1000, producer: "fixture" });
  f.store.execute("rows", { kind: "rows.upsert", tableId: "items", rows: ["one", "two"].map(id => ({ id, expectedRevision: 0, values: { key: id } })) }, { at: 1000, producer: "fixture" });
  const refreshCommand = { kind: "table.refresh" as const, tableId: "items", budget: { maxCalls: 2, maxBytes: 1024 } }, request = await f.prepare("interrupted", refreshCommand);
  const events: import("tardie/core/event").Event[] = [];
  const journal = { read: async () => events, append: async (rows: typeof events) => { events.push(...rows); if (rows.some(row => row.type === "AikoDatabaseRefreshGroupStarted")) throw Error("Process lost after dispatch intent"); } };
  await expect(executeDatabaseRefresh(f.binding, request, refreshCommand, journal, new AbortController().signal)).rejects.toThrow("Process lost");
  f.advance(60001); // Recovery after the deadline must still disclose the unknown attempt.
  const result = await executeDatabaseRefresh(f.binding, request, refreshCommand, { ...journal, append: async rows => { events.push(...rows); } }, new AbortController().signal);
  expect(result.result).toMatchObject({ coverage: "partial", groups: 2, committed: 0, failed: 1, calls: 2, bytes: 1024, budgetAccounting: "reserved", reasons: ["interrupted_read"] });
  expect(calls).toBe(0);
});
