import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StructuredStore, decimalMath, type Command, type Column, type Storage, type StoreOptions } from "../src";

const open: Database[] = [], dirs: string[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(path = ":memory:", owner = "owner", options: StoreOptions = {}) {
  const db = new Database(path); open.push(db);
  const storage: Storage = { exec: sql => { db.exec(sql); }, prepare: sql => db.query(sql) as Storage["prepare"] extends (...args: never[]) => infer R ? R : never, transaction: run => db.transaction(run)(), read: run => db.transaction(run)() };
  return { db, storage, store: new StructuredStore(storage, owner, { now: () => 1000, ...options }) };
}
const ctx = { at: 1000, producer: "user:test" };
function seed(store: StructuredStore, extra: Column[] = []) {
  store.execute("db", { kind: "database.create", database: { id: "work", name: "Work", lifecycle: "visible" } }, ctx);
  store.execute("companies", { kind: "table.define", expectedRevision: 0, table: { id: "companies", databaseId: "work", name: "Companies", mode: "stored", columns: [{ id: "name", name: "Name", type: "text", required: true }, { id: "tier", name: "Tier", type: "enum", options: ["enterprise", "startup"] }] } }, ctx);
  store.execute("company-rows", { kind: "rows.upsert", tableId: "companies", rows: [{ id: "acme", expectedRevision: 0, values: { name: "Acme", tier: "enterprise" } }, { id: "small", expectedRevision: 0, values: { name: "Small", tier: "startup" } }] }, ctx);
  store.execute("projects", { kind: "table.define", expectedRevision: 0, table: { id: "projects", databaseId: "work", name: "Projects", mode: "stored", columns: [
    { id: "name", name: "Name", type: "text", required: true },
    { id: "company", name: "Company", type: "relation", relation: { tableId: "companies", cardinality: "many-to-one" }, nullable: true },
    { id: "cost", name: "Cost", type: "decimal" },
    { id: "tier", name: "Tier", type: "text", binding: { kind: "lookup", relation: "company", field: "tier", aggregate: "first" } }, ...extra,
  ] } }, ctx);
  store.execute("project-rows", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 0, values: { name: "Website", company: "acme", cost: "0.10" } }, { id: "p2", expectedRevision: 0, values: { name: "App", company: "acme", cost: "0.20" } }, { id: "p3", expectedRevision: 0, values: { name: "Research", company: null, cost: "9007199254740993" } }] }, ctx);
}

test("stable rows survive reopen and a lost receipt does not repeat the commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "structured-store-")); dirs.push(dir); const path = join(dir, "data.sqlite");
  const first = fixture(path); seed(first.store);
  const command: Command = { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 1, values: { name: "New website" } }] };
  const committed = first.store.execute("edit", command, ctx);
  first.db.close(); open.splice(open.indexOf(first.db), 1);
  const second = fixture(path);
  expect(second.store.execute("edit", command, { ...ctx, at: 2000 })).toEqual(committed);
  expect(second.store.row("projects", "p1")?.revision).toBe(2);
  expect(second.store.pending().filter(x => x.id === "change:edit")).toHaveLength(1);
  expect(() => second.store.execute("edit", { ...command, rows: [{ ...command.rows[0]!, values: { name: "Different" } }] }, ctx)).toThrow("different command");
});

test("batch validation and CAS failures roll back every row and receipt", () => {
  const { store } = fixture(); seed(store); const revision = store.revision();
  expect(() => store.execute("bad", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 1, values: { name: "Should roll back" } }, { id: "p2", expectedRevision: 99, values: { name: "Conflict" } }] }, ctx)).toThrow("current 1");
  expect(store.row("projects", "p1")?.value.values.name).toBe("Website");
  expect(store.revision()).toBe(revision); expect(store.receipt("bad")).toBeUndefined();
});

test("selected fields authorize only their real dependencies and exact row reads avoid a full scan", () => {
  let denied = false;
  const { store } = fixture(":memory:", "owner", { canRead: (_table, column) => !denied || column !== "cost" && column !== "tier" });
  seed(store); denied = true;
  const result = store.query({ tableId: "projects", select: ["name"], filter: { field: "$id", op: "eq", value: "p2" } });
  expect(result.rows[0]?.cells.name?.value).toBe("App"); expect(result.scanned).toBe(1);
  expect(result.dependencies.some(d => d.columnId === "cost" || d.columnId === "tier")).toBe(false);
  expect(result.columns.map(c => c.id)).toEqual(["name"]);
  expect(store.query({ tableId: "projects", aggregates: [{ as: "n", op: "count" }] }).rows[0]?.cells.n?.value).toBe(3);
  expect(() => store.query({ tableId: "projects", select: ["name"], sort: [{ field: "cost", direction: "asc" }] })).toThrow("unavailable");
  expect(() => store.query({ tableId: "projects", select: ["tier"] })).toThrow("unavailable");
});

