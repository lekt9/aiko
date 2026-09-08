import { z } from "zod";
import type { ArtifactDefinition, Cell, Column, Command, DatabaseDefinition, EntityMapping, Query, QueryResult, Receipt, RecordRevision, TableDefinition, ViewDefinition } from "@unlock/structured-data";
export type { ArtifactDefinition as DatabaseArtifact, Command as DatabaseCommand, Query as DatabaseQuery, ViewDefinition as DatabaseView } from "@unlock/structured-data";

/** Current host hints, never authorization tokens. Missing capabilities mean no mutation controls. */
export interface DatabaseQueryCapabilities {
  version: 1;
  write: boolean;
  query: boolean;
  saveView: boolean;
  createFields: string[];
  createRows: boolean;
  /** Bounded loaded-page source selection. Execution rechecks current authority. */
  refresh?: { tableId: string; rowIds: string[]; columnIds: string[] };
  records: Record<string, {
    editFields: string[];
    reviewMemoryFields: string[];
    actions: { kind: "approval.review"; recordId: string; label: string }[];
  }>;
}
export interface DatabaseQueryResult extends QueryResult { capabilities?: DatabaseQueryCapabilities }
export interface DatabaseArtifactResult { artifact: ArtifactDefinition; view: ViewDefinition; result: DatabaseQueryResult }
export type DatabaseMappingResult = RecordRevision<EntityMapping>;
export interface DatabaseFieldInput { tableId: string; rowId: string; columnId: string }
export interface DatabaseFieldResult {
  tableRevision: number; rowRevision: number; column: Column; cell: Cell;
  coverage: QueryResult["coverage"]; dependencies: QueryResult["dependencies"];
  memory?: {
    mappingId: string; mappingRevision: number; observationId: string;
    current: Cell;
    /** UI hint only; the native correction rechecks all authority and revisions. */
    canCorrect: boolean;
  };
}
export interface DatabaseOperationResult {
  operationId: string;
  status: "queued" | "committed" | "cancelled" | "conflict" | "rejected" | "unavailable";
  receipt?: Receipt;
  /** Recorded bridge progress; absent IDs do not prove that a memory write did not occur. */
  bridge?: { pending: boolean; evidenceId: string | null; observationId: string | null };
  code?: string;
}
export interface DatabaseCatalog {
  databases: RecordRevision<DatabaseDefinition>[];
  tables: (RecordRevision<TableDefinition> & { coverage?: string })[];
  views: RecordRevision<ViewDefinition>[];
  artifacts: { artifactId: string; title: string; revision: number; dataMode?: "live" | "snapshot"; tableId?: string }[];
  capabilities?: { version: 1; saveView: boolean };
}
export interface DatabaseCommandInput { idempotencyKey: string; command: Command }
export interface DatabaseQueryInput { query: Query }
export interface DatabaseSourceCatalog {
  items: { sourceId: string; contractDigest: string; stepIds: string[]; inputs: { name: string; type: string; required: boolean }[]; sessionRequired: boolean }[];
  coverage: "complete" | "partial";
  requiresAuthorization: true;
}

export const databaseArtifactReference = z.object({ artifactId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/) }).strict();
export const databaseReplyArtifact = databaseArtifactReference.extend({ kind: z.literal("database"), state: z.enum(["available", "unavailable"]) }).strict();
export type DatabaseArtifactReference = z.infer<typeof databaseArtifactReference>;
export type DatabaseReplyArtifact = z.infer<typeof databaseReplyArtifact>;
