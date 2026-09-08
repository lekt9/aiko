import { createHash } from "node:crypto";
import { canonical, clone, DataError, fieldValue, identifier, integer, validateColumns, type Cell, type Column, type Command, type Json, type QueryDependency, type Receipt } from "../../../packages/structured-data/src/index.ts";
import type { Event } from "tardie/core/event";
import type { DatabaseBinding, DatabaseRequest } from "./database-component.ts";

export interface DatabaseSource {
  digest: string;
  generation: string;
  stepIds: string[];
  inputs: { name: string; type: string; required: boolean }[];
  execute(inputs: Record<string, Json>, consume: (step: string, body: unknown) => void, signal: AbortSignal, budget: { maxCalls: number; maxBytes: number }): Promise<{ calls: number; bytes: number }>;
}
export type DatabaseSourceResolver = (sourceId: string, digest: string, signal: AbortSignal) => Promise<DatabaseSource>;
type RequestBinding = Extract<NonNullable<Column["binding"]>, { kind: "request" }>;
type Selection = { rowId: string; rowRevision: number; column: Column; binding: RequestBinding };
interface Group { id: string; sourceId: string; digest: string; generation: string; inputs: Record<string, Json>; selections: Selection[] }
interface Plan { version: 1; owner: string; operationId: string; tableId: string; tableRevision: number; at: number; deadline: number; maxCalls: number; maxBytes: number; partial: boolean; groups: Group[] }
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

async function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw signal.reason; }
  let stop: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(signal.reason); signal.addEventListener("abort", stop, { once: true }); });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", stop); }
}

/** RFC 6901 lookup: a missing path differs from an explicit JSON null. */
export function selectDatabaseValue(body: unknown, pointer: string): Json | undefined {
  if (typeof pointer !== "string" || pointer.length > 2048 || pointer !== "" && !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) throw new DataError("invalid", "Invalid response selector");
  let value = body;
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part) || Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(part)) return undefined;
    value = (value as Record<string, Json>)[part];
  }
  return value === undefined ? undefined : clone(value) as Json;
}

/** Source authority is checked against exact captured dependencies, including snapshots. */
export async function authorizeDatabaseDependencies(binding: DatabaseBinding, dependencies: readonly QueryDependency[], signal: AbortSignal) {
  const checks = new Map<string, Promise<DatabaseSource>>();
  for (const dependency of dependencies) {
    const source = dependency.source;
    if (source?.kind !== "request") continue;
    if (!binding.sources) throw new DataError("forbidden", "Database source authority unavailable");
    const key = canonical([source.id, source.contractDigest]);
    let check = checks.get(key);
    if (!check) { check = binding.sources(source.id, source.contractDigest, signal); checks.set(key, check); }
    let current: DatabaseSource;
    try { current = await check; } catch { throw new DataError("forbidden", "Database source authority unavailable"); }
    if (current.digest !== source.contractDigest || source.generation !== undefined && current.generation !== source.generation) throw new DataError("forbidden", "Database source generation changed");
    signal.throwIfAborted();
  }
}

async function source(binding: DatabaseBinding, definition: RequestBinding, signal: AbortSignal) {
  if (!binding.sources) throw new DataError("unavailable", "Database source executor unavailable");
  const resolved = await withinSignal(binding.sources(definition.sourceId, definition.contractDigest, signal), signal);
  if (resolved.digest !== definition.contractDigest || !resolved.stepIds.includes(definition.select.stepId)) throw new DataError("invalid", "Binding does not match source contract");
  selectDatabaseValue(undefined, definition.select.jsonPointer);
  for (const name of Object.keys(definition.inputs)) if (!resolved.inputs.some(input => input.name === name)) throw new DataError("invalid", "Unknown source input");
  for (const input of resolved.inputs) if (input.required && !Object.hasOwn(definition.inputs, input.name)) throw new DataError("invalid", "Required source input missing");
  return resolved;
}

