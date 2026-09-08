import { createHash } from "node:crypto";
import { canonical, DataError, fieldValue, identifier, integer, selectJsonPointer, validateColumns, type Cell, type Column, type Command, type Json, type QueryDependency, type Receipt } from "../../../packages/structured-data/src/index.ts";
import type { EntityReference } from "./database-entities.ts";
import type { Event } from "tardie/core/event";
import type { DatabaseBinding, DatabaseRequest } from "./database-component.ts";

export interface DatabaseSource {
  digest: string;
  generation: string;
  stepIds: string[];
  inputs: { name: string; type: string; required: boolean }[];
  observation?: { observedAt: number; freshness: "fresh" | "stale" };
  execute(inputs: Record<string, Json>, consume: (step: string, body: unknown) => void, signal: AbortSignal, budget: { maxCalls: number; maxBytes: number }): Promise<{ calls: number; bytes: number }>;
}
export type DatabaseSourceResolver = (sourceId: string, digest: string, signal: AbortSignal) => Promise<DatabaseSource>;
export type RefreshStop = "cancelled" | "forbidden" | "conflict" | "unavailable";
export const refreshOutcome = (reason: string): Receipt["outcome"] => reason === "cancelled" ? "cancelled" : reason === "forbidden" ? "rejected" : reason === "conflict" ? "conflict" : "unavailable";
type RequestBinding = Extract<NonNullable<Column["binding"]>, { kind: "request" }>;
type SourceBinding = Extract<NonNullable<Column["binding"]>, { kind: "request" | "entity" }>;
type Selection = { rowId: string; rowRevision: number; column: Column; binding: SourceBinding };
interface Group { id: string; sourceId: string; digest: string; generation: string; inputs: Record<string, Json>; dependencies: QueryDependency[]; selections: Selection[]; entity?: EntityReference; observation?: DatabaseSource["observation"] }
interface Plan { version: 3; owner: string; operationId: string; tableId: string; tableRevision: number; at: number; deadline: number; maxCalls: number; maxBytes: number; partial: boolean; groups: Group[] }
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

async function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw signal.reason; }
  let stop: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(signal.reason); signal.addEventListener("abort", stop, { once: true }); });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", stop); }
}

/** RFC 6901 lookup: a missing path differs from an explicit JSON null. */
export const selectDatabaseValue = selectJsonPointer;

