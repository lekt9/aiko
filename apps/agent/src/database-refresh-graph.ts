import { createHash } from "node:crypto";
import type { Event } from "tardie/core/event";
import { canonical, DataError, dependencies, identifier, integer, type Command, type QueryDependency, type Receipt } from "../../../packages/structured-data/src/index.ts";
import type { DatabaseBinding, DatabaseRequest } from "./database-component.ts";
import { executeDatabaseRefresh, refreshOutcome, type RefreshStop } from "./database-refresh.ts";

type Refresh = Extract<Command, { kind: "table.refresh" }>;
type Journal = { read(): Promise<readonly Event[]>; append(events: Event[]): Promise<unknown> };
interface Target { tableId: string; rowId: string; columnId: string; depth: number }
interface Stage { tableId: string; selection: { rowId: string; columnIds: string[] }[] }
interface Graph {
  version: 1; owner: string; thread: string; operationId: string; commandRef: string;
  deadline: number; maxCalls: number; maxBytes: number; maxRows: number;
  partial: boolean; fences: QueryDependency[]; stages: Stage[];
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** Builds concrete cell dependencies. Relations themselves may cycle; evaluated fields may not. */
function planGraph(binding: DatabaseBinding, request: DatabaseRequest, command: Refresh): Graph {
  const maxRows = command.budget?.maxRows ?? 100, maxCalls = command.budget?.maxCalls ?? 16, maxBytes = command.budget?.maxBytes ?? 1048576, timeoutMs = command.budget?.timeoutMs ?? 15000;
  integer(maxRows, 1, 500); integer(maxCalls, 1, 64); integer(maxBytes, 1024, 4194304); integer(timeoutMs, 100, 60000);
  identifier(command.tableId);
  if (command.mode !== undefined && !["all", "stale"].includes(command.mode)) throw new DataError("invalid", "Unknown refresh mode");
  for (const ids of [command.rowIds, command.columnIds]) if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length) throw new DataError("invalid", "Invalid refresh selection");
    ids.forEach(id => identifier(id));
  }
  const table = binding.store.table(command.tableId);
  if (table.value.mode !== "stored") throw new DataError("forbidden", "Domain collections own their refresh");
  const columns = table.value.columns.filter(column => ["request", "entity"].includes(column.binding?.kind ?? "") && (!command.columnIds || command.columnIds.includes(column.id)));
  if (command.columnIds?.some(id => !columns.some(column => column.id === id))) throw new DataError("invalid", "Refresh selection must contain source fields");
  const rootRows = command.rowIds ? { rows: command.rowIds.slice(0, maxRows).map(id => { const row = binding.store.row(table.id, id); if (!row) throw new DataError("missing", "Refresh row unavailable"); return row; }), complete: command.rowIds.length <= maxRows } : binding.store.rows(table.id, maxRows);
  const visiting = new Set<string>(), inputs = new Set<string>(), depths = new Map<string, number>(), targets = new Map<string, Target>(), fences = new Map<string, QueryDependency>(), rows = new Set<string>();
  const visit = (tableId: string, rowId: string, columnId: string, level: number, input = true): number => {
    const key = canonical([tableId, rowId, columnId]);
    if (input) inputs.add(key);
    if (visiting.has(key)) throw new DataError("invalid", "Cyclic refresh dependency");
    if (level > 32 || depths.size + visiting.size >= 10000) throw new DataError("limit", "Refresh dependency graph exceeds budget");
    const known = depths.get(key); if (known !== undefined) return known;
    const definition = binding.store.table(tableId), row = binding.store.row(tableId, rowId);
    if (!row) throw new DataError("missing", "Refresh dependency row unavailable");
    binding.store.assertRead(tableId, columnId === "$id" ? undefined : columnId, rowId);
    rows.add(canonical([tableId, rowId])); if (rows.size > maxRows) throw new DataError("limit", "Refresh dependency rows exceed budget");
    fences.set(key, { tableId, tableRevision: definition.revision, rowId, rowRevision: row.revision, ...(columnId === "$id" ? {} : { columnId }) });
    const column = definition.value.columns.find(column => column.id === columnId);
    if (!column && columnId !== "$id") throw new DataError("invalid", "Unknown refresh dependency field");
    if (!column || Object.hasOwn(row.value.overrides ?? {}, columnId)) { depths.set(key, -1); return -1; }
    visiting.add(key); let depth = -1;
    for (const field of dependencies(column.binding)) depth = Math.max(depth, visit(tableId, rowId, field, level + 1));
    if (column.binding?.kind === "lookup") {
      const lookup = column.binding, relation = definition.value.columns.find(column => column.id === lookup.relation)?.relation;
      if (!relation) throw new DataError("invalid", "Lookup requires a relation");
      const value = binding.store.query({ tableId, filter: { field: "$id", op: "eq", value: rowId }, select: [lookup.relation], limit: 1 }).rows[0]?.cells[lookup.relation];
      if (!value || value.state !== "ready" || value.freshness !== "fresh") throw new DataError("unavailable", "Refresh requires resolved relation membership");
      for (const id of value.value == null ? [] : Array.isArray(value.value) ? value.value : [value.value]) depth = Math.max(depth, visit(relation.tableId, String(id), lookup.field, level + 1));
    }
    if (column.binding?.kind === "request" || column.binding?.kind === "entity") {
      if (definition.value.mode !== "stored") throw new DataError("forbidden", "Domain collections own their sources");
      targets.set(key, { tableId, rowId, columnId, depth: ++depth });
    }
    visiting.delete(key); depths.set(key, depth); return depth;
  };
  for (const row of rootRows.rows) for (const column of columns) visit(table.id, row.id, column.id, 0, false);
  // A reference-only prerequisite cannot enter a persisted downstream request plan.
  // It needs the evaluation-scoped transient path, not implicit materialization.
  for (const [key, target] of targets) if (inputs.has(key)) {
    const source = binding.store.table(target.tableId).value.columns.find(column => column.id === target.columnId)?.binding;
    if ((source?.kind === "request" || source?.kind === "entity") && source.retention === "reference-only") throw new DataError("unavailable", "Reference-only dependencies require transient evaluation");
  }
  const stages = new Map<string, Stage>();
  for (const target of [...targets.values()].sort((a, b) => a.depth - b.depth || a.tableId.localeCompare(b.tableId) || a.rowId.localeCompare(b.rowId) || a.columnId.localeCompare(b.columnId))) {
    const key = canonical([target.depth, target.tableId]); let stage = stages.get(key);
    if (!stage) { stage = { tableId: target.tableId, selection: [] }; stages.set(key, stage); }
    let row = stage.selection.find(row => row.rowId === target.rowId);
    if (!row) { row = { rowId: target.rowId, columnIds: [] }; stage.selection.push(row); } row.columnIds.push(target.columnId);
  }
  if (stages.size > 64) throw new DataError("limit", "Refresh exceeds 64 stages");
  return { version: 1, owner: binding.owner, thread: binding.thread, operationId: request.id, commandRef: request.commandRef, deadline: (binding.now ?? Date.now)() + timeoutMs, maxCalls, maxBytes, maxRows, partial: !rootRows.complete, fences: [...fences.values()], stages: [...stages.values()] };
}