test("empty snapshots retain selected source policy without contaminating unrelated projections", () => {
  const { store } = fixture(); seed(store, [{ id: "live", name: "Live", type: "integer", binding: { kind: "request", sourceId: "source", contractDigest: "contract", inputs: {}, select: { stepId: "read", jsonPointer: "/count" }, refresh: { mode: "on-demand", maxAgeSeconds: 60 }, retention: "reference-only" } }]);
  for (const selected of [["live"], ["name"]]) {
    const id = selected[0]!;
    store.execute(`view-${id}`, { kind: "view.save", expectedRevision: 0, view: { id, title: id, layout: "table", query: { tableId: "projects", select: selected, filter: { field: "$id", op: "eq", value: "absent" } } } }, ctx);
  }
  expect(() => store.execute("snapshot-live", { kind: "artifact.create", artifactId: "live", viewId: "live", viewRevision: 1, title: "Live", dataMode: "snapshot" }, ctx)).toThrow("retention");
  expect(store.execute("snapshot-name", { kind: "artifact.create", artifactId: "names", viewId: "name", viewRevision: 1, title: "Names", dataMode: "snapshot" }, ctx).result).toMatchObject({ artifactId: "names" });
});

test("exact decimal totals, joined rows and relation lookups use current values", () => {
  const { store } = fixture(); seed(store);
  const query = store.query({ tableId: "projects", joins: [{ tableId: "companies", as: "co", on: { local: "company", foreign: "$id" }, kind: "left", cardinality: "one" }], sort: [{ field: "cost", direction: "asc" }] });
  expect(query.rows[0]?.cells["co.name"]?.value).toBe("Acme");
  expect(query.rows[2]?.cells["co.name"]?.state).toBe("missing");
  expect(query.rows[0]?.cells.tier?.value).toBe("enterprise");
  const totals = store.query({ tableId: "projects", groupBy: ["company"], aggregates: [{ as: "total", field: "cost", op: "sum" }, { as: "n", op: "count" }], sort: [{ field: "total", direction: "asc" }] });
  expect(totals.rows).toHaveLength(2);
  expect(totals.rows[0]?.cells.total?.value).toBe("0.3"); expect(totals.rows[0]?.cells.n?.value).toBe(2);
  expect(totals.rows[1]?.cells.total?.value).toBe("9007199254740993");
  expect(decimalMath("multiply", "0.1", "0.2")).toBe("0.02");
  expect(() => decimalMath("divide", "1", "3")).toThrow("rounding");
});

test("pagination tokens reject changed data and aggregates disclose incomplete scans", () => {
  const { store } = fixture(); seed(store);
  const first = store.query({ tableId: "projects", limit: 1 }); expect(first.nextCursor).toBeDefined();
  expect(store.query({ tableId: "projects", cursor: first.nextCursor, limit: 1 }).rows[0]?.id).toBe("p2");
  store.execute("edit", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 1, values: { name: "Changed" } }] }, ctx);
  expect(() => store.query({ tableId: "projects", cursor: first.nextCursor })).toThrow("restart pagination");
  const total = store.query({ tableId: "projects", maxRows: 1, aggregates: [{ as: "count", op: "count" }] });
  expect(total.coverage).toBe("partial"); expect(total.reasons).toContain("candidate_budget");
});

test("owner boundaries and current field access cover lookups, joins and artifacts", () => {
  let allowed = true;
  const { storage, store } = fixture(":memory:", "alice", { canRead: (tableId, columnId) => allowed || tableId !== "companies" || columnId !== "tier" }); seed(store);
  const other = new StructuredStore(storage, "bob"); expect(() => other.table("projects")).toThrow("unavailable");
  store.execute("view", { kind: "view.save", expectedRevision: 0, view: { id: "launch", title: "Launch", layout: "table", query: { tableId: "projects" } } }, ctx);
  store.execute("artifact", { kind: "artifact.create", artifactId: "launch-art", viewId: "launch", viewRevision: 1, title: "Launch", dataMode: "snapshot" }, ctx);
  allowed = false;
  expect(() => store.query({ tableId: "projects" })).toThrow("current access");
  expect(() => store.artifact("launch-art")).toThrow("current access");
});

