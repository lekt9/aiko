import { canonical, decimalMath, fieldValue, identifier, integer } from "./codec.js";
import type { StructuredStore } from "./store.js";
import { DataError, type Cell, type Column, type Expression, type Filter, type Json, type Query, type QueryDependency, type QueryResult, type QueryRow, type RecordRevision, type RowData } from "./types.js";

const missing = (): Cell => ({ state: "missing", freshness: "unknown" });
const ready = (value: Json): Cell => ({ state: "ready", freshness: "fresh", value });
function numeric(value: Json): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  throw new DataError("invalid", "Arithmetic requires integers or decimal strings");
}
function compare(a: Json, b: Json, type?: string): number {
  if (type === "decimal") return decimalMath("compare", numeric(a), numeric(b)) as number;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (canonical(a) === canonical(b)) return 0;
  throw new DataError("invalid", "Cannot compare incompatible field values");
}
function expressionType(e: Expression, typeOf: (field: string) => string | undefined): string | undefined {
  if ("field" in e) return typeOf(e.field);
  if ("literal" in e) return typeof e.literal;
  if (["add", "subtract", "multiply", "divide"].includes(e.op)) return "decimal";
  if (e.op === "if" || e.op === "coalesce") {
    const types = e.args.slice(e.op === "if" ? 1 : 0).map(arg => expressionType(arg, typeOf));
    return types.includes("decimal") ? "decimal" : types[0];
  }
  return undefined;
}
function expression(e: Expression, read: (field: string) => Cell, typeOf: (field: string) => string | undefined, depth = 0): Cell {
  if (depth > 16) throw new DataError("limit", "Formula depth exceeds 16");
  if ("literal" in e) return ready(e.literal);
  if ("field" in e) return read(e.field);
  if (!Array.isArray(e.args) || e.args.length > 16) throw new DataError("invalid", "Invalid formula arguments");
  if (e.op === "if") {
    if (e.args.length !== 3) throw new DataError("invalid", "if requires three arguments");
    const condition = expression(e.args[0]!, read, typeOf, depth + 1);
    if (condition.state !== "ready") return condition;
    if (typeof condition.value !== "boolean") throw new DataError("invalid", "if condition must be boolean");
    const branch = expression(e.args[condition.value ? 1 : 2]!, read, typeOf, depth + 1);
    if (condition.freshness !== "fresh" && branch.state === "ready") return { ...branch, freshness: "stale" };
    return branch;
  }
  const args = e.args.map(a => expression(a, read, typeOf, depth + 1));
  if (e.op === "coalesce") {
    // Unavailable evidence cannot be silently replaced by a plausible default.
    for (const a of args) { if (["error", "unavailable"].includes(a.state)) return a; if (a.state === "ready" && a.value !== null) return a; }
    return ready(null);
  }
  const failure = args.find(a => a.state !== "ready"); if (failure) return failure;
  const values = args.map(a => a.value!), fresh = args.every(a => a.freshness === "fresh");
  let value: Json;
  if (["add", "subtract", "multiply", "divide"].includes(e.op)) {
    if (values.length !== 2) throw new DataError("invalid", "Arithmetic requires two arguments");
    const result = decimalMath(e.op as "add" | "subtract" | "multiply" | "divide", numeric(values[0]!), numeric(values[1]!)) as string;
    value = values.every(v => typeof v === "number") && !result.includes(".") && Number.isSafeInteger(Number(result)) ? Number(result) : result;
  } else if (["eq", "gt", "lt"].includes(e.op)) {
    if (values.length !== 2) throw new DataError("invalid", "Comparison requires two arguments");
    const type = e.args.some(arg => expressionType(arg, typeOf) === "decimal") ? "decimal" : undefined;
    const c = compare(values[0]!, values[1]!, type); value = e.op === "eq" ? c === 0 : e.op === "gt" ? c > 0 : c < 0;
  } else if (e.op === "and" || e.op === "or" || e.op === "not") {
    if (!values.length || values.some(v => typeof v !== "boolean") || e.op === "not" && values.length !== 1) throw new DataError("invalid", "Boolean formula arguments required");
    value = e.op === "not" ? !values[0] : e.op === "and" ? values.every(Boolean) : values.some(Boolean);
  } else if (e.op === "concat") {
    if (values.some(v => typeof v !== "string")) throw new DataError("invalid", "concat requires text"); value = values.join("");
  } else throw new DataError("invalid", "Unknown formula operation");
  return { ...ready(value), freshness: fresh ? "fresh" : "stale" };
}

