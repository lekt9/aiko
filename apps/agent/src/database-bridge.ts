import { createHash } from "node:crypto";
import { validateRememberInput, type MemoryHit, type Observation, type Producer, type RememberInput } from "entity-learn";
import type { Event } from "tardie/core/event";
import { canonical, DataError, fieldValue, label, selectJsonPointer, setJsonPointer, type Cell, type Command, type EntityMapping, type Json, type QueryDependency, type Receipt, type Retention, type TableDefinition } from "../../../packages/structured-data/src/index.ts";
import type { DatabaseBinding, DatabaseRequest } from "./database-component.ts";
import { authorizeDatabaseDependencies } from "./database-refresh.ts";

type Promote = Extract<Command, { kind: "mapping.promote" }>;
type Correct = Extract<Command, { kind: "mapping.correct" }>;
type MemoryCommand = Promote | Correct;
export const isDatabaseMemoryCommand = (command: Command): command is MemoryCommand => command.kind === "mapping.promote" || command.kind === "mapping.correct";
interface Plan {
  version: 1 | 2; commandKind?: MemoryCommand["kind"]; owner: string; operationId: string; mappingId: string; mappingRevision: number;
  tableId: string; tableRevision: number; rowId: string; rowRevision: number;
  dependencies: QueryDependency[];
  evidence: RememberInput; evidenceProducer: Producer;
  target: RememberInput; targetProducer: Producer;
  advanceBaseline?: boolean;
  projection?: { columnId: string; path: string; retention: Retention }[];
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const producerOf = (reference: string): Producer => ({ kind: reference.startsWith("user:") ? "user" : "agent", reference });
const keyOf = (owner: string, operationId: string, part: string) => `aiko-database-bridge:${hash([owner, operationId, part])}`;
type Journal = { append(events: Event[]): Promise<unknown> };
type StopReason = "cancelled" | "forbidden";
const projectionOperationId = (binding: DatabaseBinding, plan: Plan) => hash(["database-correction-projection/v1", binding.owner, plan.operationId]);
function preservedDependencies(binding: DatabaseBinding, current: MemoryHit | null, evidenceSubject: string): string[] {
  // The replacement evidence moves its subject head. Retaining the prior head
  // would invalidate the new target immediately; all other dependencies remain.
  const dependsOn = (current?.observation.dependsOn ?? []).filter(id => binding.entities!.get(id).observation.subject !== evidenceSubject);
  if (dependsOn.length >= 16) throw new DataError("limit", "Memory dependency budget has no room for bridge evidence");
  return dependsOn;
}
function memoryMetadata(observation: Observation) {
  // Editing selected fields is not a refresh of untouched facts. Preserve their
  // observation time and absolute expiry; recordedAt still dates the new write.
  return { observedAt: observation.observedAt, links: observation.links, ...(observation.expiresAt === null ? {} : { ttlSeconds: (observation.expiresAt - observation.observedAt) / 1000 }), ...(observation.validFrom === null ? {} : { validFrom: observation.validFrom }), ...(observation.validTo === null ? {} : { validTo: observation.validTo }) };
}
function assertPlan(plan: Plan, binding: DatabaseBinding, request: DatabaseRequest) {
  if (!plan || ![1, 2].includes(plan.version) || plan.owner !== binding.owner || plan.operationId !== request.id || (plan.version === 1 ? "mapping.promote" : plan.commandKind) !== request.commandKind) throw new DataError("forbidden", "Publication plan identity mismatch");
}

function receipts(binding: DatabaseBinding, plan: Plan) {
  const evidence = binding.entities!.receipt(keyOf(binding.owner, plan.operationId, "evidence"));
  const target = binding.entities!.receipt(keyOf(binding.owner, plan.operationId, "target"));
  if (evidence && evidence.subject !== plan.evidence.subject || target && target.subject !== plan.target.subject || target && !evidence) throw new DataError("forbidden", "Publication receipt identity mismatch");
  return { evidence, target };
}

async function projectCorrection(binding: DatabaseBinding, plan: Plan, observationId: string, signal: AbortSignal): Promise<void> {
  const operationId = projectionOperationId(binding, plan);
  if (binding.store.receipt(operationId)) return;
  const current = binding.entities!.get(observationId), table = binding.store.table(plan.tableId);
  const cells: Record<string, { cell: Cell; retention: Retention }> = {};
  for (const field of plan.projection!) {
    const column = table.value.columns.find(column => column.id === field.columnId);
    if (!column) throw new DataError("conflict", "Projection column changed");
    let cell: Cell = { state: "missing", freshness: "fresh" };
    try {
      const value = selectJsonPointer(current.observation.payload, field.path);
      if (value !== undefined) cell = { state: "ready", freshness: current.freshness === "stale" ? "stale" : "fresh", value: fieldValue(column, value) };
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
      cell = { state: "error", freshness: "unknown", error: error.code };
    }
    cells[field.columnId] = { cell: { ...cell, observedAt: current.observation.observedAt, source: plan.target.subject, sourceGeneration: observationId, lineage: [`entity:${observationId}`, `inputs:${hash(plan.dependencies)}`] }, retention: field.retention };
  }
  if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Projection authority changed");
  signal.throwIfAborted();
  const sourceEvidence: QueryDependency[] = plan.projection!.map(field => ({ tableId: plan.tableId, tableRevision: plan.tableRevision, rowId: plan.rowId, rowRevision: plan.rowRevision, columnId: field.columnId, source: { kind: "entity", subject: plan.target.subject, observationId, followHead: true } }));
  await binding.store.commitCells(operationId, { tableId: plan.tableId, tableRevision: plan.tableRevision, mapping: { id: plan.mappingId, revision: plan.mappingRevision }, dependencies: plan.dependencies, sourceEvidence, rows: [{ rowId: plan.rowId, rowRevision: plan.rowRevision, cells }] }, (binding.now ?? Date.now)());
}

async function finishTarget(binding: DatabaseBinding, plan: Plan, planRef: string, journal: Journal, signal: AbortSignal, evidenceId: string, observationId: string, stop?: StopReason): Promise<Receipt> {
  await journal.append([{ type: "AikoDatabaseBridgeEvidenceCommitted", owner: binding.owner, thread: binding.thread, id: plan.operationId, observationId: evidenceId }]);
  await journal.append([{ type: "AikoDatabaseBridgeMemoryCommitted", owner: binding.owner, thread: binding.thread, id: plan.operationId, observationId, evidenceId }]);
  // A prior write cannot be undone by cancellation or lost authority. Reconcile
  // IDs only; neither its payload nor new memory writes are needed to report it.
  let conflictReason: Parameters<DatabaseBinding["store"]["finishBridge"]>[1]["conflictReason"];
  if (stop === "cancelled" || signal.aborted) conflictReason = "cancelled_after_memory_commit";
  else if (stop === "forbidden") conflictReason = "authority_changed_after_memory_commit";
  else {
    try { if (!await binding.authorize("write", signal)) conflictReason = "authority_changed_after_memory_commit"; }
    catch { conflictReason = signal.aborted ? "cancelled_after_memory_commit" : "authority_changed_after_memory_commit"; }
    if (signal.aborted) conflictReason = "cancelled_after_memory_commit";
    if (!conflictReason) {
      try { if (binding.entities!.head(plan.target.subject)?.observation.id !== observationId) conflictReason = "memory_changed_after_memory_commit"; }
      catch { conflictReason = "authority_changed_after_memory_commit"; }
    }
  }
  let projectionUpdated: boolean | undefined;
  if (plan.projection) {
    projectionUpdated = !!binding.store.receipt(projectionOperationId(binding, plan));
    if (!conflictReason) try {
      await projectCorrection(binding, plan, observationId, signal);
      projectionUpdated = true;
      if (signal.aborted) conflictReason = "cancelled_after_memory_commit";
      else if (!await binding.authorize("write", signal)) conflictReason = "authority_changed_after_memory_commit";
      else if (binding.entities!.head(plan.target.subject)?.observation.id !== observationId) conflictReason = "memory_changed_after_memory_commit";
    } catch (error) {
      if (!(error instanceof DataError) && !signal.aborted) throw error;
      conflictReason = signal.aborted ? "cancelled_after_memory_commit" : (error as DataError).code === "forbidden" ? "authority_changed_after_memory_commit" : "projection_unavailable_after_memory_commit";
    }
  }
  if (signal.aborted) conflictReason = "cancelled_after_memory_commit";
  return binding.store.finishBridge(plan.operationId, { planRef, mappingId: plan.mappingId, mappingRevision: plan.mappingRevision, tableId: plan.tableId, rowId: plan.rowId, tableRevision: plan.tableRevision, rowRevision: plan.rowRevision, observationId, evidenceId, canUpdate: !conflictReason, ...(plan.advanceBaseline === undefined ? {} : { advanceBaseline: plan.advanceBaseline }), ...(projectionUpdated === undefined ? {} : { projectionUpdated }), ...(conflictReason ? { conflictReason } : {}) }, (binding.now ?? Date.now)());
}

/** Host-only recovery before admission checks for new writes. It can settle an
 * existing publication after revocation/cancellation, but cannot publish values. */
export async function reconcileDatabaseBridge(binding: DatabaseBinding, request: DatabaseRequest, journal: Journal, signal: AbortSignal, stop?: StopReason): Promise<Receipt | undefined> {
  const staged = binding.store.bridgePlan(request.id);
  if (!staged) return undefined;
  if (!binding.entities) throw new DataError("unavailable", "Entity memory is not mounted");
  const plan = await binding.custody.get(binding.owner, staged.planRef) as Plan;
  assertPlan(plan, binding, request);
  const { target, evidence } = receipts(binding, plan);
  if (target) return finishTarget(binding, plan, staged.planRef, journal, signal, evidence!.observationId, target.observationId, stop);
  if (stop) return binding.store.failBridge(request.id, staged.planRef, stop, evidence?.observationId, stop === "cancelled" ? "cancelled" : "rejected", (binding.now ?? Date.now)());
  return undefined;
}

function prepare(binding: DatabaseBinding, request: DatabaseRequest, command: Promote, producer: string): Plan {
  if (!binding.entities) throw new DataError("unavailable", "Entity memory is not mounted");
  label(command.title); label(command.type);
  if (command.resolveConflict !== undefined && command.resolveConflict !== "publish-table") throw new DataError("invalid", "Unknown mapping conflict resolution");
  const mapping = binding.store.mapping(command.mappingId), table = binding.store.table(mapping.value.tableId), row = binding.store.row(table.id, mapping.value.rowId);
  if (mapping.revision !== command.expectedMappingRevision || !row || row.revision !== command.expectedRowRevision) throw new DataError("conflict", "Mapping or row changed; review before publishing");
  if (row.value.entity?.mappingId !== mapping.id || row.value.entity.subject !== mapping.value.subject) throw new DataError("conflict", "Row identity no longer matches the mapping");
  if (mapping.value.baseline && mapping.value.baseline.observationId !== command.expectedObservationId && command.resolveConflict !== "publish-table") throw new DataError("conflict", "Memory changed since the mapping baseline; resolve the conflict first");
  const fields = mapping.value.fields.filter(field => field.authority === "table");
  if (!fields.length) throw new DataError("invalid", "This mapping has no table-owned fields to publish");
  for (const field of fields) {
    const column = table.value.columns.find(column => column.id === field.columnId);
    if (!column || column.binding && column.binding.kind !== "literal" || column.authority && column.authority !== "table") throw new DataError("conflict", "Mapped field authority changed");
  }
  const query = binding.store.query({ tableId: table.id, select: fields.map(field => field.columnId), filter: { field: "$id", op: "eq", value: row.id }, limit: 1, maxBytes: 65536 });
  if (query.coverage !== "complete" || query.dependencies.some(dependency => dependency.retention === "reference-only")) throw new DataError("forbidden", "Publishing requires complete, retainable fields");
  const current = binding.entities.head(mapping.value.subject);
  if ((current?.observation.id ?? null) !== command.expectedObservationId) throw new DataError("conflict", "Memory observation changed; review before publishing");
  if (current?.observation.producer.sourceId) throw new DataError("forbidden", "Source-owned memory requires its source write operation");
  const values: Record<string, Json> = {}; let payload: Json = current?.observation.payload ?? {};
  for (const field of fields) {
    const cell = query.rows[0]?.cells[field.columnId];
    if (cell?.state !== "ready" || cell.freshness !== "fresh" || cell.value === undefined) throw new DataError("unavailable", "Mapped fields must have fresh values before publishing");
    values[field.columnId] = cell.value;
    payload = setJsonPointer(payload, field.path, cell.value);
  }
  const evidenceSubject = `structured-table/${hash([binding.owner, mapping.id])}`;
  const previousEvidence = binding.entities.head(evidenceSubject);
  const evidence = validateRememberInput({ subject: evidenceSubject, title: `Table record: ${table.value.name}`, type: "structured-table-record", kind: "episode", payload: { tableId: table.id, rowId: row.id, rowRevision: row.revision, mappingId: mapping.id, mappingRevision: mapping.revision, fields: values, dependencies: query.dependencies as unknown as Json }, ...(previousEvidence ? { supersedes: previousEvidence.observation.id } : {}) });
  const target = validateRememberInput({ subject: mapping.value.subject, title: command.title, type: command.type, kind: current?.observation.kind ?? "entity", payload, dependsOn: preservedDependencies(binding, current, evidenceSubject), ...(current ? { ...memoryMetadata(current.observation), supersedes: current.observation.id, supports: [current.observation.id] } : {}) });
  return { version: 2, commandKind: command.kind, owner: binding.owner, operationId: request.id, mappingId: mapping.id, mappingRevision: mapping.revision, tableId: table.id, tableRevision: table.revision, rowId: row.id, rowRevision: row.revision, dependencies: query.dependencies, evidence, evidenceProducer: producerOf(row.producer), target, targetProducer: producerOf(producer) };
}

function correctionProjection(mapping: EntityMapping, table: TableDefinition): NonNullable<Plan["projection"]> {
  return mapping.fields.filter(field => field.authority === "entity").map(field => {
    const column = table.columns.find(column => column.id === field.columnId), definition = column?.binding;
    if (!column || column.authority && column.authority !== "entity" || definition?.kind !== "entity" || definition.path !== field.path || definition.observationId || definition.subjectField || definition.subject && definition.subject !== mapping.subject) throw new DataError("conflict", "Mapped entity field authority changed");
    return { columnId: field.columnId, path: field.path, retention: definition.retention };
  });
}

/** Selected-field read for a correction editor. Never returns the entity payload. */
export function databaseCorrectionContext(binding: DatabaseBinding, tableId: string, rowId: string, columnId: string): import("@unlock/protocol").DatabaseFieldResult["memory"] {
  const table = binding.store.table(tableId), row = binding.store.row(tableId, rowId);
  binding.store.assertRead(tableId, columnId, rowId);
  if (!binding.entities || !row?.value.entity?.mappingId) return;
  const mapping = binding.store.mapping(row.value.entity.mappingId);
  const field = mapping.value.fields.find(field => field.columnId === columnId && field.authority === "entity");
  if (!field || mapping.value.tableId !== tableId || mapping.value.rowId !== rowId || mapping.value.subject !== row.value.entity.subject) return;
  const projection = correctionProjection(mapping.value, table.value);
  if (!projection.some(field => field.columnId === columnId)) return;
  const head = binding.entities.head(mapping.value.subject);
  if (!head) return;
  const selected = selectJsonPointer(head.observation.payload, field.path);
  if (selected !== undefined && new TextEncoder().encode(canonical(selected)).length > 65_536) throw new DataError("limit", "Memory field exceeds editor byte budget");
  const current: Cell = { state: selected === undefined ? "missing" : "ready", freshness: head.freshness === "stale" || head.state !== "current" ? "stale" : "fresh", observedAt: head.observation.observedAt };
  if (selected !== undefined) {
    try { current.value = fieldValue(table.value.columns.find(column => column.id === columnId)!, selected); }
    catch { current.state = "error"; current.error = "type_mismatch"; }
  }
  return { mappingId: mapping.id, mappingRevision: mapping.revision, observationId: head.observation.id, current, canCorrect: !head.observation.producer.sourceId && !Object.hasOwn(row.value.overrides ?? {}, columnId) };
}

function prepareCorrection(binding: DatabaseBinding, request: DatabaseRequest, command: Correct, producer: string): Plan {
  const entities = binding.entities!, mapping = binding.store.mapping(command.mappingId), table = binding.store.table(mapping.value.tableId), row = binding.store.row(table.id, mapping.value.rowId);
  if (mapping.revision !== command.expectedMappingRevision || !row || row.revision !== command.expectedRowRevision || row.value.entity?.mappingId !== mapping.id || row.value.entity.subject !== mapping.value.subject) throw new DataError("conflict", "Mapping or row changed; review before correcting memory");
  const current = entities.head(mapping.value.subject);
  if (!current || current.observation.id !== command.expectedObservationId) throw new DataError("conflict", "Memory observation changed; review before correcting it");
  if (current.observation.producer.sourceId) throw new DataError("forbidden", "Source-owned memory requires its source write operation");
  if (!command.values || typeof command.values !== "object" || Array.isArray(command.values) || !Object.keys(command.values).length || Object.keys(command.values).length > 32) throw new DataError("invalid", "Correction requires 1..32 mapped field values");
  const values: Record<string, Json> = {}, projection = correctionProjection(mapping.value, table.value);
  let payload: Json = current.observation.payload;
  for (const [columnId, value] of Object.entries(command.values)) {
    const field = projection.find(field => field.columnId === columnId), column = table.value.columns.find(column => column.id === columnId);
    if (!field || !column) throw new DataError("forbidden", "Corrections can change only entity-owned mapped fields");
    if (Object.hasOwn(row.value.overrides ?? {}, columnId)) throw new DataError("conflict", "This field has a local override; resolve it before correcting memory");
    values[columnId] = fieldValue(column, value);
    payload = setJsonPointer(payload, field.path, values[columnId]!);
  }
  const dependencies: QueryDependency[] = projection.map(field => ({ tableId: table.id, tableRevision: table.revision, rowId: row.id, rowRevision: row.revision, columnId: field.columnId }));
  const evidenceSubject = `structured-table-edit/${hash([binding.owner, mapping.id])}`, previousEvidence = entities.head(evidenceSubject);
  const evidence = validateRememberInput({ subject: evidenceSubject, title: `Mapped edit: ${table.value.name}`, type: "structured-table-correction", kind: "episode", payload: { tableId: table.id, rowId: row.id, rowRevision: row.revision, mappingId: mapping.id, mappingRevision: mapping.revision, expectedObservationId: current.observation.id, fields: values }, supports: [current.observation.id], ...(previousEvidence ? { supersedes: previousEvidence.observation.id } : {}) });
  const dependsOn = preservedDependencies(binding, current, evidenceSubject);
  const target = validateRememberInput({ subject: mapping.value.subject, title: current.observation.title, type: current.observation.type, kind: current.observation.kind, payload, supersedes: current.observation.id, supports: [current.observation.id], dependsOn, ...memoryMetadata(current.observation) });
  const baseline = mapping.value.baseline;
  const advanceBaseline = mapping.value.fields.every(field => field.authority === "entity") || !!baseline && baseline.rowRevision === row.revision && baseline.observationId === current.observation.id;
  return { version: 2, commandKind: command.kind, owner: binding.owner, operationId: request.id, mappingId: mapping.id, mappingRevision: mapping.revision, tableId: table.id, tableRevision: table.revision, rowId: row.id, rowRevision: row.revision, dependencies, evidence, evidenceProducer: producerOf(producer), target, targetProducer: producerOf(producer), advanceBaseline, projection };
}

/** The outbox binds one native occurrence to its immutable publication plan.
 * Actual entity-learn receipts reconcile either memory commit after a restart. */
export async function executeDatabaseBridge(binding: DatabaseBinding, request: DatabaseRequest, command: MemoryCommand, producer: string, journal: Journal, signal: AbortSignal): Promise<Receipt> {
  if (!binding.entities) throw new DataError("unavailable", "Entity memory is not mounted");
  const entities = binding.entities;
  const priorPlan = binding.store.bridgePlan(request.id);
  let plan: Plan, planRef: string;
  if (priorPlan) { planRef = priorPlan.planRef; plan = await binding.custody.get(binding.owner, planRef) as Plan; }
  else {
    signal.throwIfAborted();
    if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Memory publication is unavailable");
    plan = command.kind === "mapping.correct" ? prepareCorrection(binding, request, command, producer) : prepare(binding, request, command, producer);
    await authorizeDatabaseDependencies(binding, plan.dependencies, signal);
    planRef = await binding.custody.put(binding.owner, plan);
    signal.throwIfAborted();
    if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Memory publication authority changed");
    binding.store.stageBridge(request.id, planRef, plan.dependencies, plan.mappingId, plan.mappingRevision);
  }
  assertPlan(plan, binding, request);
  if (plan.mappingId !== command.mappingId || request.commandKind !== command.kind) throw new DataError("forbidden", "Publication command mismatch");
  const completed = binding.store.receipt(request.id);
  if (completed) return completed;
  const evidenceKey = keyOf(binding.owner, request.id, "evidence"), targetKey = keyOf(binding.owner, request.id, "target");
  await journal.append([{ type: "AikoDatabaseBridgePlanned", owner: binding.owner, thread: binding.thread, id: request.id, planRef }]);
  let { evidence, target } = receipts(binding, plan);
  try { if (!target) {
    signal.throwIfAborted();
    if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Memory publication authority changed");
    if (binding.store.mapping(plan.mappingId).revision !== plan.mappingRevision) throw new DataError("conflict", "Mapping changed during publication");
    binding.store.assertCurrentDependencies(plan.dependencies, true);
    await authorizeDatabaseDependencies(binding, plan.dependencies, signal);
    const current = entities.head(plan.target.subject);
    if ((current?.observation.id ?? null) !== (plan.target.supersedes ?? null)) throw new DataError("conflict", "Memory changed during publication");
    signal.throwIfAborted();
    if (!evidence) {
      const observation = entities.remember(plan.evidence, evidenceKey, plan.evidenceProducer);
      evidence = { observationId: observation.id, subject: observation.subject };
    }
    await journal.append([{ type: "AikoDatabaseBridgeEvidenceCommitted", owner: binding.owner, thread: binding.thread, id: request.id, observationId: evidence.observationId }]);
    signal.throwIfAborted();
    if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Memory publication authority changed");
    if (binding.store.mapping(plan.mappingId).revision !== plan.mappingRevision) throw new DataError("conflict", "Mapping changed during publication");
    binding.store.assertCurrentDependencies(plan.dependencies, true);
    signal.throwIfAborted();
    const observation = entities.remember({ ...plan.target, supports: [...(plan.target.supports ?? []), evidence.observationId], dependsOn: [...(plan.target.dependsOn ?? []), evidence.observationId] }, targetKey, plan.targetProducer);
    target = { observationId: observation.id, subject: observation.subject };
  } } catch (error) {
    if (!(error instanceof DataError) && !signal.aborted) throw error;
    // A receipt is authoritative even if the post-commit read was subsequently
    // suppressed. Reconcile it without returning or rewriting its payload.
    ({ target, evidence } = receipts(binding, plan));
    const code = signal.aborted ? "cancelled" : (error as DataError).code;
    if (!target) return binding.store.failBridge(request.id, planRef, code, evidence?.observationId, code === "cancelled" ? "cancelled" : code === "conflict" ? "conflict" : code === "forbidden" ? "rejected" : "unavailable", (binding.now ?? Date.now)());
  }
  return finishTarget(binding, plan, planRef, journal, signal, evidence!.observationId, target.observationId);
}
