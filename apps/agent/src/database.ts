import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { NativeTool } from "tardie/component/tool";
import { canonical, clone, DataError, identifier, type Command, type Query } from "../../../packages/structured-data/src/index.ts";
import { databaseState, prepareDatabaseCommand, type DatabaseBinding } from "./database-component.ts";
import { authorizeDatabaseDependencies } from "./database-refresh.ts";
import { projectActionApprovals } from "./action-approval.ts";

const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const object = { type: "object" };
const id = { type: "string", minLength: 1, maxLength: 160 };
const revision = { type: "integer", minimum: 0 };
const specs = [
  { name: "table_refresh", description: "Queue a bounded native refresh of request fields. Sources are registered learned read digests, never arbitrary URLs. Supply tableId, optional rowIds/columnIds, mode all or stale, and budget {maxRows,maxCalls,maxBytes,timeoutMs}. Inspect the operation result for partial coverage. Cached table_query never fetches sources.", properties: { tableId: id, rowIds: { type: "array", items: id }, columnIds: { type: "array", items: id }, mode: { type: "string", enum: ["all", "stale"] }, budget: object }, required: ["tableId"], command: "table.refresh" },
  { name: "database_create", description: "Create an owner-private logical database. Choose temporary (requires expiresAt), internal, or visible lifecycle. Returns a queued operation; inspect database_operation before depending on its changes.", properties: { database: object }, required: ["database"], command: "database.create" },
  { name: "table_define", description: "Create or revise a typed table. Supply table {id,databaseId,name,mode:'stored',columns:[{id,name,type,...}]} and expectedRevision (0 for new). Stable column IDs preserve relations and formulas. Domain collections cannot be defined here.", properties: { table: object, expectedRevision: revision }, required: ["table", "expectedRevision"], command: "table.define" },
  { name: "table_upsert", description: "Atomically insert/patch up to 500 rows: {id,expectedRevision,values,overrides?}. New rows use revision 0. Source/computed fields need explicit overrides; editing never writes a remote API.", properties: { tableId: id, rows: { type: "array", minItems: 1, maxItems: 500, items: object } }, required: ["tableId", "rows"], command: "rows.upsert" },
  { name: "table_delete_rows", description: "Tombstone exact row revisions; existing references remain visibly missing. Deleted identities cannot be reused.", properties: { tableId: id, rows: { type: "array", minItems: 1, maxItems: 500, items: object } }, required: ["tableId", "rows"], command: "rows.delete" },
  { name: "view_save", description: "Save a versioned database query and layout (table, list, board, calendar, chart). Does not duplicate source rows or fetch remote data.", properties: { view: object, expectedRevision: revision }, required: ["view", "expectedRevision"], command: "view.save" },
  { name: "artifact_create", description: "Create a database artifact from an exact saved view revision. Live artifacts query current data; snapshots require permitted retained values. Inspect the operation before returning the artifact.", properties: { artifactId: id, viewId: id, viewRevision: revision, title: { type: "string" }, dataMode: { type: "string", enum: ["live", "snapshot"] } }, required: ["artifactId", "viewId", "viewRevision", "title", "dataMode"], command: "artifact.create" },
  { name: "table_query", description: "Read a bounded local database query. Supports select, filter, sort, relation/key joins, groupBy and aggregates; query uses tableId, limit, maxRows, maxBytes and revision cursor. No implicit network fetch. Preserve partial coverage and stale/unavailable cell states in answers.", properties: { query: object }, required: ["query"] },
  { name: "database_catalog", description: "List this owner's current databases, table schemas, saved views and artifact identities. No source requests or model calls.", properties: {}, required: [] },
  { name: "database_operation", description: "Inspect a previously queued operation and its committed result. This does not repeat the command. Queued is not completion.", properties: { operationId: id }, required: ["operationId"] },
  { name: "artifact_open", description: "Read an authenticated database artifact and its view result. Opening never repeats an agent turn, command or source request.", properties: { artifactId: id }, required: ["artifactId"] },
  { name: "table_explain", description: "Inspect a field's type, binding, current cell, row/schema revisions and recorded freshness. This reads only local data.", properties: { tableId: id, rowId: id, columnId: id }, required: ["tableId", "rowId", "columnId"] },
] as const;
export const DATABASE_TOOL_NAMES = new Set<string>(specs.map(s => s.name));
type Scope = { owner: string; thread: string; turn: string; callId: string; tool: string };
interface PrivateReference extends Scope { kind: "aiko-database-private.v1"; ref: string }
interface PrivatePayload extends Scope { kind: "aiko-database-payload.v1"; direction: "input" | "result"; value: unknown }
const denied = "Database data unavailable under current authority";
function argsObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DataError("invalid", "Object arguments required");
  return clone(raw as Record<string, unknown>);
}
async function retain(binding: DatabaseBinding, scope: Scope, direction: PrivatePayload["direction"], value: unknown): Promise<PrivateReference> {
  const payload: PrivatePayload = { kind: "aiko-database-payload.v1", ...scope, direction, value: clone(value) };
  return { kind: "aiko-database-private.v1", ...scope, ref: await binding.custody.put(binding.owner, payload) };
}
async function hydrate(binding: DatabaseBinding, scope: Scope, direction: PrivatePayload["direction"], raw: unknown, signal: AbortSignal): Promise<unknown> {
  const ref = raw as PrivateReference;
  if (!ref || ref.kind !== "aiko-database-private.v1" || typeof ref.ref !== "string" || Object.entries(scope).some(([k, v]) => ref[k as keyof Scope] !== v) || !await binding.authorize("read", signal)) throw new DataError("forbidden", denied);
  const payload = await binding.custody.get(binding.owner, ref.ref) as PrivatePayload;
  if (!payload || payload.kind !== "aiko-database-payload.v1" || payload.direction !== direction || Object.entries(scope).some(([k, v]) => payload[k as keyof Scope] !== v)) throw new DataError("forbidden", denied);
  signal.throwIfAborted();
  if (!await binding.authorize("read", signal)) throw new DataError("forbidden", denied);
  return payload.value;
}
function readLocalValue(binding: DatabaseBinding, name: string, args: Record<string, unknown>, events: Parameters<typeof databaseState>[0]): unknown {
  binding.collections?.(events);
  const visibleTable = (id: string) => { const table = binding.store.table(id); for (const column of table.value.columns) binding.store.assertRead(id, column.id); return table; };
  if (name === "table_query") return binding.store.query(args.query as Query);
  if (name === "database_changes") return { cursor: { revision: binding.store.revision(), domains: binding.store.domainRevisions() }, mode: "snapshot-invalidation" };
  if (name === "database_catalog") return {
    databases: binding.store.list("database").filter(r => { try { binding.store.database(r.id); return true; } catch { return false; } }),
    tables: [...binding.store.list("table").filter(r => { try { visibleTable(r.id); return true; } catch { return false; } }), ...[...(binding.store.options.domains ?? [])].flatMap(([id, domain]) => { try { return [{ ...visibleTable(id), ...(domain.coverage ? { coverage: domain.coverage } : {}) }]; } catch { return []; } })],
    views: binding.store.list<import("../../../packages/structured-data/src/index.ts").ViewDefinition>("view").filter(r => { try { binding.store.query({ ...r.value.query, limit: 1 }); return true; } catch { return false; } }),
    artifacts: binding.store.list<{ title: string; dataMode: "live" | "snapshot" }>("artifact").flatMap(r => { try { binding.store.artifact(r.id); return [{ artifactId: r.id, title: r.value.title, revision: r.revision, dataMode: r.value.dataMode }]; } catch { return []; } }),
  };
  if (name === "database_operation") {
    identifier(args.operationId);
    const operation = databaseState(events, binding).get(args.operationId);
    if (!operation) throw new DataError("missing", "Database operation not found");
    const receipt = binding.store.receipt(args.operationId);
    return { operationId: args.operationId, status: receipt ? "committed" : operation.status, ...(receipt ? { receipt } : {}), ...(operation.code ? { code: operation.code } : {}) };
  }
  if (name === "artifact_open") { identifier(args.artifactId); return binding.store.artifact(args.artifactId); }
  // Host-only detail read. Deliberately absent from the agent's native tool specs.
  if (name === "approval_detail") {
    identifier(args.approvalId);
    const approval = projectActionApprovals(events, binding.owner, binding.thread, args.approvalId).get(args.approvalId);
    if (!approval) throw new DataError("missing", "Approval unavailable");
    return { prepared: approval.prepared, state: approval.state, version: approval.version, outcome: approval.outcome ?? null, canDecide: approval.state === "pending" && approval.prepared.expiresAt > binding.store.now() };
  }
  if (name === "table_explain") {
    identifier(args.tableId); identifier(args.rowId); identifier(args.columnId);
    const table = binding.store.table(args.tableId), row = binding.store.row(args.tableId, args.rowId);
    const column = table.value.columns.find(c => c.id === args.columnId);
    if (!row || !column) throw new DataError("missing", "Field unavailable");
    const result = binding.store.query({ tableId: table.id, filter: { field: "$id", op: "eq", value: row.id }, select: [column.id] });
    return { tableRevision: table.revision, rowRevision: row.revision, column, cell: result.rows[0]?.cells[column.id] ?? { state: "missing", freshness: "unknown" }, coverage: result.coverage, dependencies: result.dependencies };
  }
  throw new DataError("invalid", "Unknown database read");
}