/** One bounded evaluation owns its cell cache; no network or durable writes occur here. */
export function evaluateQuery(store: StructuredStore, query: Query): QueryResult {
  identifier(query.tableId); const table = store.table(query.tableId);
  const budget = query.maxRows ?? 2000, maxBytes = query.maxBytes ?? 262144, limit = query.limit ?? 50;
  integer(budget, 1, 10000); integer(maxBytes, 1024, 1048576); integer(limit, 1, 500);
  const revision = store.revision(), reasons = new Set<string>();
  const domains = store.domainRevisions();
  const dependencies = new Map<string, QueryDependency>();
  const byteLength = (value: unknown) => new TextEncoder().encode(canonical(value)).length;
  let manifestBytes = 2;
  const depend = (dependency: QueryDependency) => {
    store.assertDependency(dependency);
    const key = canonical([dependency.tableId, dependency.tableRevision, dependency.rowId ?? null, dependency.rowRevision ?? null, dependency.columnId ?? null]);
    const previous = dependencies.get(key);
    manifestBytes += byteLength(dependency) - (previous ? byteLength(previous) : -1);
    if (manifestBytes > maxBytes) throw new DataError("limit", "Query dependency evidence exceeds byte budget");
    dependencies.set(key, JSON.parse(canonical(dependency)));
  };
  depend({ tableId: table.id, tableRevision: table.revision });
  if (query.cursor && query.cursor.revision !== revision) throw new DataError("conflict", "Query data changed; restart pagination");
  if (query.cursor && canonical(query.cursor.domains ?? {}) !== canonical(domains)) throw new DataError("conflict", "Domain data changed; restart pagination");
  const offset = query.cursor?.offset ?? 0; integer(offset, 0, 10000);
  const cells = new Map<string, Cell>(), active = new Set<string>(); let evaluations = 0;
  const tables = new Map([[table.id, table]]);
  const schema = (id: string) => { let t = tables.get(id); if (!t) { t = store.table(id); tables.set(id, t); depend({ tableId: id, tableRevision: t.revision }); } return t; };
  const read = (tableId: string, row: RecordRevision<RowData>, columnId: string): Cell => {
    if (columnId === "$id") { depend({ tableId, tableRevision: schema(tableId).revision, rowId: row.id, rowRevision: row.revision }); return ready(row.id); }
    store.assertRead(tableId, columnId, row.id);
    const t = schema(tableId), column = t.value.columns.find(c => c.id === columnId);
    if (!column) throw new DataError("invalid", `Unknown query field ${columnId}`);
    const id = canonical([tableId, row.id, columnId]);
    const cached = cells.get(id); if (cached) return cached;
    if (active.has(id)) throw new DataError("invalid", "Cyclic computed relation");
    if (++evaluations > budget * 128 || active.size >= 32) throw new DataError("limit", "Field dependency budget exceeded");
    active.add(id); let result: Cell;
    try {
    const dependency: QueryDependency = { tableId, tableRevision: t.revision, rowId: row.id, rowRevision: row.revision, columnId };
    const binding = column.binding;
    if (!Object.hasOwn(row.value.overrides ?? {}, columnId) && (binding?.kind === "request" || binding?.kind === "entity")) {
      dependency.retention = binding.retention;
      if (binding.kind === "request") dependency.source = { kind: "request", id: binding.sourceId, contractDigest: binding.contractDigest };
      else {
        const subject = binding.subject ?? (binding.subjectField ? read(tableId, row, binding.subjectField).value : undefined);
        dependency.source = { kind: "entity", ...(typeof subject === "string" ? { subject } : {}), ...(binding.observationId ? { observationId: binding.observationId } : {}) };
      }
    }
    depend(dependency);
      if (row.value.overrides && Object.hasOwn(row.value.overrides, columnId)) result = { ...ready(row.value.overrides[columnId]!), overridden: true, source: "override" };
      else {
        const b = column.binding;
        if (!b || b.kind === "literal") result = Object.hasOwn(row.value.values, columnId) ? ready(row.value.values[columnId]!) : missing();
        else if (b.kind === "formula") result = expression(b.expression, field => read(tableId, row, field), field => t.value.columns.find(c => c.id === field)?.type);
        else if (b.kind === "lookup") {
          const relation = t.value.columns.find(c => c.id === b.relation);
          if (!relation?.relation) throw new DataError("invalid", "Lookup must use a relation column");
          const targets = read(tableId, row, b.relation);
          if (targets.state !== "ready") result = targets;
          else {
            const ids = targets.value == null ? [] : Array.isArray(targets.value) ? targets.value : [targets.value];
            const selected = ids.map(targetId => { const target = store.row(relation.relation!.tableId, String(targetId)); return target ? read(relation.relation!.tableId, target, b.field) : { ...missing(), error: "Relation target missing" }; });
            const unavailable = selected.find(c => c.state !== "ready");
            if (unavailable) result = unavailable;
            else if (b.aggregate === "first") {
              if (selected.length > 1) throw new DataError("invalid", "Scalar lookup has multiple targets"); result = selected[0] ?? missing();
            } else if (b.aggregate === "list") result = ready(selected.map(c => c.value!));
            else if (b.aggregate === "count") result = ready(selected.length);
            else if (b.aggregate === "sum") result = ready(selected.reduce((sum, c) => decimalMath("add", sum, numeric(c.value!)) as string, "0"));
            else throw new DataError("invalid", "Unknown lookup aggregation");
            if (selected.some(c => c.freshness !== "fresh") && result.state === "ready") result.freshness = "stale";
          }
        } else {
          const saved = store.cell(tableId, row.id, columnId);
          if (dependency.source?.kind === "request" && saved && (saved.cell.sourceGeneration || saved.cell.value !== undefined)) { dependency.source.generation = saved.cell.sourceGeneration ?? "legacy-unverified"; depend(dependency); }
          if (saved?.cell.lineage?.length) { dependency.lineage = saved.cell.lineage; depend(dependency); }
          if (!saved || saved.retention === "reference-only" || b.retention !== saved.retention || saved.tableRevision !== t.revision || saved.rowRevision !== row.revision) result = { state: "unavailable", freshness: "unknown", source: b.kind === "request" ? b.sourceId : b.subject ?? "entity" };
          else {
            result = { ...saved.cell };
            if (saved.tableRevision !== t.revision || saved.rowRevision !== row.revision || b.kind === "request" && (result.checkedAt === undefined || result.checkedAt + b.refresh.maxAgeSeconds * 1000 < store.now())) result.freshness = "stale";
          }
        }
      }
      if (result.state === "ready") result.value = fieldValue(column, result.value!);
      result = { ...result, lineage: [...new Set([...(result.lineage ?? []), `table:${tableId}:${t.revision}`, `row:${tableId}:${row.id}:${row.revision}`])] };
    } catch (error) {
      if (error instanceof DataError && ["forbidden", "limit"].includes(error.code)) throw error;
      result = { state: "error", freshness: "unknown", error: error instanceof DataError ? error.message : "Invalid computed field" };
    } finally { active.delete(id); }
    cells.set(id, result); return result;
  };
  let columns = cloneColumns(table.value.columns);
  // Schema and binding metadata are also protected when the table is empty.

  const aliases = new Set<string>();
  if (query.joins && query.joins.length > 4) throw new DataError("limit", "At most four joins");
  for (const join of query.joins ?? []) {
    identifier(join.as); if (join.as.includes(".") || aliases.has(join.as)) throw new DataError("invalid", "Join aliases must be unique without dots"); aliases.add(join.as);
    if (!["left", "inner"].includes(join.kind) || !["one", "many"].includes(join.cardinality)) throw new DataError("invalid", "Join type and cardinality required");
    const target = schema(join.tableId);

    columns.push(...target.value.columns.map(c => ({ ...c, id: `${join.as}.${c.id}` })), { id: `${join.as}.$id`, name: `${join.as} ID`, type: "text" });
  }
  const columnById = new Map(columns.map(c => [c.id, c])); columnById.set("$id", { id: "$id", name: "ID", type: "text" });
  const assertField = (field: string) => { if (!columnById.has(field)) throw new DataError("invalid", `Unknown query field ${field}`); };
  const aggregateAliases = new Set(query.aggregates?.map(a => a.as) ?? []);
  const assertOutputField = (field: string) => { if (!aggregateAliases.has(field)) assertField(field); };
  query.select?.forEach(assertOutputField); query.sort?.forEach(s => { assertOutputField(s.field); if (!["asc", "desc"].includes(s.direction)) throw new DataError("invalid", "Invalid sort direction"); }); query.groupBy?.forEach(assertField);
  const checkFilter = (filter: Filter, depth = 0) => {
    if (depth > 8) throw new DataError("limit", "Filter depth exceeds eight");
    if ("filters" in filter) { if (!["and", "or"].includes(filter.op) || filter.filters.length > 32) throw new DataError("invalid", "Invalid filter group"); filter.filters.forEach(f => checkFilter(f, depth + 1)); }
    else { assertField(filter.field); if (!["eq", "ne", "lt", "lte", "gt", "gte", "contains", "in", "is-null", "is-missing"].includes(filter.op)) throw new DataError("invalid", "Unknown filter operator"); }
  };
  if (query.filter) checkFilter(query.filter);
  const matches = (row: QueryRow, f: Filter): boolean => {
    if ("filters" in f) return f.op === "and" ? f.filters.every(child => matches(row, child)) : f.filters.some(child => matches(row, child));
    const cell = row.cells[f.field] ?? missing();
    if (f.op === "is-missing") return cell.state === "missing";
    if (cell.state !== "ready") { if (cell.state !== "missing") reasons.add("unresolved_filter_input"); return false; }
    if (cell.freshness !== "fresh") reasons.add("stale_filter_input");
    if (f.op === "is-null") return cell.value === null;
    if (f.value === undefined) throw new DataError("invalid", "Filter value required");
    if (f.op === "contains") return typeof cell.value === "string" && typeof f.value === "string" ? cell.value.includes(f.value) : Array.isArray(cell.value) && cell.value.some(v => canonical(v) === canonical(f.value));
    if (f.op === "in") { if (!Array.isArray(f.value)) throw new DataError("invalid", "in requires a list"); return f.value.some(v => canonical(v) === canonical(cell.value)); }
    if (f.op === "eq" || f.op === "ne") { const eq = canonical(cell.value) === canonical(f.value); return f.op === "eq" ? eq : !eq; }
    if (cell.value === null || f.value === null) return false;
    const c = compare(cell.value!, f.value, columnById.get(f.field)?.type);
    return f.op === "lt" ? c < 0 : f.op === "lte" ? c <= 0 : f.op === "gt" ? c > 0 : c >= 0;
  };
  const needed = new Set<string>(query.aggregates?.length || query.groupBy?.length ? [...(query.groupBy ?? []), ...(query.aggregates ?? []).flatMap(a => a.field ? [a.field] : [])] : query.select ?? columns.map(c => c.id));
  for (const sort of query.sort ?? []) if (!aggregateAliases.has(sort.field)) needed.add(sort.field);
  const filterFields = (filter: Filter) => { if ("filters" in filter) filter.filters.forEach(filterFields); else needed.add(filter.field); };
  if (query.filter) filterFields(query.filter);
  for (const join of query.joins ?? []) { needed.add(join.on.local); needed.add(`${join.as}.${join.on.foreign}`); }
  // Authorize selected metadata even for empty tables, then recursively authorize
  // only the value dependencies actually used by those fields.
  for (const field of needed) {
    assertField(field);
    const dot = field.indexOf("."), alias = dot < 0 ? undefined : field.slice(0, dot);
    const sourceId = alias ? query.joins!.find(join => join.as === alias)!.tableId : table.id;
    const columnId = dot < 0 ? field : field.slice(dot + 1), definition = schema(sourceId);
    store.assertRead(sourceId, columnId === "$id" ? undefined : columnId);
    if (columnId !== "$id") {
      const column = definition.value.columns.find(c => c.id === columnId)!;
      const dependency: QueryDependency = { tableId: sourceId, tableRevision: definition.revision, columnId };
      if (column.binding?.kind === "request") { dependency.retention = column.binding.retention; dependency.source = { kind: "request", id: column.binding.sourceId, contractDigest: column.binding.contractDigest }; }
      else if (column.binding?.kind === "entity") { dependency.retention = column.binding.retention; dependency.source = { kind: "entity", ...(column.binding.subject ? { subject: column.binding.subject } : {}), ...(column.binding.observationId ? { observationId: column.binding.observationId } : {}) }; }
      depend(dependency);
    }
  }
  const exactRow = query.filter && "field" in query.filter && query.filter.field === "$id" && query.filter.op === "eq" && typeof query.filter.value === "string" ? query.filter.value : undefined;
  const source = exactRow === undefined ? store.rows(table.id, budget) : { rows: [store.row(table.id, exactRow)].filter((row): row is RecordRevision<RowData> => row !== undefined), complete: true };
  let scanned = source.rows.length;
  if (!source.complete) reasons.add("candidate_budget");
  let rows: QueryRow[] = source.rows.map(r => ({ id: r.id, revision: r.revision, records: { $root: { tableId: table.id, rowId: r.id, revision: r.revision } }, cells: Object.fromEntries([["$id", ready(r.id)], ...table.value.columns.filter(c => needed.has(c.id)).map(c => [c.id, read(table.id, r, c.id)])]) }));
  for (const join of query.joins ?? []) {
    assertField(join.on.local);
    const target = schema(join.tableId), foreignColumn = join.on.foreign === "$id" ? { type: "text" } : target.value.columns.find(c => c.id === join.on.foreign);
    if (!foreignColumn) throw new DataError("invalid", "Unknown foreign join field");
    const candidates = store.rows(join.tableId, budget); scanned += candidates.rows.length;
    if (!candidates.complete) reasons.add("join_candidate_budget");
    const indexed = new Map<string, RecordRevision<RowData>[]>();
    for (const candidate of candidates.rows) {
      const cell = read(join.tableId, candidate, join.on.foreign);
      if (cell.state !== "ready" || cell.value === null) { if (cell.state === "unavailable" || cell.state === "error") reasons.add("unresolved_join_input"); continue; }
      const k = canonical(cell.value); indexed.set(k, [...indexed.get(k) ?? [], candidate]);
    }
    const expanded: QueryRow[] = [];
    for (const row of rows) {
      const local = row.cells[join.on.local] ?? missing();
      const keys = local.state === "ready" && local.value != null ? Array.isArray(local.value) ? local.value : [local.value] : [];
      if (["error", "unavailable"].includes(local.state)) reasons.add("unresolved_join_input");
      const matches = [...new Map(keys.flatMap(k => indexed.get(canonical(k)) ?? []).map(r => [r.id, r])).values()];
      if (join.cardinality === "one" && matches.length > 1) throw new DataError("conflict", "Join cardinality exceeded");
      for (const match of matches.length ? matches : join.kind === "left" ? [undefined] : []) {
        if (expanded.length >= budget) { reasons.add("join_expansion_budget"); break; }
        expanded.push({ ...row, id: `${row.id}/${join.as}:${match?.id ?? "-"}`, records: { ...row.records, ...(match ? { [join.as]: { tableId: join.tableId, rowId: match.id, revision: match.revision } } : {}) }, cells: { ...row.cells, [`${join.as}.$id`]: match ? ready(match.id) : missing(), ...Object.fromEntries(target.value.columns.filter(c => needed.has(`${join.as}.${c.id}`)).map(c => [`${join.as}.${c.id}`, match ? read(join.tableId, match, c.id) : missing()])) } });
      }
    }
    rows = expanded;
  }
  if (query.filter) rows = rows.filter(r => matches(r, query.filter!));
  if (query.aggregates?.length || query.groupBy?.length) {
    if ((query.aggregates?.length ?? 0) > 32 || (query.groupBy?.length ?? 0) > 8) throw new DataError("limit", "Aggregation dimensions exceeded");
    const groups = new Map<string, QueryRow[]>();
    if (!query.groupBy?.length) groups.set("[]", rows);
    else for (const row of rows) { const k = canonical(query.groupBy.map(field => { const c = row.cells[field] ?? missing(); return { state: c.state, value: c.value ?? null }; })); groups.set(k, [...groups.get(k) ?? [], row]); }
    const aliases = new Set(query.groupBy ?? []);
    for (const a of query.aggregates ?? []) {
      identifier(a.as); if (aliases.has(a.as)) throw new DataError("invalid", "Duplicate aggregate alias"); aliases.add(a.as);
      if (!["count", "sum", "min", "max", "average"].includes(a.op)) throw new DataError("invalid", "Unknown aggregate");
      if (a.field) assertField(a.field); else if (a.op !== "count") throw new DataError("invalid", "Aggregate field required");
    }
    rows = [...groups].map(([id, group]) => {
      const output: Record<string, Cell> = Object.fromEntries((query.groupBy ?? []).map(field => [field, group[0]?.cells[field] ?? missing()]));
      for (const a of query.aggregates ?? []) {
        const selected = a.field ? group.map(r => r.cells[a.field!] ?? missing()) : [];
        if (selected.some(c => ["unavailable", "error"].includes(c.state))) { reasons.add("unresolved_aggregate_input"); output[a.as] = { state: "unavailable", freshness: "unknown" }; continue; }
        const values = selected.filter(c => c.state === "ready" && c.value !== null).map(c => c.value!);
        let result: Json = null;
        if (a.op === "count") result = a.field ? values.length : group.length;
        else if (a.op === "sum" || a.op === "average") {
          const sum = values.reduce<string>((n, v) => decimalMath("add", n, numeric(v)) as string, "0");
          if (a.op === "sum") result = sum;
          else if (values.length) { try { result = decimalMath("divide", sum, String(values.length)) as string; } catch { output[a.as] = { state: "error", freshness: "unknown", error: "Average requires an explicit rounding policy" }; continue; } }
        } else if (values.length) result = values.reduce((best, v) => (compare(v, best, columnById.get(a.field!)?.type) * (a.op === "min" ? 1 : -1)) < 0 ? v : best);
        output[a.as] = { ...ready(result), freshness: selected.some(c => c.freshness !== "fresh") ? "stale" : "fresh" };
      }
      return { id, revision, cells: output };
    });
    columns = [...(query.groupBy ?? []).map(id => columnById.get(id)!), ...(query.aggregates ?? []).map(a => ({ id: a.as, name: a.as, type: a.op === "count" ? "integer" as const : a.field && ["min", "max"].includes(a.op) ? columnById.get(a.field)!.type : "decimal" as const, nullable: true }))];
  }
  if (query.sort?.length) rows.sort((a, b) => {
    for (const sort of query.sort!) {
      const x = a.cells[sort.field], y = b.cells[sort.field];
      const xm = !x || x.state !== "ready" || x.value === null, ym = !y || y.state !== "ready" || y.value === null;
      if (xm || ym) { if (xm !== ym) return xm ? 1 : -1; continue; }
      const c = compare(x.value!, y.value!, columns.find(c => c.id === sort.field)?.type); if (c) return sort.direction === "asc" ? c : -c;
    }
    return a.id < b.id ? -1 : a.id === b.id ? 0 : 1;
  });
  const matched = rows.length;
  rows = rows.slice(offset, offset + limit);
  if (query.select) { rows = rows.map(r => ({ ...r, cells: Object.fromEntries(query.select!.map(field => [field, r.cells[field] ?? missing()])) })); const outputColumns = new Map(columns.map(c => [c.id, c])); if (!query.aggregates?.length && !query.groupBy?.length) outputColumns.set("$id", columnById.get("$id")!); columns = query.select.map(id => { const c = outputColumns.get(id); if (!c) throw new DataError("invalid", `Field ${id} is not an aggregate output`); return c; }); }
  let bytes = byteLength(columns) + manifestBytes;
  const bounded: QueryRow[] = [];
  for (const row of rows) { bytes += byteLength(row); if (bytes > maxBytes) { reasons.add("result_byte_budget"); break; } bounded.push(row); }
  const next = offset + bounded.length;
  if (next < matched) reasons.add("page_limit");
  if (bounded.some(r => Object.values(r.cells).some(c => c.state === "unavailable" || c.state === "error"))) reasons.add("unresolved_values");
  const result: QueryResult = { rows: bounded, columns, revision, coverage: reasons.size ? "partial" : "complete", reasons: [...reasons], scanned, matched, dependencies: [...dependencies.values()], ...(next < matched && bounded.length ? { nextCursor: { revision, offset: next, ...(Object.keys(domains).length ? { domains } : {}) } } : {}) };
  if (byteLength(result) > maxBytes) throw new DataError("limit", "Query result metadata exceeds byte budget");
  return result;
}
function cloneColumns(columns: Column[]): Column[] { return columns.map(c => ({ ...c })); }