/** Source authority is checked against exact captured dependencies, including snapshots. */
export async function authorizeDatabaseDependencies(binding: DatabaseBinding, dependencies: readonly QueryDependency[], signal: AbortSignal) {
  const checks = new Map<string, Promise<DatabaseSource>>();
  for (const dependency of dependencies) {
    const source = dependency.source;
    if (source?.kind === "entity") {
      if (!binding.entities) throw new DataError("forbidden", "Entity memory authority unavailable");
      binding.entities.authorize(source);
    }
    if (source?.kind !== "request") continue;
    if (!binding.sources) throw new DataError("forbidden", "Database source authority unavailable");
    const key = canonical([source.id, source.contractDigest]);
    let check = checks.get(key);
    if (!check) { check = binding.sources(source.id, source.contractDigest, signal); checks.set(key, check); }
    let current: DatabaseSource;
    try { current = await withinSignal(check, signal); } catch { signal.throwIfAborted(); throw new DataError("forbidden", "Database source authority unavailable"); }
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
  if (command.kind === "row.link_entity" && command.subject !== null) {
    if (!binding.entities) throw new DataError("unavailable", "Entity memory is not mounted");
    await withinSignal(binding.entities.resolve({ subject: command.subject }, signal), signal);
  }
  if (command.kind === "table.define") for (const column of validateColumns(command.table.columns)) if (column.binding?.kind === "request") await source(binding, column.binding, signal);
  if (command.kind === "view.save") await authorizeDatabaseDependencies(binding, binding.store.query({ ...command.view.query, limit: 1 }).dependencies, signal);
  if (command.kind === "artifact.create") {
    const view = binding.store.record<import("../../../packages/structured-data/src/index.ts").ViewDefinition>("view", command.viewId, command.viewRevision);
    if (!view) throw new DataError("missing", "View unavailable");
    await authorizeDatabaseDependencies(binding, binding.store.query(view.value.query).dependencies, signal);
  }
}

async function planRefresh(binding: DatabaseBinding, request: DatabaseRequest, command: Extract<Command, { kind: "table.refresh" }>, signal: AbortSignal, selection?: readonly { rowId: string; columnIds: string[] }[]): Promise<Plan> {
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
  const columns = table.value.columns.filter(column => (column.binding?.kind === "request" || column.binding?.kind === "entity") && (!command.columnIds || command.columnIds.includes(column.id)));
  if (command.columnIds?.some(id => !columns.some(column => column.id === id))) throw new DataError("invalid", "Refresh selection must contain source fields");
  const rows = command.rowIds ? { rows: command.rowIds.slice(0, maxRows).map(id => {
    const row = binding.store.row(table.id, id); if (!row) throw new DataError("missing", "Refresh row unavailable"); return row;
  }), complete: command.rowIds.length <= maxRows } : binding.store.rows(table.id, maxRows);
  const groups = new Map<string, Group>(), contracts = new Map<string, DatabaseSource>();
  const at = (binding.now ?? Date.now)();
  for (const column of columns) {
    if (column.binding?.kind !== "request") continue;
    const definition = column.binding as RequestBinding;
    const resolved = await source(binding, definition, signal);
    contracts.set(column.id, resolved);
  }
  for (const row of rows.rows) {
    for (const column of columns) {
      if (selection && !selection.some(item => item.rowId === row.id && item.columnIds.includes(column.id))) continue;
      if (Object.hasOwn(row.value.overrides ?? {}, column.id)) continue;
      const definition = column.binding as SourceBinding;
      const inputFields = [...new Set(definition.kind === "request" ? Object.values(definition.inputs).flatMap(input => "rowField" in input ? [input.rowField] : []) : definition.subjectField ? [definition.subjectField] : [])];
      const query = binding.store.query({ tableId: table.id, select: inputFields.length ? inputFields : ["$id"], filter: { field: "$id", op: "eq", value: row.id }, maxRows: 10000, limit: 1 });
      if (query.coverage !== "complete") throw new DataError("unavailable", "Refresh requires complete input dependencies");
      await authorizeDatabaseDependencies(binding, query.dependencies, signal);
      const values = query.rows[0]?.cells;
      if (!values) throw new DataError("unavailable", "Refresh input row unavailable");
      let entity: EntityReference | undefined, resolved: DatabaseSource;
      if (definition.kind === "entity") {
        if (!binding.entities) throw new DataError("unavailable", "Entity memory is not mounted");
        const subjectCell = definition.subjectField ? values[definition.subjectField] : undefined;
        if (definition.subjectField && (!subjectCell || subjectCell.state !== "ready" || subjectCell.freshness !== "fresh" || typeof subjectCell.value !== "string")) throw new DataError("unavailable", "Entity subject requires a fresh text field");
        const subject = definition.subject ?? (subjectCell?.value as string | undefined) ?? row.value.entity?.subject;
        entity = { ...(subject ? { subject } : {}), ...(definition.observationId ? { observationId: definition.observationId } : {}) };
        const cacheKey = `entity:${canonical(entity)}`;
        resolved = contracts.get(cacheKey) ?? await withinSignal(binding.entities.resolve(entity, signal), signal);
        contracts.set(cacheKey, resolved);
      } else resolved = contracts.get(column.id)!;
      const saved = binding.store.cell(table.id, row.id, column.id);
      if (command.mode === "stale" && saved?.retention !== "reference-only" && saved?.tableRevision === table.revision && saved.rowRevision === row.revision && saved.cell.state === "ready" && saved.cell.freshness === "fresh" && saved.cell.sourceGeneration === resolved.generation && (definition.kind === "entity" ? resolved.observation?.freshness === "fresh" : (saved.cell.checkedAt ?? 0) + definition.refresh.maxAgeSeconds * 1000 >= at)) {
        await authorizeDatabaseDependencies(binding, saved.dependencies ?? [], signal);
        try { if (binding.store.assertCurrentDependencies(saved.dependencies ?? [])) continue; }
        catch (error) { if (!(error instanceof DataError) || !["conflict", "missing"].includes(error.code)) throw error; }
      }
      const inputs: Record<string, Json> = {};
      for (const [name, mapping] of Object.entries(definition.kind === "request" ? definition.inputs : {})) {
        if ("literal" in mapping) inputs[name] = mapping.literal;
        else {
          const cell = values[mapping.rowField];
          if (!cell || cell.state !== "ready" || cell.freshness !== "fresh") throw new DataError("unavailable", "Refresh requires a fresh input dependency");
          inputs[name] = cell.value!;
        }
      }
      const sourceId = definition.kind === "request" ? definition.sourceId : entity!.subject ?? entity!.observationId!;
      const id = hash([binding.owner, sourceId, resolved.digest, resolved.generation, inputs]);
      let group = groups.get(id);
      if (!group) { group = { id, sourceId, digest: resolved.digest, generation: resolved.generation, inputs, dependencies: [], selections: [], ...(entity ? { entity } : {}), ...(resolved.observation ? { observation: resolved.observation } : {}) }; groups.set(id, group); }
      group.dependencies = [...new Map([...group.dependencies, ...query.dependencies].map(dependency => [canonical(dependency), dependency])).values()];
      group.selections.push({ rowId: row.id, rowRevision: row.revision, column, binding: definition });
    }
  }
  signal.throwIfAborted();
  if (groups.size > 64 || new TextEncoder().encode(canonical([...groups.values()])).length > 1048576) throw new DataError("limit", "Refresh plan exceeds budget");
  return { version: 3, owner: binding.owner, operationId: request.id, tableId: table.id, tableRevision: table.revision, at, deadline: at + timeoutMs, maxCalls, maxBytes, partial: !rows.complete, groups: [...groups.values()] };
}

function resolveGroup(binding: DatabaseBinding, group: Group, signal: AbortSignal) {
  if (group.entity) {
    if (!binding.entities) throw new DataError("forbidden", "Entity memory authority unavailable");
    return withinSignal(binding.entities.resolve(group.entity, signal), signal);
  }
  if (!binding.sources) throw new DataError("forbidden", "Source authority unavailable");
  return withinSignal(binding.sources(group.sourceId, group.digest, signal), signal);
}

/** One native operation, with a sealed plan and independently recoverable group commits.
 * No transaction spans source I/O. A committed group is never fetched again on replay. */
export async function executeDatabaseRefresh(binding: DatabaseBinding, request: DatabaseRequest, command: Extract<Command, { kind: "table.refresh" }>, journal: { read(): Promise<readonly Event[]>; append(events: Event[]): Promise<unknown> }, signal: AbortSignal, selection?: readonly { rowId: string; columnIds: string[] }[], deadline?: number, stop?: RefreshStop): Promise<Receipt> {
  const events = await journal.read();
  const planned = events.find(event => event.type === "AikoDatabaseRefreshPlanned" && event.owner === binding.owner && event.thread === binding.thread && event.id === request.id);
  let plan: Plan, planRef: string;
  if (planned) {
    planRef = String(planned.planRef); plan = await binding.custody.get(binding.owner, planRef) as Plan;
  } else {
    if (stop) throw new DataError("unavailable", "No refresh plan to reconcile");
    const planningMs = command.budget?.timeoutMs ?? 15000; integer(planningMs, 100, 60000);
    try { plan = await planRefresh(binding, request, command, AbortSignal.any([signal, AbortSignal.timeout(planningMs)]), selection); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof DataError) throw error;
      // Contract discovery/authorization has no source effects. Normalize its
      // failures so a later unavailable stage still discloses earlier commits.
      throw new DataError("unavailable", "Refresh source plan unavailable");
    }
    if (deadline !== undefined) plan.deadline = Math.min(plan.deadline, deadline);
    planRef = await binding.custody.put(binding.owner, plan);
    await journal.append([{ type: "AikoDatabaseRefreshPlanned", owner: binding.owner, thread: binding.thread, id: request.id, planRef, groups: plan.groups.length, at: plan.at }]);
  }
  if (plan.owner !== binding.owner || plan.operationId !== request.id) throw new DataError("forbidden", "Refresh plan owner mismatch");
  if (plan.version !== 3) throw new DataError("unavailable", "Refresh plan uses an older format; submit a new operation");
  let calls = 0, bytes = 0, committed = 0, failed = 0;
  let budgetAccounting: "measured" | "reserved" = "measured", outcome: Receipt["outcome"];
  const changed = new Set<string>(), reasons = new Set<string>(plan.partial ? ["row_budget"] : []);
  try {
  for (const group of plan.groups) {
    const groupId = hash([request.id, group.id]);
    const prior = binding.store.receipt(groupId);
    if (prior) {
      committed++; for (const field of (prior.result as { changed: string[] }).changed) changed.add(field);
      const check = prior.result as { calls?: number; bytes?: number; status?: string; code?: string; budgetAccounting?: string };
      calls += check.calls ?? plan.maxCalls; bytes += check.bytes ?? plan.maxBytes;
      if (check.budgetAccounting === "reserved" || check.calls === undefined || check.bytes === undefined) budgetAccounting = "reserved";
      if (check.status !== "completed") { failed++; reasons.add(check.code ?? "interrupted_read"); }
      continue;
    }
    // At most one physical attempt per group in this occurrence. A lost attempt
    // is disclosed, not repeated after a process crash with uncertain call costs.
    const started = (await journal.read()).some(event => event.type === "AikoDatabaseRefreshGroupStarted" && event.owner === binding.owner && event.id === groupId);
    if (started) { failed++; reasons.add("interrupted_read"); calls = plan.maxCalls; bytes = plan.maxBytes; budgetAccounting = "reserved"; break; }
    // Receipts/unknown attempts are reconciled before stop checks. Recovery must
    // disclose prior effects even when no further reads are currently authorized.
    if (stop) break;
    signal.throwIfAborted();
    const remainingMs = plan.deadline - (binding.now ?? Date.now)();
    if (calls >= plan.maxCalls || bytes >= plan.maxBytes || remainingMs <= 0) { reasons.add("refresh_budget"); break; }
    if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Refresh authority revoked");
    await journal.append([{ type: "AikoDatabaseRefreshGroupStarted", owner: binding.owner, thread: binding.thread, id: groupId, operationId: request.id, at: (binding.now ?? Date.now)() }]);
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]);
    const selected = new Map<string, Cell>();
    let count = { calls: 0, bytes: 0 }, error: string | undefined;
    try {
      await authorizeDatabaseDependencies(binding, group.dependencies, boundedSignal);
      binding.store.assertCurrentDependencies(group.dependencies, true);
      const resolved = await resolveGroup(binding, group, boundedSignal);
      if (resolved.digest !== group.digest || resolved.generation !== group.generation) throw new DataError("forbidden", "Source generation changed");
      count = await withinSignal(resolved.execute(group.inputs, (stepId, body) => {
        boundedSignal.throwIfAborted();
        for (const item of group.selections) if ((item.binding.kind === "entity" ? "entity" : item.binding.select.stepId) === stepId) {
          const value = selectDatabaseValue(body, item.binding.kind === "entity" ? item.binding.path : item.binding.select.jsonPointer);
          const observed = group.observation;
          selected.set(canonical([item.rowId, item.column.id]), { ...(value === undefined ? { state: "missing" as const } : { state: "ready" as const, value: fieldValue(item.column, value) }), freshness: observed?.freshness ?? "fresh", ...(observed ? { observedAt: observed.observedAt } : {}) });
        }
      }, boundedSignal, { maxCalls: plan.maxCalls - calls, maxBytes: plan.maxBytes - bytes }), boundedSignal);
      integer(count.calls, 0, plan.maxCalls - calls); integer(count.bytes, 0, plan.maxBytes - bytes);
      const current = await resolveGroup(binding, group, boundedSignal);
      if (current.generation !== group.generation || current.digest !== group.digest || !await binding.authorize("write", boundedSignal)) throw new DataError("forbidden", "Source authority changed");
      if (current.observation?.freshness === "stale") for (const cell of selected.values()) cell.freshness = "stale";
      await authorizeDatabaseDependencies(binding, group.dependencies, boundedSignal);
    } catch (e) {
      error = signal.aborted ? "cancelled" : e instanceof DataError ? e.code : "source_unavailable";
      // A failing transport cannot promise its physical attempt count. Exhaust
      // this occurrence's budget rather than dispatching more requests blindly.
      count = { calls: plan.maxCalls - calls, bytes: plan.maxBytes - bytes }; budgetAccounting = "reserved"; selected.clear(); failed++; reasons.add(error);
    }
    if (!error && group.selections.some(item => !selected.has(canonical([item.rowId, item.column.id])))) {
      error = "missing_response_step"; failed++; reasons.add(error);
    }
    calls += count.calls; bytes += count.bytes;
    const rows = new Map<string, { rowId: string; rowRevision: number; cells: Record<string, { cell: Cell; retention: RequestBinding["retention"] }> }>();
    for (const item of group.selections) {
      let row = rows.get(item.rowId); if (!row) { row = { rowId: item.rowId, rowRevision: item.rowRevision, cells: {} }; rows.set(item.rowId, row); }
      const cell = selected.get(canonical([item.rowId, item.column.id])) ?? { state: "error" as const, freshness: "unknown" as const, error: error ?? "missing_response_step" };
      row.cells[item.column.id] = { cell: { ...cell, source: group.sourceId, sourceGeneration: group.generation, lineage: [group.entity ? `entity:${group.generation}` : `request:${group.digest}:${group.generation}`, `inputs:${hash(group.dependencies)}`] }, retention: item.binding.retention };
    }
    signal.throwIfAborted();
    if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Refresh authority revoked");
    const sourceEvidence: QueryDependency[] = group.entity ? group.selections.map(item => ({ tableId: plan.tableId, tableRevision: plan.tableRevision, rowId: item.rowId, rowRevision: item.rowRevision, columnId: item.column.id, source: { kind: "entity", ...group.entity, observationId: group.generation, followHead: !group.entity!.observationId } })) : [];
    const receipt = await binding.store.commitCells(groupId, { tableId: plan.tableId, tableRevision: plan.tableRevision, dependencies: group.dependencies, sourceEvidence, rows: [...rows.values()], check: { ...count, budgetAccounting, status: error ? "failed" : "completed", ...(error ? { code: error } : {}) } }, (binding.now ?? Date.now)(), () => signal.throwIfAborted());
    committed++; for (const field of (receipt.result as { changed: string[] }).changed) changed.add(field);
    await journal.append([{ type: "AikoDatabaseRefreshGroupSettled", owner: binding.owner, thread: binding.thread, id: groupId, operationId: request.id, calls: count.calls, bytes: count.bytes, status: error ? "failed" : "completed", at: (binding.now ?? Date.now)() }]);
  }
  if (!stop) {
    signal.throwIfAborted();
    if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Refresh authority revoked");
  }
  } catch (error) {
    // Unexpected host/journal failures still escape: replay must use the sealed
    // plan and atomic group receipts, not settle an invented all-or-nothing result.
    if (!signal.aborted && !(error instanceof DataError)) throw error;
    const reason = signal.aborted ? "cancelled" : (error as DataError).code;
    reasons.add(reason); outcome = refreshOutcome(reason);
  }
  if (stop) { reasons.add(stop); outcome = refreshOutcome(stop); }
  return binding.store.completeEvaluation(request.id, planRef, { coverage: reasons.size ? "partial" : "complete", reasons: [...reasons], groups: plan.groups.length, committed, failed, calls, bytes, budgetAccounting, changed: [...changed] }, (binding.now ?? Date.now)(), outcome);
}
