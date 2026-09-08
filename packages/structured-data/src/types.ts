export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SqlValue = null | string | number;
export interface Storage {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: SqlValue[]): Record<string, unknown> | undefined;
    all(...args: SqlValue[]): Record<string, unknown>[];
    run(...args: SqlValue[]): unknown;
  };
  transaction<T>(run: () => T): T;
  read<T>(run: () => T): T;
}
export type Authority = "table" | "entity" | "external" | "domain";
export type Retention = "reference-only" | "materialized" | "snapshot";
export type FieldType = "text" | "boolean" | "integer" | "decimal" | "timestamp" | "enum" | "json" | "relation" | "attachment";
export type Expression =
  | { field: string }
  | { literal: Json }
  | { op: "add" | "subtract" | "multiply" | "divide" | "eq" | "gt" | "lt" | "and" | "or" | "not" | "if" | "coalesce" | "concat"; args: Expression[] };
export type Binding =
  | { kind: "literal" }
  | { kind: "entity"; subject?: string; subjectField?: string; observationId?: string; path: string; retention: Retention }
  | { kind: "request"; sourceId: string; contractDigest: string; inputs: Record<string, { rowField: string } | { literal: Json }>; select: { stepId: string; jsonPointer: string }; refresh: { mode: "on-demand" | "on-open" | "scheduled"; maxAgeSeconds: number }; retention: Retention }
  | { kind: "lookup"; relation: string; field: string; aggregate: "first" | "list" | "count" | "sum" }
  | { kind: "formula"; expression: Expression };
export interface Column {
  id: string;
  name: string;
  type: FieldType;
  nullable?: boolean;
  required?: boolean;
  options?: string[];
  relation?: { tableId: string; cardinality: "one-to-one" | "many-to-one" | "many-to-many" };
  binding?: Binding;
  authority?: Authority;
}
export interface DatabaseDefinition {
  id: string;
  name: string;
  lifecycle: "temporary" | "internal" | "visible";
  expiresAt?: number;
}
export interface TableDefinition { id: string; databaseId: string; name: string; columns: Column[]; mode: "stored" | "domain" }
export interface RecordRevision<T> { id: string; revision: number; value: T; at: number; producer: string; deleted: boolean }
export interface RowData { values: Record<string, Json>; overrides?: Record<string, Json>; entity?: { subject: string; mappingId?: string } }
export interface Cell {
  state: "ready" | "missing" | "unavailable" | "error";
  freshness: "fresh" | "stale" | "unknown";
  value?: Json;
  valueVersion?: number;
  checkedAt?: number;
  observedAt?: number;
  source?: string;
  error?: string;
  overridden?: boolean;
  lineage?: string[];
  sourceGeneration?: string;
}
export type Filter =
  | { field: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains" | "in" | "is-null" | "is-missing"; value?: Json }
  | { op: "and" | "or"; filters: Filter[] };
export interface Query {
  tableId: string;
  select?: string[];
  filter?: Filter;
  sort?: { field: string; direction: "asc" | "desc" }[];
  joins?: { tableId: string; as: string; on: { local: string; foreign: string }; kind: "left" | "inner"; cardinality: "one" | "many" }[];
  groupBy?: string[];
  aggregates?: { as: string; field?: string; op: "count" | "sum" | "min" | "max" | "average" }[];
  limit?: number;
  cursor?: { revision: number; offset: number; domains?: Record<string, string> };
  maxRows?: number;
  maxBytes?: number;
}
export interface QueryRow { id: string; revision: number; cells: Record<string, Cell>; records?: Record<string, { tableId: string; rowId: string; revision: number }> }
/** Evidence needed to reauthorize retained results after the query's rows change. */
export interface QueryDependency {
  tableId: string;
  tableRevision: number;
  rowId?: string;
  rowRevision?: number;
  columnId?: string;
  source?: { kind: "request"; id: string; contractDigest: string; generation?: string } | { kind: "entity"; subject?: string; observationId?: string };
  retention?: Retention;
  lineage?: string[];
}
export interface QueryResult {
  rows: QueryRow[];
  columns: Column[];
  revision: number;
  coverage: "complete" | "partial";
  reasons: string[];
  scanned: number;
  matched: number;
  dependencies: QueryDependency[];
  nextCursor?: { revision: number; offset: number; domains?: Record<string, string> };
}
export interface ViewDefinition {
  id: string;
  title: string;
  query: Query;
  layout: "table" | "list" | "board" | "calendar" | "chart";
  groupField?: string;
  dateField?: string;
}
export interface ArtifactDefinition {
  schemaVersion: 1;
  kind: "database";
  artifactId: string;
  title: string;
  viewId: string;
  viewRevision: number;
  dataMode: "live" | "snapshot";
  presentation: { inline: "preview"; expanded: "mini-app" };
  renderer: { kind: "json-render"; catalogVersion: "aiko-db/v1" };
  /** Deterministic, inert catalog spec; data and mutations are supplied by the host client. */
  spec?: { root: "database"; elements: { database: { type: "DatabaseView"; props: { artifactId: string }; children?: [] } } };
  snapshot?: QueryResult;
}
export type Command =
  | { kind: "table.refresh"; tableId: string; rowIds?: string[]; columnIds?: string[]; mode?: "all" | "stale"; budget?: { maxRows?: number; maxCalls?: number; maxBytes?: number; timeoutMs?: number } }
  | { kind: "database.create"; database: DatabaseDefinition }
  | { kind: "table.define"; table: TableDefinition; expectedRevision: number }
  | { kind: "rows.upsert"; tableId: string; rows: { id: string; expectedRevision: number; values: Record<string, Json>; overrides?: Record<string, Json> }[] }
  | { kind: "rows.delete"; tableId: string; rows: { id: string; expectedRevision: number }[] }
  | { kind: "view.save"; view: ViewDefinition; expectedRevision: number }
  | { kind: "artifact.create"; artifactId: string; viewId: string; viewRevision: number; title: string; dataMode: "live" | "snapshot" };
export interface Receipt { operationId: string; revision: number; result: Json; at: number }
export class DataError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "missing" | "forbidden" | "limit" | "unavailable", message: string) { super(message); this.name = "DataError"; }
}