test("renaming columns preserves bindings, computed edits are explicit, and cycles reject", () => {
  const { store } = fixture(); seed(store, [{ id: "double", name: "Double", type: "decimal", binding: { kind: "formula", expression: { op: "multiply", args: [{ field: "cost" }, { literal: "2" }] } } }]);
  expect(store.query({ tableId: "projects" }).rows[0]?.cells.double?.value).toBe("0.2");
  const table = store.table("projects"); table.value.columns[2]!.name = "Budget";
  store.execute("rename", { kind: "table.define", table: table.value, expectedRevision: 1 }, ctx);
  expect(store.query({ tableId: "projects" }).rows[0]?.cells.double?.value).toBe("0.2");
  expect(() => store.execute("computed", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 1, values: { double: "3" } }] }, ctx)).toThrow("owned by its binding");
  store.execute("override", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 1, values: {}, overrides: { double: "3" } }] }, ctx);
  expect(store.query({ tableId: "projects" }).rows[0]?.cells.double?.overridden).toBe(true);
  table.value.columns.push({ id: "cycle", name: "Cycle", type: "integer", binding: { kind: "formula", expression: { field: "cycle" } } });
  expect(() => store.execute("cycle", { kind: "table.define", table: table.value, expectedRevision: 2 }, ctx)).toThrow("Cyclic");
});

test("one-to-one cardinality rejects duplicates inside the same transaction", () => {
  const { store } = fixture(); seed(store);
  store.execute("exclusive", { kind: "table.define", expectedRevision: 0, table: { id: "exclusive", databaseId: "work", name: "Exclusive", mode: "stored", columns: [{ id: "company", name: "Company", type: "relation", relation: { tableId: "companies", cardinality: "one-to-one" } }] } }, ctx);
  expect(() => store.execute("duplicates", { kind: "rows.upsert", tableId: "exclusive", rows: [{ id: "one", expectedRevision: 0, values: { company: "acme" } }, { id: "two", expectedRevision: 0, values: { company: "acme" } }] }, ctx)).toThrow("already referenced");
  expect(store.rows("exclusive").rows).toHaveLength(0);
});

test("deleting a relation target leaves missing references and prevents row ID reuse", () => {
  const { store } = fixture(); seed(store);
  store.execute("delete", { kind: "rows.delete", tableId: "companies", rows: [{ id: "acme", expectedRevision: 1 }] }, ctx);
  const row = store.query({ tableId: "projects" }).rows[0]!;
  expect(row.cells.company?.value).toBe("acme"); expect(row.cells.tier?.state).toBe("missing");
  expect(() => store.execute("reuse", { kind: "rows.upsert", tableId: "companies", rows: [{ id: "acme", expectedRevision: 2, values: { name: "Different company" } }] }, ctx)).toThrow("cannot be reused");
});

test("domain collections cannot be created or edited by generic CRUD", () => {
  const domains = new Map([["system.approvals", { definition: { id: "system.approvals", databaseId: "system", name: "Approvals", mode: "domain" as const, columns: [{ id: "state", name: "State", type: "text" as const, authority: "domain" as const }] }, rows: () => ({ rows: [{ id: "a1", revision: 1, value: { values: { state: "pending" } }, producer: "domain", deleted: false, at: 1000 }], revision: 1, complete: true }) }]]);
  const { store } = fixture(":memory:", "owner", { domains });
  expect(store.query({ tableId: "system.approvals" }).rows[0]?.cells.state?.value).toBe("pending");
  expect(() => store.execute("approve", { kind: "rows.upsert", tableId: "system.approvals", rows: [{ id: "a1", expectedRevision: 1, values: { state: "approved" } }] }, ctx)).toThrow("host commands");
});