async function readValue(binding: DatabaseBinding, name: string, args: Record<string, unknown>, events: Parameters<typeof databaseState>[0], signal = new AbortController().signal): Promise<unknown> {
  const value = readLocalValue(binding, name, args, events) as any;
  const dependencies = name === "artifact_open" ? value.result.dependencies : name === "table_query" || name === "table_explain" ? value.dependencies : [];
  await authorizeDatabaseDependencies(binding, dependencies ?? [], signal);
  if (name === "database_catalog") {
    value.views = (await Promise.all(value.views.map(async (view: any) => { try { await authorizeDatabaseDependencies(binding, binding.store.query({ ...view.value.query, limit: 1 }).dependencies, signal); return view; } catch { return undefined; } }))).filter(Boolean);
    value.artifacts = (await Promise.all(value.artifacts.map(async (artifact: any) => { try { await authorizeDatabaseDependencies(binding, binding.store.artifact(artifact.artifactId).result.dependencies, signal); return artifact; } catch { return undefined; } }))).filter(Boolean);
  }
  signal.throwIfAborted();
  return value;
}

/** Direct native tools require pre-sealed inputs. Code mode already owns argument/result custody. */
export function databaseTools(binding: DatabaseBinding, surface: "native" | "code" = "native"): NativeTool<Self | EventLog>[] {
  return specs.map(spec => ({ spec: { name: spec.name, description: spec.description, inputSchema: { type: "object", properties: spec.properties, required: [...spec.required], additionalProperties: false } },
    run: (raw, context) => Effect.gen(function* () {
      const self = yield* Self, log = yield* EventLog;
      const turn = context.turn;
      if (!turn || self.actor !== "aiko" || self.thread !== binding.thread || binding.store.owner !== binding.owner) return { status: "rejected", code: "owner_binding" };
      const scope: Scope = { owner: binding.owner, thread: binding.thread, turn, callId: context.callId, tool: spec.name };
      return yield* Effect.tryPromise({ try: async () => {
        if (!await binding.authorize("read", context.signal)) throw new DataError("forbidden", denied);
        const input = surface === "native" ? await hydrate(binding, scope, "input", (raw as { privateInput?: unknown })?.privateInput, context.signal) : raw;
        const args = argsObject(input);
        if (Object.keys(args).some(k => !Object.hasOwn(spec.properties, k)) || spec.required.some(k => !Object.hasOwn(args, k))) throw new DataError("invalid", "Invalid database arguments");
        const events = await Effect.runPromise(log.read);
        let value: unknown;
        if ("command" in spec) {
          const operationId = hash(["database-tool/v1", self.actor, self.instance, self.thread, context.turn, context.callId, spec.name]);
          const call = events.findLast(e => e.type === "ToolCalled" && e.callId === context.callId);
          const command = { ...args, kind: spec.command } as Command;
          const request = await prepareDatabaseCommand(binding, { operationId, command, producer: `agent:${hash([self.actor, self.instance, self.thread])}`, cause: turn, epoch: Number(call?.epoch ?? 0) }, context.signal);
          const previous = databaseState(await Effect.runPromise(log.read), binding).get(operationId);
          if (previous && previous.request.commandRef !== request.commandRef) throw new DataError("conflict", "Native call already bound to a different command");
          if (!previous) await Effect.runPromise(log.append([request]));
          value = { operationId, status: binding.store.receipt(operationId) ? "committed" : previous?.status ?? "queued" };
        } else value = await readValue(binding, spec.name, args, events, context.signal);
        context.signal.throwIfAborted();
        if (!await binding.authorize("read", context.signal)) throw new DataError("forbidden", denied);
        if (surface === "code") return value;
        // Retain a read recipe rather than a second historical copy of private rows.
        const retained = "command" in spec ? { mode: "receipt", value } : { mode: "read", name: spec.name, args };
        return { kind: "database-result", resultRef: await retain(binding, scope, "result", retained) };
      }, catch: error => error }).pipe(Effect.catch(error => Effect.succeed({ status: error instanceof DataError && error.code === "conflict" ? "conflict" : "rejected", code: error instanceof DataError ? error.code : "database_unavailable" })));
    }),
  }));
}