export async function authorizeDatabaseCommand(binding: DatabaseBinding, command: Command, signal: AbortSignal) {
  if (command.kind === "table.define") for (const column of validateColumns(command.table.columns)) if (column.binding?.kind === "request") await source(binding, column.binding, signal);
  if (command.kind === "view.save") await authorizeDatabaseDependencies(binding, binding.store.query({ ...command.view.query, limit: 1 }).dependencies, signal);
  if (command.kind === "artifact.create") {
    const view = binding.store.record<import("../../../packages/structured-data/src/index.ts").ViewDefinition>("view", command.viewId, command.viewRevision);
    if (!view) throw new DataError("missing", "View unavailable");
    await authorizeDatabaseDependencies(binding, binding.store.query(view.value.query).dependencies, signal);
  }
}

async function planRefresh(binding: DatabaseBinding, request: DatabaseRequest, command: Extract<Command, { kind: "table.refresh" }>, signal: AbortSignal): Promise<Plan> {
  identifier(command.tableId);
  const maxRows = command.budget?.maxRows ?? 100, maxCalls = command.budget?.maxCalls ?? 16, maxBytes = command.budget?.maxBytes ?? 1048576, timeoutMs = command.budget?.timeoutMs ?? 15000;
  integer(maxRows, 1, 500); integer(maxCalls, 1, 64); integer(maxBytes, 1024, 4194304); integer(timeoutMs, 100, 60000);
  if (command.mode !== undefined && !["all", "stale"].includes(command.mode)) throw new DataError("invalid", "Unknown refresh mode");
  for (const ids of [command.rowIds, command.columnIds]) if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length) throw new DataError("invalid", "Invalid refresh selection");
    ids.forEach(id => identifier(id));
  }
  const table = binding.store.table(command.tableId);
  if (table.value.mode !== "stored") throw new DataError("forbidden", "Domain collections own their refresh");
  const columns = table.value.columns.filter(column => column.binding?.kind === "request" && (!command.columnIds || command.columnIds.includes(column.id)));
  if (command.columnIds?.some(id => !columns.some(column => column.id === id))) throw new DataError("invalid", "Refresh selection must contain request fields");
  const rows = command.rowIds ? { rows: command.rowIds.slice(0, maxRows).map(id => {
    const row = binding.store.row(table.id, id); if (!row) throw new DataError("missing", "Refresh row unavailable"); return row;
  }), complete: command.rowIds.length <= maxRows } : binding.store.rows(table.id, maxRows);
  const groups = new Map<string, Group>(), contracts = new Map<string, DatabaseSource>();
  const at = (binding.now ?? Date.now)();
  for (const column of columns) {
    const definition = column.binding as RequestBinding;
    const resolved = await source(binding, definition, signal);
    contracts.set(column.id, resolved);
  }
  for (const row of rows.rows) {
    const inputFields = [...new Set(columns.flatMap(column => Object.values((column.binding as RequestBinding).inputs).flatMap(input => "rowField" in input ? [input.rowField] : [])))];
    const query = binding.store.query({ tableId: table.id, select: inputFields.length ? inputFields : ["$id"], filter: { field: "$id", op: "eq", value: row.id }, maxRows: 10000, limit: 1 });
    await authorizeDatabaseDependencies(binding, query.dependencies, signal);
    const values = query.rows[0]?.cells;
    if (!values) throw new DataError("unavailable", "Refresh input row unavailable");
    for (const column of columns) {
      if (Object.hasOwn(row.value.overrides ?? {}, column.id)) continue;
      const definition = column.binding as RequestBinding, resolved = contracts.get(column.id)!;
      const saved = binding.store.cell(table.id, row.id, column.id);
      if (command.mode === "stale" && saved?.retention !== "reference-only" && saved?.tableRevision === table.revision && saved.rowRevision === row.revision && saved.cell.state === "ready" && saved.cell.freshness === "fresh" && saved.cell.sourceGeneration === resolved.generation && (saved.cell.checkedAt ?? 0) + definition.refresh.maxAgeSeconds * 1000 >= at) continue;
      const inputs: Record<string, Json> = {};
      for (const [name, mapping] of Object.entries(definition.inputs)) {
        if ("literal" in mapping) inputs[name] = mapping.literal;
        else {
          const cell = values[mapping.rowField];
          if (!cell || cell.state !== "ready" || cell.freshness !== "fresh") throw new DataError("unavailable", "Refresh requires a fresh input dependency");
          inputs[name] = cell.value!;
        }
      }
      const id = hash([binding.owner, definition.sourceId, definition.contractDigest, resolved.generation, inputs]);
      let group = groups.get(id);
      if (!group) { group = { id, sourceId: definition.sourceId, digest: definition.contractDigest, generation: resolved.generation, inputs, selections: [] }; groups.set(id, group); }
      group.selections.push({ rowId: row.id, rowRevision: row.revision, column, binding: definition });
    }
  }
  signal.throwIfAborted();
  if (groups.size > 64 || new TextEncoder().encode(canonical([...groups.values()])).length > 1048576) throw new DataError("limit", "Refresh plan exceeds budget");
  return { version: 1, owner: binding.owner, operationId: request.id, tableId: table.id, tableRevision: table.revision, at, deadline: at + timeoutMs, maxCalls, maxBytes, partial: !rows.complete, groups: [...groups.values()] };
}

