import type { Command } from "../../../packages/structured-data/src/index.ts";

/** Same synthetic dependency chain for the production Node and Worker adapters.
 * directory entity → formula → relation lookup → dependent entity read. */
export function stagedEntityTables(databaseId: string): Command[] {
  return [
    { kind: "table.define", expectedRevision: 0, table: { id: "refresh-directory", databaseId, name: "Directory", mode: "stored", columns: [
      { id: "key", name: "Company key", type: "text", binding: { kind: "entity", subject: "refresh/directory", path: "/company", retention: "materialized" } },
      { id: "subject", name: "Company subject", type: "text", binding: { kind: "formula", expression: { op: "concat", args: [{ literal: "refresh/companies/" }, { field: "key" }] } } },
    ] } },
    { kind: "rows.upsert", tableId: "refresh-directory", rows: [{ id: "directory", expectedRevision: 0, values: {} }] },
    { kind: "table.define", expectedRevision: 0, table: { id: "refresh-projects", databaseId, name: "Projects", mode: "stored", columns: [
      { id: "directory", name: "Directory", type: "relation", relation: { tableId: "refresh-directory", cardinality: "many-to-one" } },
      { id: "subject", name: "Company subject", type: "text", binding: { kind: "lookup", relation: "directory", field: "subject", aggregate: "first" } },
      { id: "tier", name: "Company tier", type: "text", binding: { kind: "entity", subjectField: "subject", path: "/tier", retention: "materialized" } },
    ] } },
    { kind: "rows.upsert", tableId: "refresh-projects", rows: ["one", "two"].map(id => ({ id, expectedRevision: 0, values: { directory: "directory" } })) },
  ];
}
export const stagedEntityRefresh: Command = { kind: "table.refresh", tableId: "refresh-projects", columnIds: ["tier"], budget: { maxCalls: 1, maxBytes: 2048, maxRows: 3 } };