/** Native stage receipts share one budget and one parent operation; no separate runner. */
export async function executeDatabaseRefreshGraph(binding: DatabaseBinding, request: DatabaseRequest, command: Refresh, journal: Journal, signal: AbortSignal, stop?: RefreshStop): Promise<Receipt> {
  const events = await journal.read();
  if (events.some(event => event.type === "AikoDatabaseRefreshPlanned" && event.owner === binding.owner && event.thread === binding.thread && event.id === request.id)) return executeDatabaseRefresh(binding, request, command, journal, signal, undefined, undefined, stop);
  const recorded = events.find(event => event.type === "AikoDatabaseRefreshGraphPlanned" && event.owner === binding.owner && event.thread === binding.thread && event.id === request.id);
  let graph: Graph, ref: string;
  if (recorded) { ref = String(recorded.planRef); graph = await binding.custody.get(binding.owner, ref) as Graph; }
  else {
    if (stop) throw new DataError("unavailable", "No refresh plan to reconcile");
    graph = planGraph(binding, request, command);
    if (graph.stages.length <= 1) return executeDatabaseRefresh(binding, request, command, journal, signal);
    if (new TextEncoder().encode(canonical(graph)).length > 1048576) throw new DataError("limit", "Refresh graph exceeds byte budget");
    ref = await binding.custody.put(binding.owner, graph);
    await journal.append([{ type: "AikoDatabaseRefreshGraphPlanned", owner: binding.owner, thread: binding.thread, id: request.id, planRef: ref, stages: graph.stages.length, at: (binding.now ?? Date.now)() }]);
  }
  if (graph.version !== 1 || graph.owner !== binding.owner || graph.thread !== binding.thread || graph.operationId !== request.id || graph.commandRef !== request.commandRef) throw new DataError("forbidden", "Refresh graph identity mismatch");
  let calls = 0, bytes = 0, committed = 0, failed = 0, groups = 0, stages = 0;
  let budgetAccounting: "measured" | "reserved" = "measured", outcome: Receipt["outcome"];
  const changed = new Set<string>(), reasons = new Set<string>(graph.partial ? ["row_budget"] : []);
  for (const [index, stage] of graph.stages.entries()) {
    const id = hash(["database-refresh-stage/v1", request.id, index]), prior = binding.store.receipt(id);
    let result: Receipt;
    if (prior) result = prior;
    else {
      const remaining = graph.deadline - (binding.now ?? Date.now)();
      const planned = (await journal.read()).some(event => event.type === "AikoDatabaseRefreshPlanned" && event.owner === binding.owner && event.thread === binding.thread && event.id === id);
      // An existing stage owns its original deadline/budget and must recover its
      // receipts even after expiry, revocation or edits to the graph's inputs.
      if (!stop) {
        try {
          signal.throwIfAborted();
          if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Refresh authority revoked");
          signal.throwIfAborted();
          binding.store.assertCurrentDependencies(graph.fences);
        } catch (error) {
          if (!signal.aborted && !(error instanceof DataError)) throw error;
          stop = signal.aborted ? "cancelled" : (error as DataError).code === "forbidden" ? "forbidden" : (error as DataError).code === "conflict" ? "conflict" : "unavailable";
        }
      }
      if (!planned) {
        if (stop) { reasons.add(stop); outcome = refreshOutcome(stop); break; }
        if (calls >= graph.maxCalls || graph.maxBytes - bytes < 1024 || remaining < 100) { reasons.add("refresh_budget"); break; }
      }
      try {
        const next: Refresh = { kind: "table.refresh", tableId: stage.tableId, rowIds: stage.selection.map(row => row.rowId), columnIds: [...new Set(stage.selection.flatMap(row => row.columnIds))], ...(command.mode ? { mode: command.mode } : {}), budget: { maxRows: graph.maxRows, maxCalls: graph.maxCalls - calls, maxBytes: graph.maxBytes - bytes, timeoutMs: Math.min(60000, remaining) } };
        result = await executeDatabaseRefresh(binding, { ...request, id }, next, journal, signal, stage.selection, graph.deadline, stop);
      } catch (error) {
        if (!signal.aborted && !(error instanceof DataError)) throw error;
        const reason = signal.aborted ? "cancelled" : (error as DataError).code;
        reasons.add(reason); outcome = refreshOutcome(reason); break;
      }
    }
    const value = result.result as { calls: number; bytes: number; committed: number; failed: number; groups: number; changed: string[]; reasons: string[]; budgetAccounting: "measured" | "reserved" };
    calls += value.calls; bytes += value.bytes; committed += value.committed; failed += value.failed; groups += value.groups; stages++;
    for (const field of value.changed) changed.add(`${stage.tableId}:${field}`);
    for (const reason of value.reasons) reasons.add(reason);
    if (value.budgetAccounting === "reserved") budgetAccounting = "reserved";
    if (result.outcome) outcome = result.outcome;
    if (value.reasons.length) break;
  }
  if (stop && stages < graph.stages.length) { reasons.add(stop); outcome = refreshOutcome(stop); }
  return binding.store.completeEvaluation(request.id, ref, { coverage: reasons.size ? "partial" : "complete", reasons: [...reasons], stages, plannedStages: graph.stages.length, groups, committed, failed, calls, bytes, budgetAccounting, changed: [...changed] }, (binding.now ?? Date.now)(), outcome);
}
