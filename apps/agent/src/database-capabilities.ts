import type { DatabaseQueryCapabilities } from "@unlock/protocol";
import type { Column, Query, QueryResult } from "../../../packages/structured-data/src/index.ts";
import type { DatabaseBinding } from "./database-component.ts";

const literal = (column: Column) => (!column.binding || column.binding.kind === "literal") && (!column.authority || column.authority === "table") && column.id !== "$id";

/** Describes only selected, authorized records. No source execution or memory payload reads. */
export function databaseQueryCapabilities(binding: DatabaseBinding, query: Query, result: QueryResult, write: boolean, snapshot = false): DatabaseQueryCapabilities {
  const capabilities: DatabaseQueryCapabilities = { version: 1, write: write && !snapshot, query: !snapshot, saveView: write && !snapshot, createRows: false, createFields: [], records: Object.create(null) };
  if (snapshot) return capabilities;
  const tables = new Map<string, ReturnType<DatabaseBinding["store"]["table"]>>();
  const tableFor = (id: string) => { let table = tables.get(id); if (!table) { table = binding.store.table(id); tables.set(id, table); } return table; };
  const rows = new Map<string, ReturnType<DatabaseBinding["store"]["row"]>>();
  const mappings = new Map<string, ReturnType<DatabaseBinding["store"]["mapping"]>>();
  const root = tableFor(query.tableId);
  if (write && root.value.mode === "stored" && !query.joins?.length && !query.aggregates?.length && !query.groupBy?.length) {
    capabilities.createFields = result.columns.filter(literal).map(column => column.id);
    capabilities.createRows = root.value.columns.filter(column => column.required && literal(column)).every(column => capabilities.createFields.includes(column.id));
  }
  if (write && root.value.mode === "stored" && !query.aggregates?.length && !query.groupBy?.length) {
    // Refresh only the loaded root records and selected retained source fields.
    // Transient reference-only delivery needs its own evaluation-scoped contract.
    const columnIds = result.columns.filter(column => root.value.columns.some(actual => actual.id === column.id && (actual.binding?.kind === "request" || actual.binding?.kind === "entity") && actual.binding.retention !== "reference-only")).map(column => column.id);
    const rowIds = [...new Set(result.rows.flatMap(row => row.records?.$root?.tableId === root.id ? [row.records.$root.rowId] : []))];
    if (columnIds.length && rowIds.length && rowIds.length <= 100) capabilities.refresh = { tableId: root.id, rowIds, columnIds };
  }
  for (const row of result.rows) {
    const record: DatabaseQueryCapabilities["records"][string] = { editFields: [], reviewMemoryFields: [], actions: [] };
    capabilities.records[row.id] = record;
    for (const ref of Object.values(row.records ?? {})) {
      // Domain actions are registered by the host, never inferred from model-supplied column values.
      for (const action of binding.store.options.domains?.get(ref.tableId)?.actions ?? []) {
        if (action.kind === "approval.review" && !record.actions.some(existing => existing.recordId === ref.rowId && existing.kind === action.kind)) record.actions.push({ kind: "approval.review", label: action.label, recordId: ref.rowId });
      }
    }
    for (const column of result.columns) {
      const parts = column.id.split("."), alias = parts.length > 1 && row.records?.[parts[0]!] ? parts[0]! : "$root";
      const ref = row.records?.[alias], field = alias === "$root" ? column.id : parts.slice(1).join(".");
      if (!ref || field === "$id") continue;
      try {
        const table = tableFor(ref.tableId);
        binding.store.assertRead(ref.tableId, field, ref.rowId);
        if (table.value.mode !== "stored") continue;
        const actual = table.value.columns.find(candidate => candidate.id === field);
        if (!actual) continue;
        if (write && literal(actual)) record.editFields.push(column.id);
        if (!binding.entities || actual.binding?.kind !== "entity" || actual.binding.observationId || actual.binding.subjectField || actual.authority && actual.authority !== "entity") continue;
        const path = actual.binding.path;
        const key = JSON.stringify([ref.tableId, ref.rowId]);
        if (!rows.has(key)) rows.set(key, binding.store.row(ref.tableId, ref.rowId));
        const current = rows.get(key), mappingId = current?.value.entity?.mappingId;
        if (!mappingId) continue;
        let mapping = mappings.get(mappingId);
        if (!mapping) { mapping = binding.store.mapping(mappingId); mappings.set(mappingId, mapping); }
        if (mapping.value.tableId === ref.tableId && mapping.value.rowId === ref.rowId && mapping.value.subject === current.value.entity!.subject && mapping.value.fields.some(mapped => mapped.columnId === field && mapped.authority === "entity" && mapped.path === path)) record.reviewMemoryFields.push(column.id);
      } catch { /* Unavailable targets offer no controls; commands still recheck current authority. */ }
    }
  }
  return capabilities;
}
