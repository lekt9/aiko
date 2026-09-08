import { canonical, clone, fieldValue, identifier, integer, label, validateColumns } from "./codec.js";
import { evaluateQuery } from "./query.js";
import { DataError, type ArtifactDefinition, type Cell, type Column, type Command, type DatabaseDefinition, type Json, type Query, type QueryDependency, type QueryResult, type Receipt, type RecordRevision, type RowData, type Storage, type TableDefinition, type ViewDefinition } from "./types.js";

export interface DomainCollection {
  definition: TableDefinition;
  rows(): { rows: RecordRevision<RowData>[]; revision: number; complete: boolean };
  revision?: () => string;
  coverage?: string;
}
export interface StoreOptions {
  now?: () => number;
  /** Host-owned, synchronous current read policy, checked even for lookup/filter dependencies. */
  canRead?: (tableId: string, columnId?: string, rowId?: string) => boolean;
  /** Host checks current source grants and suppression against exact historical evidence. */
  canReadDependency?: (dependency: QueryDependency) => boolean;
  domains?: ReadonlyMap<string, DomainCollection>;
}
export interface SavedCell {
  tableRevision: number;
  rowRevision: number;
  cell: Cell;
  retention: "reference-only" | "materialized" | "snapshot";
}
type Kind = "database" | "table" | "row" | "view" | "artifact" | "cell" | "mapping" | "schedule";
const key = (...parts: string[]) => JSON.stringify(parts);