test("value versions distinguish checks from changes, failed checks preserve permitted stale data", async () => {
  const { store } = fixture(); seed(store, [{ id: "issues", name: "Issues", type: "integer", binding: { kind: "request", sourceId: "issues", contractDigest: "sha256:fixture", inputs: {}, select: { stepId: "read", jsonPointer: "/count" }, refresh: { mode: "on-demand", maxAgeSeconds: 300 }, retention: "materialized" } }]);
  const input = (value: number) => ({ tableId: "projects", tableRevision: 1, rows: [{ rowId: "p1", rowRevision: 1, cells: { issues: { retention: "materialized" as const, cell: { state: "ready" as const, freshness: "fresh" as const, value, observedAt: 1000, lineage: ["source:issues:1"] } } } }] });
  await store.commitCells("read-1", input(12), 1000);
  await store.commitCells("read-2", input(12), 2000);
  expect(store.cell("projects", "p1", "issues")?.cell.valueVersion).toBe(1); expect(store.cell("projects", "p1", "issues")?.cell.checkedAt).toBe(2000);
  await store.commitCells("read-3", input(13), 3000);
  expect(store.cell("projects", "p1", "issues")?.cell.valueVersion).toBe(2);
  await store.commitCells("read-fail", { tableId: "projects", tableRevision: 1, rows: [{ rowId: "p1", rowRevision: 1, cells: { issues: { retention: "materialized", cell: { state: "error", freshness: "unknown", error: "Source unavailable" } } } }] }, 4000);
  const failed = store.cell("projects", "p1", "issues")!.cell;
  expect(failed.value).toBe(13); expect(failed.freshness).toBe("stale"); expect(failed.valueVersion).toBe(2);
  store.execute("edit", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 1, values: { name: "New request inputs" } }] }, ctx);
  await expect(store.commitCells("late", input(99), 5000)).rejects.toThrow("Row changed");
});

test("reference-only selected response values are absent from every persisted table", async () => {
  const { db, store } = fixture(); seed(store, [{ id: "remote", name: "Remote", type: "text", binding: { kind: "request", sourceId: "remote", contractDigest: "sha256:fixture", inputs: {}, select: { stepId: "read", jsonPointer: "/value" }, refresh: { mode: "on-demand", maxAgeSeconds: 300 }, retention: "reference-only" } }]);
  await store.commitCells("reference", { tableId: "projects", tableRevision: 1, rows: [{ rowId: "p1", rowRevision: 1, cells: { remote: { retention: "reference-only", cell: { state: "ready", freshness: "fresh", value: "sensitive-canary-never-retain" } } } }] }, 1000);
  for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
    expect(JSON.stringify(db.query(`SELECT * FROM ${name}`).all())).not.toContain("sensitive-canary-never-retain");
  }
  expect(store.query({ tableId: "projects" }).rows[0]?.cells.remote?.state).toBe("unavailable");
});

test("snapshot reauthorization retains deleted lookup targets and exact source evidence", async () => {
  let allowHistorical = true;
  const { store } = fixture(":memory:", "owner", { canReadDependency: dependency => allowHistorical || !dependency.lineage?.includes("observation:private-v1") });
  seed(store);
  const companies = store.table("companies");
  companies.value.columns.push({ id: "contact", name: "Contact", type: "text", binding: { kind: "entity", subject: "person-maya", path: "/name", retention: "materialized" } });
  store.execute("contact-schema", { kind: "table.define", table: companies.value, expectedRevision: 1 }, ctx);
  await store.commitCells("contact-read", { tableId: "companies", tableRevision: 2, rows: [{ rowId: "acme", rowRevision: 1, cells: { contact: { retention: "materialized", cell: { state: "ready", freshness: "fresh", value: "Private Maya", lineage: ["observation:private-v1"] } } } }] }, 1000);
  const projects = store.table("projects"); projects.value.columns.push({ id: "contact", name: "Contact", type: "text", binding: { kind: "lookup", relation: "company", field: "contact", aggregate: "first" } });
  store.execute("contact-lookup", { kind: "table.define", table: projects.value, expectedRevision: 1 }, ctx);
  store.execute("view", { kind: "view.save", expectedRevision: 0, view: { id: "contacts", title: "Contacts", layout: "table", query: { tableId: "projects" } } }, ctx);
  store.execute("snapshot", { kind: "artifact.create", artifactId: "contacts-snapshot", viewId: "contacts", viewRevision: 1, title: "Contacts", dataMode: "snapshot" }, ctx);
  expect(store.artifact("contacts-snapshot").result.rows[0]?.cells.contact?.value).toBe("Private Maya");
  store.execute("delete-contact", { kind: "rows.delete", tableId: "companies", rows: [{ id: "acme", expectedRevision: 1 }] }, ctx);
  expect(store.query({ tableId: "projects" }).rows[0]?.cells.contact?.state).toBe("missing");
  allowHistorical = false;
  expect(() => store.artifact("contacts-snapshot")).toThrow("current access");
});