/** Seal generated tool arguments before ToolCalled; hydrate current local reads only for inference. */
export function databaseInference<R>(binding: DatabaseBinding, base: Layer.Layer<Infer, never, R>): Layer.Layer<Infer, never, R> {
  return Layer.effect(Infer, Effect.gen(function* () {
    const model = yield* Infer;
    return { ...model, react: (request: InferRequest, key?: string, signal?: AbortSignal) => Effect.gen(function* () {
      const abort = signal ?? new AbortController().signal;
      const trajectory = yield* Effect.promise(async () => Promise.all(request.trajectory.map(async event => {
        if (event.type !== "ToolReturned" || (event.result as { kind?: string })?.kind !== "database-result") return event;
        const call = request.trajectory.find(e => e.type === "ToolCalled" && e.callId === event.callId);
        if (!call || !DATABASE_TOOL_NAMES.has(String(call.name))) return { ...event, result: { status: "unavailable" } };
        const scope: Scope = { owner: binding.owner, thread: binding.thread, turn: String(call.turn), callId: String(call.callId), tool: String(call.name) };
        try {
          const recipe = await hydrate(binding, scope, "result", (event.result as { resultRef?: unknown }).resultRef, abort) as { mode: string; value?: unknown; name: string; args: Record<string, unknown> };
          const result = recipe.mode === "receipt" ? recipe.value : await readValue(binding, recipe.name, recipe.args, binding.readEvents ? await binding.readEvents() : request.trajectory, abort);
          abort.throwIfAborted();
          if (!await binding.authorize("read", abort)) throw new DataError("forbidden", denied);
          return { ...event, result };
        } catch { return { ...event, result: { status: "unavailable", code: "database_read_unavailable" } }; }
      })));
      const action = yield* model.react({ ...request, trajectory }, key, signal);
      const seal = <C extends { callId: string; name: string; arguments: unknown }>(call: C) => Effect.promise(async (): Promise<C> => {
        if (!DATABASE_TOOL_NAMES.has(call.name)) return call;
        abort.throwIfAborted();
        if (!await binding.authorize("read", abort)) throw new DataError("forbidden", denied);
        const scope: Scope = { owner: binding.owner, thread: binding.thread, turn: request.identity.turn, callId: call.callId, tool: call.name };
        return { ...call, arguments: { privateInput: await retain(binding, scope, "input", call.arguments) } };
      });
      if (action.kind === "call") return yield* seal(action);
      if (action.kind === "calls") return { ...action, calls: yield* Effect.forEach(action.calls, seal) };
      return action;
    }) };
  })).pipe(Layer.provide(base));
}

export { readValue as readDatabaseValue };