/** One native operation, with a sealed plan and independently recoverable group commits.
 * No transaction spans source I/O. A committed group is never fetched again on replay. */
export async function executeDatabaseRefresh(binding: DatabaseBinding, request: DatabaseRequest, command: Extract<Command, { kind: "table.refresh" }>, journal: { read(): Promise<readonly Event[]>; append(events: Event[]): Promise<unknown> }, signal: AbortSignal): Promise<Receipt> {
  const events = await journal.read();
  const planned = events.find(event => event.type === "AikoDatabaseRefreshPlanned" && event.owner === binding.owner && event.thread === binding.thread && event.id === request.id);
  let plan: Plan, planRef: string;
  if (planned) {
    planRef = String(planned.planRef); plan = await binding.custody.get(binding.owner, planRef) as Plan;
  } else {
    const planningMs = command.budget?.timeoutMs ?? 15000; integer(planningMs, 100, 60000);
    plan = await planRefresh(binding, request, command, AbortSignal.any([signal, AbortSignal.timeout(planningMs)]));
    planRef = await binding.custody.put(binding.owner, plan);
    await journal.append([{ type: "AikoDatabaseRefreshPlanned", owner: binding.owner, thread: binding.thread, id: request.id, planRef, groups: plan.groups.length, at: plan.at }]);
  }
  if (plan.version !== 1 || plan.owner !== binding.owner || plan.operationId !== request.id) throw new DataError("forbidden", "Refresh plan owner mismatch");
  let calls = 0, bytes = 0, committed = 0, failed = 0;
  const changed = new Set<string>(), reasons = new Set<string>(plan.partial ? ["row_budget"] : []);
  for (const group of plan.groups) {
    signal.throwIfAborted();
    const groupId = hash([request.id, group.id]);
    const prior = binding.store.receipt(groupId);
    if (prior) {
      committed++; for (const field of (prior.result as { changed: string[] }).changed) changed.add(field);
      const check = prior.result as { calls?: number; bytes?: number; status?: string; code?: string };
      calls += check.calls ?? plan.maxCalls; bytes += check.bytes ?? plan.maxBytes;
      if (check.status !== "completed") { failed++; reasons.add(check.code ?? "interrupted_read"); }
      continue;
    }
    const remainingMs = plan.deadline - (binding.now ?? Date.now)();
    if (calls >= plan.maxCalls || bytes >= plan.maxBytes || remainingMs <= 0) { reasons.add("refresh_budget"); break; }
    // At most one physical attempt per group in this occurrence. A lost attempt
    // is disclosed, not repeated after a process crash with uncertain call costs.
    const started = (await journal.read()).some(event => event.type === "AikoDatabaseRefreshGroupStarted" && event.owner === binding.owner && event.id === groupId);
    if (started) { failed++; reasons.add("interrupted_read"); continue; }
    if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Refresh authority revoked");
    await journal.append([{ type: "AikoDatabaseRefreshGroupStarted", owner: binding.owner, thread: binding.thread, id: groupId, operationId: request.id, at: (binding.now ?? Date.now)() }]);
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]);
    const selected = new Map<string, Cell>();
    let count = { calls: 0, bytes: 0 }, error: string | undefined;
    try {
      const resolved = await withinSignal(binding.sources!(group.sourceId, group.digest, boundedSignal), boundedSignal);
      if (resolved.digest !== group.digest || resolved.generation !== group.generation) throw new DataError("forbidden", "Source generation changed");
      count = await withinSignal(resolved.execute(group.inputs, (stepId, body) => {
        boundedSignal.throwIfAborted();
        for (const item of group.selections) if (item.binding.select.stepId === stepId) {
          const value = selectDatabaseValue(body, item.binding.select.jsonPointer);
          selected.set(canonical([item.rowId, item.column.id]), value === undefined ? { state: "missing", freshness: "fresh" } : { state: "ready", freshness: "fresh", value: fieldValue(item.column, value) });
        }
      }, boundedSignal, { maxCalls: plan.maxCalls - calls, maxBytes: plan.maxBytes - bytes }), boundedSignal);
      const current = await withinSignal(binding.sources!(group.sourceId, group.digest, boundedSignal), boundedSignal);
      if (current.generation !== group.generation || current.digest !== group.digest || !await binding.authorize("write", boundedSignal)) throw new DataError("forbidden", "Source authority changed");
    } catch (e) {
      signal.throwIfAborted(); error = e instanceof DataError ? e.code : "source_unavailable";
      // A failing transport cannot promise its physical attempt count. Exhaust
      // this occurrence's budget rather than dispatching more requests blindly.
      count = { calls: plan.maxCalls - calls, bytes: plan.maxBytes - bytes }; selected.clear(); failed++; reasons.add(error);
    }
    calls += count.calls; bytes += count.bytes;
    const rows = new Map<string, { rowId: string; rowRevision: number; cells: Record<string, { cell: Cell; retention: RequestBinding["retention"] }> }>();
    for (const item of group.selections) {
      let row = rows.get(item.rowId); if (!row) { row = { rowId: item.rowId, rowRevision: item.rowRevision, cells: {} }; rows.set(item.rowId, row); }
      const cell = selected.get(canonical([item.rowId, item.column.id])) ?? { state: "error" as const, freshness: "unknown" as const, error: error ?? "missing_response_step" };
      row.cells[item.column.id] = { cell: { ...cell, source: group.sourceId, sourceGeneration: group.generation, lineage: [`request:${group.digest}:${group.generation}`] }, retention: item.binding.retention };
    }
    signal.throwIfAborted();
    if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Refresh authority revoked");
    const receipt = await binding.store.commitCells(groupId, { tableId: plan.tableId, tableRevision: plan.tableRevision, rows: [...rows.values()], check: { ...count, status: error ? "failed" : "completed", ...(error ? { code: error } : {}) } }, (binding.now ?? Date.now)());
    committed++; for (const field of (receipt.result as { changed: string[] }).changed) changed.add(field);
    await journal.append([{ type: "AikoDatabaseRefreshGroupSettled", owner: binding.owner, thread: binding.thread, id: groupId, operationId: request.id, calls: count.calls, bytes: count.bytes, status: error ? "failed" : "completed", at: (binding.now ?? Date.now)() }]);
  }
  signal.throwIfAborted();
  if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Refresh authority revoked");
  return binding.store.completeEvaluation(request.id, planRef, { coverage: reasons.size ? "partial" : "complete", reasons: [...reasons], groups: plan.groups.length, committed, failed, calls, bytes, changed: [...changed] }, (binding.now ?? Date.now)());
}