/** Domain state lives in SQLite; the native actor owns execution and delivery. */
export class StructuredStore {
  readonly now: () => number;
  constructor(readonly storage: Storage, readonly owner: string, readonly options: StoreOptions = {}) {
    identifier(owner, "owner"); this.now = options.now ?? Date.now;
    const schema = `
      CREATE TABLE IF NOT EXISTS structured_meta(owner TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS structured_records(owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        value TEXT NOT NULL, at INTEGER NOT NULL, producer TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(owner,kind,id,revision));
      CREATE TABLE IF NOT EXISTS structured_heads(owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(owner,kind,id));
      CREATE TABLE IF NOT EXISTS structured_operations(owner TEXT NOT NULL, id TEXT NOT NULL, command TEXT NOT NULL, receipt TEXT NOT NULL,
        PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS structured_edges(owner TEXT NOT NULL, source_table TEXT NOT NULL, source_row TEXT NOT NULL,
        source_column TEXT NOT NULL, target_table TEXT NOT NULL, target_row TEXT NOT NULL,
        PRIMARY KEY(owner,source_table,source_row,source_column,target_table,target_row));
      CREATE INDEX IF NOT EXISTS structured_edge_target ON structured_edges(owner,target_table,target_row);
      CREATE TABLE IF NOT EXISTS structured_outbox(owner TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS structured_checks(owner TEXT NOT NULL, id TEXT NOT NULL, table_id TEXT NOT NULL, row_id TEXT NOT NULL,
        column_id TEXT NOT NULL, at INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(owner,id));
    `;
    // The portable port guarantees a single statement per exec; SQLite DO and
    // prepared-statement adapters need not execute a multi-statement batch.
    storage.transaction(() => { for (const statement of schema.split(";")) if (statement.trim()) storage.exec(statement); });
    storage.prepare("INSERT OR IGNORE INTO structured_meta(owner,revision) VALUES (?,0)").run(owner);
  }
  revision(): number { return Number(this.storage.prepare("SELECT revision FROM structured_meta WHERE owner=?").get(this.owner)!.revision); }
  domainRevisions(): Record<string, string> { return Object.fromEntries([...(this.options.domains ?? [])].map(([id, domain]) => [id, domain.revision?.() ?? String(domain.rows().revision)])); }
  private nextRevision(): number {
    this.storage.prepare("UPDATE structured_meta SET revision=revision+1 WHERE owner=?").run(this.owner); return this.revision();
  }
  assertRead(tableId: string, columnId?: string, rowId?: string) {
    if (this.options.canRead && !this.options.canRead(tableId, columnId, rowId)) throw new DataError("forbidden", "Collection data is unavailable under current access");
  }
  assertDependency(dependency: QueryDependency) {
    this.table(dependency.tableId);
    this.assertRead(dependency.tableId, dependency.columnId, dependency.rowId);
    if (this.options.canReadDependency && !this.options.canReadDependency(dependency)) throw new DataError("forbidden", "Source evidence is unavailable under current access");
  }
  private decode<T>(row: Record<string, unknown>): RecordRevision<T> {
    return { id: String(row.id), revision: Number(row.revision), value: JSON.parse(String(row.value)) as T, at: Number(row.at), producer: String(row.producer), deleted: !!row.deleted };
  }
  record<T>(kind: Kind, id: string, revision?: number): RecordRevision<T> | undefined {
    const found = revision === undefined
      ? this.storage.prepare("SELECT r.* FROM structured_records r JOIN structured_heads h ON h.owner=r.owner AND h.kind=r.kind AND h.id=r.id AND h.revision=r.revision WHERE r.owner=? AND r.kind=? AND r.id=?").get(this.owner, kind, id)
      : this.storage.prepare("SELECT * FROM structured_records WHERE owner=? AND kind=? AND id=? AND revision=?").get(this.owner, kind, id, revision);
    return found ? this.decode<T>(found) : undefined;
  }
  private write<T>(kind: Kind, id: string, value: T, expected: number, at: number, producer: string, deleted = false): RecordRevision<T> {
    const prior = this.record<T>(kind, id);
    integer(expected, 0, Number.MAX_SAFE_INTEGER);
    if ((prior?.revision ?? 0) !== expected) throw new DataError("conflict", `${kind} changed; expected revision ${expected}, current ${prior?.revision ?? 0}`);
    const revision = expected + 1;
    this.storage.prepare("INSERT INTO structured_records(owner,kind,id,revision,value,at,producer,deleted) VALUES (?,?,?,?,?,?,?,?)").run(this.owner, kind, id, revision, canonical(value), at, producer, deleted ? 1 : 0);
    this.storage.prepare("INSERT INTO structured_heads(owner,kind,id,revision) VALUES (?,?,?,?) ON CONFLICT(owner,kind,id) DO UPDATE SET revision=excluded.revision").run(this.owner, kind, id, revision);
    return { id, revision, value: clone(value), at, producer, deleted };
  }
  list<T>(kind: Kind, limit = 1000): RecordRevision<T>[] {
    integer(limit, 1, 10001);
    return this.storage.prepare("SELECT r.* FROM structured_records r JOIN structured_heads h ON h.owner=r.owner AND h.kind=r.kind AND h.id=r.id AND h.revision=r.revision WHERE r.owner=? AND r.kind=? AND r.deleted=0 ORDER BY r.id LIMIT ?").all(this.owner, kind, limit).map(r => this.decode<T>(r));
  }
  database(id: string): RecordRevision<DatabaseDefinition> {
    const result = this.record<DatabaseDefinition>("database", id);
    if (!result || result.deleted || result.value.expiresAt !== undefined && result.value.expiresAt <= this.now()) throw new DataError("missing", "Database unavailable or expired");
    return result;
  }
  table(id: string): RecordRevision<TableDefinition> {
    identifier(id, "table ID"); this.assertRead(id);
    const domain = this.options.domains?.get(id);
    if (domain) return { id, revision: domain.rows().revision, value: clone(domain.definition), producer: "domain", deleted: false, at: this.now() };
    const result = this.record<TableDefinition>("table", id);
    if (!result || result.deleted) throw new DataError("missing", "Table unavailable");
    this.database(result.value.databaseId); return result;
  }
  rows(tableId: string, limit = 2001): { rows: RecordRevision<RowData>[]; complete: boolean } {
    this.table(tableId); integer(limit, 1, 10001);
    const domain = this.options.domains?.get(tableId);
    if (domain) {
      const result = domain.rows();
      return { rows: clone(result.rows.slice(0, limit)), complete: result.complete && result.rows.length <= limit };
    }
    const prefix = key(tableId).slice(0, -1) + ",";
    // instr avoids LIKE wildcard semantics for caller-selected stable identifiers.
    const rows = this.storage.prepare("SELECT r.* FROM structured_records r JOIN structured_heads h ON h.owner=r.owner AND h.kind=r.kind AND h.id=r.id AND h.revision=r.revision WHERE r.owner=? AND r.kind='row' AND r.deleted=0 AND instr(r.id,?)=1 ORDER BY r.id LIMIT ?").all(this.owner, prefix, limit + 1);
    return { rows: rows.slice(0, limit).map(r => { const record = this.decode<RowData>(r); record.id = JSON.parse(record.id)[1]; return record; }), complete: rows.length <= limit };
  }
  row(tableId: string, id: string): RecordRevision<RowData> | undefined {
    this.table(tableId); this.assertRead(tableId, undefined, id);
    const domain = this.options.domains?.get(tableId);
    if (domain) { const row = domain.rows().rows.find(r => r.id === id); return row ? clone(row) : undefined; }
    const result = this.record<RowData>("row", key(tableId, id));
    if (!result || result.deleted) return undefined;
    result.id = id; return result;
  }
  cell(tableId: string, rowId: string, columnId: string): SavedCell | undefined {
    this.assertRead(tableId, columnId, rowId); return this.record<SavedCell>("cell", key(tableId, rowId, columnId))?.value;
  }
  history<T>(kind: Kind, id: string, limit = 100): RecordRevision<T>[] {
    integer(limit, 1, 1000);
    return this.storage.prepare("SELECT * FROM structured_records WHERE owner=? AND kind=? AND id=? ORDER BY revision DESC LIMIT ?").all(this.owner, kind, id, limit).map(r => this.decode<T>(r));
  }
  receipt(id: string): Receipt | undefined {
    const row = this.storage.prepare("SELECT receipt FROM structured_operations WHERE owner=? AND id=?").get(this.owner, id);
    return row ? JSON.parse(String(row.receipt)) as Receipt : undefined;
  }
  private writable(tableId: string) {
    const table = this.table(tableId);
    if (table.value.mode !== "stored" || tableId.startsWith("system.")) throw new DataError("forbidden", "Domain collections require their host commands");
    return table;
  }
  private enqueue(id: string, kind: string, payload: unknown) {
    this.storage.prepare("INSERT OR IGNORE INTO structured_outbox(owner,id,kind,payload) VALUES (?,?,?,?)").run(this.owner, id, kind, canonical(payload));
  }
  pending(limit = 100): { id: string; kind: string; payload: Json }[] {
    integer(limit, 1, 1000);
    return this.storage.prepare("SELECT id,kind,payload FROM structured_outbox WHERE owner=? AND settled=0 ORDER BY id LIMIT ?").all(this.owner, limit).map(r => ({ id: String(r.id), kind: String(r.kind), payload: JSON.parse(String(r.payload)) }));
  }
  settleDelivery(id: string) { this.storage.prepare("UPDATE structured_outbox SET settled=1 WHERE owner=? AND id=?").run(this.owner, id); }
  execute(operationId: string, input: Command, context: { at: number; producer: string }): Receipt {
    identifier(operationId, "operation ID"); integer(context.at, 0, Number.MAX_SAFE_INTEGER); label(context.producer);
    const command = clone(input), encoded = canonical({ command, producer: context.producer });
    if (encoded.length > 1_048_576) throw new DataError("limit", "Command exceeds 1 MiB");
    return this.storage.transaction(() => {
      const prior = this.storage.prepare("SELECT command,receipt FROM structured_operations WHERE owner=? AND id=?").get(this.owner, operationId);
      if (prior) {
        if (prior.command !== encoded) throw new DataError("conflict", "Operation ID already bound to a different command");
        return JSON.parse(String(prior.receipt)) as Receipt;
      }
      const result = this.apply(command, context);
      const receipt: Receipt = { operationId, revision: this.nextRevision(), at: context.at, result: clone(result) as Json };
      this.storage.prepare("INSERT INTO structured_operations(owner,id,command,receipt) VALUES (?,?,?,?)").run(this.owner, operationId, encoded, canonical(receipt));
      this.enqueue(`change:${operationId}`, "change", { operationId, revision: receipt.revision });
      return receipt;
    });
  }
  private apply(command: Command, { at, producer }: { at: number; producer: string }): unknown {
    if (command.kind === "table.refresh") throw new DataError("invalid", "Refresh requires the native host executor");
    switch (command.kind) {
      case "database.create": {
        const d = command.database; identifier(d.id); label(d.name);
        if (d.id.startsWith("system.") || !["temporary", "internal", "visible"].includes(d.lifecycle)) throw new DataError("invalid", "Invalid database lifecycle or ID");
        if (d.lifecycle === "temporary" && d.expiresAt === undefined) throw new DataError("invalid", "Temporary databases require expiry");
        if (d.expiresAt !== undefined) integer(d.expiresAt, at + 1, Number.MAX_SAFE_INTEGER);
        return this.write("database", d.id, d, 0, at, producer);
      }
      case "table.define": {
        const t = clone(command.table); identifier(t.id); label(t.name); this.database(t.databaseId);
        if (t.id.startsWith("system.") || t.mode !== "stored" || t.columns.some(c => c.authority === "domain")) throw new DataError("forbidden", "Only the host registers domain collections");
        t.columns = validateColumns(t.columns);
        const prior = this.record<TableDefinition>("table", t.id);
        if (prior && prior.value.databaseId !== t.databaseId) throw new DataError("invalid", "Moving a table between databases requires migration");
        for (const column of t.columns) if (column.relation && column.relation.tableId !== t.id) {
          const target = this.table(column.relation.tableId);
          if (target.value.mode === "stored") {
            const targetExpiry = this.database(target.value.databaseId).value.expiresAt;
            const sourceExpiry = this.database(t.databaseId).value.expiresAt;
            if (targetExpiry !== undefined && (sourceExpiry === undefined || sourceExpiry > targetExpiry)) throw new DataError("invalid", "Relation cannot outlive its target database");
          }
        }
        if (prior) {
          const existing = this.rows(t.id, 10000);
          if (!existing.complete) throw new DataError("limit", "Schema migration exceeds row budget");
          for (const row of existing.rows) this.validateRow(t, row.value.values, row.value.overrides ?? {});
          // Never leave saved references pointing at removed fields.
          const removed = prior.value.columns.filter(c => !t.columns.some(n => n.id === c.id)).map(c => c.id);
          if (removed.length && existing.rows.some(r => removed.some(id => Object.hasOwn(r.value.values, id)))) throw new DataError("conflict", "Remove stored field values explicitly before deleting columns");
        }
        return this.write("table", t.id, t, command.expectedRevision, at, producer);
      }
      case "rows.upsert": {
        const table = this.writable(command.tableId);
        if (!Array.isArray(command.rows) || !command.rows.length || command.rows.length > 500) throw new DataError("limit", "Upsert needs 1..500 rows");
        const ids = new Set<string>();
        const prepared = command.rows.map(input => {
          identifier(input.id); if (ids.has(input.id)) throw new DataError("invalid", "Duplicate batch row ID"); ids.add(input.id);
          const prior = this.record<RowData>("row", key(table.id, input.id));
          if (prior?.deleted) throw new DataError("conflict", "Deleted row IDs cannot be reused");
          const value: RowData = { values: { ...prior?.value.values, ...input.values }, ...(prior?.value.entity ? { entity: prior.value.entity } : {}) };
          const overrides = { ...prior?.value.overrides, ...input.overrides };
          if (Object.keys(overrides).length) value.overrides = overrides;
          this.validateRow(table.value, value.values, overrides);
          return { input, value };
        });
        const results = prepared.map(({ input, value }) => {
          this.validateRelations(table.value, input.id, value, ids);
          const record = this.write("row", key(table.id, input.id), value, input.expectedRevision, at, producer);
          this.syncEdges(table.value, input.id, value);
          this.enqueue(`row:${key(table.id, input.id)}:${record.revision}`, "row", { tableId: table.id, rowId: input.id, rowRevision: record.revision });
          return { id: input.id, revision: record.revision };
        });
        return { rows: results };
      }
      case "rows.delete": {
        const table = this.writable(command.tableId);
        if (!command.rows.length || command.rows.length > 500) throw new DataError("limit", "Delete needs 1..500 rows");
        return { rows: command.rows.map(input => {
          const prior = this.row(table.id, input.id);
          if (!prior) throw new DataError("missing", "Row not found");
          const result = this.write("row", key(table.id, input.id), prior.value, input.expectedRevision, at, producer, true);
          this.storage.prepare("DELETE FROM structured_edges WHERE owner=? AND source_table=? AND source_row=?").run(this.owner, table.id, input.id);
          this.enqueue(`row:${key(table.id, input.id)}:${result.revision}`, "row", { tableId: table.id, rowId: input.id, rowRevision: result.revision, deleted: true });
          return { id: input.id, revision: result.revision };
        }) };
      }
      case "view.save": {
        identifier(command.view.id); label(command.view.title);
        if (!["table", "list", "board", "calendar", "chart"].includes(command.view.layout)) throw new DataError("invalid", "Unknown view layout");
        evaluateQuery(this, clone({ ...command.view.query, limit: 1 }));
        return this.write("view", command.view.id, command.view, command.expectedRevision, at, producer);
      }
      case "artifact.create": {
        identifier(command.artifactId); label(command.title);
        if (!["live", "snapshot"].includes(command.dataMode)) throw new DataError("invalid", "Unknown artifact mode");
        const view = this.record<ViewDefinition>("view", command.viewId, command.viewRevision);
        if (!view || view.deleted) throw new DataError("missing", "View revision missing");
        const artifact: ArtifactDefinition = { schemaVersion: 1, kind: "database", artifactId: command.artifactId, title: command.title, viewId: view.id, viewRevision: view.revision, dataMode: command.dataMode, presentation: { inline: "preview", expanded: "mini-app" }, renderer: { kind: "json-render", catalogVersion: "aiko-db/v1" } };
        artifact.spec = { root: "database", elements: { database: { type: "DatabaseView", props: { artifactId: artifact.artifactId }, children: [] } } };
        if (command.dataMode === "snapshot") {
          artifact.snapshot = evaluateQuery(this, clone(view.value.query));
          if (artifact.snapshot.dependencies.some(d => d.retention === "reference-only")) throw new DataError("forbidden", "Snapshot requires explicit retention for live dependencies");
        }
        const record = this.write("artifact", artifact.artifactId, artifact, 0, at, producer);
        // Operation inspection must not become an alternate historical row read.
        return { artifactId: artifact.artifactId, revision: record.revision, viewId: artifact.viewId, viewRevision: artifact.viewRevision, dataMode: artifact.dataMode };
      }
      default: throw new DataError("invalid", "Unknown database command");
    }
  }
  private validateRow(table: TableDefinition, values: Record<string, Json>, overrides: Record<string, Json>) {
    for (const [id, value] of Object.entries(values)) {
      const column = table.columns.find(c => c.id === id);
      if (!column) throw new DataError("invalid", `Unknown column ${id}`);
      if (column.binding && column.binding.kind !== "literal" || column.authority && column.authority !== "table") throw new DataError("forbidden", `Field ${id} is owned by its binding`);
      values[id] = fieldValue(column, value);
    }
    for (const [id, value] of Object.entries(overrides)) {
      const column = table.columns.find(c => c.id === id);
      if (!column || column.authority === "domain" || !column.binding || column.binding.kind === "literal") throw new DataError("invalid", "Override requires a computed field");
      overrides[id] = fieldValue(column, value);
    }
    for (const column of table.columns) if (column.required && (!column.binding || column.binding.kind === "literal") && !Object.hasOwn(values, column.id)) throw new DataError("invalid", `Required field ${column.id} is missing`);
  }
  private validateRelations(table: TableDefinition, rowId: string, row: RowData, pendingIds: Set<string>) {
    for (const c of table.columns) if (c.relation && row.values[c.id] != null) {
      const value = row.values[c.id]!;
      for (const target of (Array.isArray(value) ? value : [value]) as string[]) {
        if (!(c.relation.tableId === table.id && pendingIds.has(target)) && !this.row(c.relation.tableId, target)) throw new DataError("missing", "Relation target unavailable");
        if (c.relation.cardinality === "one-to-one") {
          const existing = this.storage.prepare("SELECT source_row FROM structured_edges WHERE owner=? AND source_table=? AND source_column=? AND target_table=? AND target_row=? AND source_row<>? LIMIT 1").get(this.owner, table.id, c.id, c.relation.tableId, target, rowId);
          if (existing) throw new DataError("conflict", "One-to-one target already referenced");
        }
      }
    }
  }
  private syncEdges(table: TableDefinition, rowId: string, row: RowData) {
    this.storage.prepare("DELETE FROM structured_edges WHERE owner=? AND source_table=? AND source_row=?").run(this.owner, table.id, rowId);
    for (const c of table.columns) if (c.relation && row.values[c.id] != null) {
      const v = row.values[c.id]!;
      for (const target of (Array.isArray(v) ? v : [v]) as string[]) this.storage.prepare("INSERT INTO structured_edges(owner,source_table,source_row,source_column,target_table,target_row) VALUES (?,?,?,?,?,?)").run(this.owner, table.id, rowId, c.id, c.relation.tableId, target);
    }
  }
  query(input: Query): QueryResult { return this.storage.read(() => evaluateQuery(this, clone(input))); }
  artifact(id: string): { artifact: ArtifactDefinition; view: ViewDefinition; result: QueryResult } {
    const record = this.record<ArtifactDefinition>("artifact", id);
    if (!record || record.deleted) throw new DataError("missing", "Artifact unavailable");
    const artifact = record.value, view = this.record<ViewDefinition>("view", artifact.viewId, artifact.viewRevision);
    if (!view) throw new DataError("missing", "Artifact view unavailable");
    if (artifact.dataMode === "snapshot") {
      // Re-running the current query loses deleted rows and replaced dependencies.
      // Legacy snapshots without an evidence manifest must be recreated explicitly.
      if (!artifact.snapshot?.dependencies) throw new DataError("unavailable", "Snapshot has no dependency evidence");
      for (const dependency of artifact.snapshot.dependencies) this.assertDependency(dependency);
      return { artifact, view: view.value, result: artifact.snapshot };
    }
    return { artifact, view: view.value, result: this.query(view.value.query) };
  }
  /** Host evaluator commits selected materialized cells; raw source responses never enter this API. */
  completeEvaluation(operationId: string, planDigest: string, result: Json, at: number): Receipt {
    identifier(operationId); label(planDigest); integer(at, 0, Number.MAX_SAFE_INTEGER);
    return this.storage.transaction(() => {
      const previous = this.storage.prepare("SELECT command,receipt FROM structured_operations WHERE owner=? AND id=?").get(this.owner, operationId);
      if (previous) {
        if (previous.command !== `refresh:${planDigest}`) throw new DataError("conflict", "Refresh identity changed");
        return JSON.parse(String(previous.receipt)) as Receipt;
      }
      const receipt: Receipt = { operationId, result: clone(result), at, revision: this.nextRevision() };
      this.storage.prepare("INSERT INTO structured_operations(owner,id,command,receipt) VALUES (?,?,?,?)").run(this.owner, operationId, `refresh:${planDigest}`, canonical(receipt));
      this.enqueue(`refresh:${operationId}`, "refresh", { operationId, revision: receipt.revision });
      return receipt;
    });
  }
  async commitCells(operationId: string, input: { tableId: string; tableRevision: number; rows: { rowId: string; rowRevision: number; cells: Record<string, { cell: Cell; retention: SavedCell["retention"] }> }[]; check?: { calls: number; bytes: number; status: "completed" | "failed"; code?: string } }, at: number): Promise<Receipt> {
    identifier(operationId); input = clone(input); integer(at, 0, Number.MAX_SAFE_INTEGER);
    // Persist only the digest of source inputs, especially for reference-only values.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical({ owner: this.owner, input })));
    const encoded = `evaluation:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}`;
    return this.storage.transaction(() => {
      const existing = this.storage.prepare("SELECT command,receipt FROM structured_operations WHERE owner=? AND id=?").get(this.owner, operationId);
      if (existing) { if (existing.command !== encoded) throw new DataError("conflict", "Evaluation operation conflict"); return JSON.parse(String(existing.receipt)); }
      const table = this.writable(input.tableId);
      if (table.revision !== input.tableRevision) throw new DataError("conflict", "Table binding changed during evaluation");
      const changed: string[] = [];
      for (const evaluated of input.rows) {
        const row = this.row(table.id, evaluated.rowId);
        if (!row || row.revision !== evaluated.rowRevision) throw new DataError("conflict", "Row changed during evaluation");
        for (const [columnId, selected] of Object.entries(evaluated.cells)) {
          const column = table.value.columns.find(c => c.id === columnId);
          if (!column?.binding || !["entity", "request"].includes(column.binding.kind)) throw new DataError("invalid", "Only source fields can be materialized");
          const declared = column.binding as Extract<NonNullable<Column["binding"]>, { kind: "entity" | "request" }>;
          if (declared.retention !== selected.retention) throw new DataError("forbidden", "Retention differs from binding");
          const id = key(table.id, row.id, columnId), previous = this.record<SavedCell>("cell", id);
          const cell = clone(selected.cell);
          if (cell.state === "ready") {
            if (cell.value === undefined) throw new DataError("invalid", "Ready source field requires value");
            cell.value = fieldValue(column, cell.value);
            cell.observedAt ??= at;
          }
          cell.checkedAt = at;
          if (selected.retention === "reference-only") { delete cell.value; cell.state = "unavailable"; cell.freshness = "unknown"; }
          const same = previous && canonical({ value: previous.value.cell.value ?? null, state: previous.value.cell.state, lineage: previous.value.cell.lineage ?? [] }) === canonical({ value: cell.value ?? null, state: cell.state, lineage: cell.lineage ?? [] });
          if (cell.state === "error" && previous?.value.cell.value !== undefined && selected.retention !== "reference-only" && previous.value.retention === selected.retention && previous.value.tableRevision === table.revision && previous.value.rowRevision === row.revision && previous.value.cell.sourceGeneration === cell.sourceGeneration) {
            cell.value = previous.value.cell.value; cell.state = "ready"; cell.freshness = "stale"; cell.observedAt = previous.value.cell.observedAt ?? previous.at; cell.valueVersion = previous.value.cell.valueVersion;
            if (previous.value.cell.lineage) cell.lineage = previous.value.cell.lineage;
          } else {
            cell.valueVersion = same ? previous!.value.cell.valueVersion : (previous?.value.cell.valueVersion ?? 0) + 1;
            if (same && previous?.value.cell.observedAt !== undefined) cell.observedAt = previous.value.cell.observedAt;
          }
          if (cell.valueVersion !== previous?.value.cell.valueVersion) changed.push(`${row.id}.${columnId}`);
          const saved: SavedCell = { tableRevision: table.revision, rowRevision: row.revision, retention: selected.retention, cell };
          this.write("cell", id, saved, previous?.revision ?? 0, at, "source");
          // Receipts record freshness/lineage only, not a second copy of selected values.
          const { value: _value, ...check } = cell;
          this.storage.prepare("INSERT INTO structured_checks(owner,id,table_id,row_id,column_id,at,receipt) VALUES (?,?,?,?,?,?,?)").run(this.owner, key(operationId, row.id, columnId), table.id, row.id, columnId, at, canonical(check));
        }
      }
      const receipt: Receipt = { operationId, at, revision: this.nextRevision(), result: { changed, ...(input.check ?? {}) } };
      this.storage.prepare("INSERT INTO structured_operations(owner,id,command,receipt) VALUES (?,?,?,?)").run(this.owner, operationId, encoded, canonical(receipt));
      this.enqueue(`check:${operationId}`, "check", { tableId: table.id, at, changed, revision: receipt.revision });
      return receipt;
    });
  }
}