test("snapshot retention follows transitive lookups outside explicit joins", () => {
  const { store } = fixture(); seed(store);
  const companies = store.table("companies");
  companies.value.columns.push({ id: "live", name: "Live", type: "text", binding: { kind: "entity", subject: "remote", path: "/value", retention: "reference-only" } });
  store.execute("live-schema", { kind: "table.define", table: companies.value, expectedRevision: 1 }, ctx);
  const projects = store.table("projects"); projects.value.columns.push({ id: "live", name: "Live", type: "text", binding: { kind: "lookup", relation: "company", field: "live", aggregate: "first" } });
  store.execute("live-lookup", { kind: "table.define", table: projects.value, expectedRevision: 1 }, ctx);
  store.execute("view", { kind: "view.save", expectedRevision: 0, view: { id: "live", title: "Live", layout: "table", query: { tableId: "projects" } } }, ctx);
  expect(() => store.execute("snapshot", { kind: "artifact.create", artifactId: "frozen", viewId: "live", viewRevision: 1, title: "Frozen", dataMode: "snapshot" }, ctx)).toThrow("explicit retention");
  expect(store.record("artifact", "frozen")).toBeUndefined();
});

test("changed source bindings and row inputs do not serve values from the previous identity", async () => {
  const { store } = fixture(); seed(store, [{ id: "remote", name: "Remote", type: "text", binding: { kind: "entity", subjectField: "name", path: "/value", retention: "materialized" } }]);
  await store.commitCells("old-source", { tableId: "projects", tableRevision: 1, rows: [{ rowId: "p1", rowRevision: 1, cells: { remote: { retention: "materialized", cell: { state: "ready", freshness: "fresh", value: "Old subject value" } } } }] }, 1000);
  expect(store.query({ tableId: "projects" }).rows[0]?.cells.remote?.value).toBe("Old subject value");
  store.execute("new-subject", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 1, values: { name: "Another subject" } }] }, ctx);
  expect(store.query({ tableId: "projects" }).rows[0]?.cells.remote?.state).toBe("unavailable");
  await store.commitCells("new-source-error", { tableId: "projects", tableRevision: 1, rows: [{ rowId: "p1", rowRevision: 2, cells: { remote: { retention: "materialized", cell: { state: "error", freshness: "unknown", error: "Unavailable" } } } }] }, 2000);
  expect(store.query({ tableId: "projects" }).rows[0]?.cells.remote?.value).toBeUndefined();
});

test("formula comparisons preserve decimal ordering above integer precision", () => {
  const { store } = fixture(); seed(store, [
    { id: "large", name: "Large", type: "boolean", binding: { kind: "formula", expression: { op: "gt", args: [{ field: "cost" }, { literal: "9007199254740992" }] } } },
    { id: "ten", name: "Over ten", type: "boolean", binding: { kind: "formula", expression: { op: "gt", args: [{ field: "cost" }, { literal: "10" }] } } },
  ]);
  expect(store.query({ tableId: "projects" }).rows[2]?.cells.large?.value).toBe(true);
  store.execute("nine", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "p1", expectedRevision: 1, values: { cost: "9" } }] }, ctx);
  expect(store.query({ tableId: "projects" }).rows[0]?.cells.ten?.value).toBe(false);
  expect(store.query({ tableId: "projects", select: ["$id"] }).rows[0]?.cells.$id?.value).toBe("p1");
});

test("query byte budgets include UTF-8 values and retained dependency evidence", () => {
  const { store } = fixture(); seed(store);
  store.execute("unicode", { kind: "rows.upsert", tableId: "companies", rows: [{ id: "acme", expectedRevision: 1, values: { name: "界".repeat(1000) } }] }, ctx);
  const result = store.query({ tableId: "companies", maxBytes: 3000 });
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(3000);
  expect(result.reasons).toContain("result_byte_budget");
  expect(result.rows).toHaveLength(0);
  expect(() => store.query({ tableId: "projects", maxBytes: 1024 })).toThrow("byte budget");
});
