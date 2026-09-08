import { z } from "zod";
import type { ArtifactDefinition, Command, DatabaseDefinition, Query, QueryResult, Receipt, RecordRevision, TableDefinition, ViewDefinition } from "@unlock/structured-data";
export type { ArtifactDefinition as DatabaseArtifact, Command as DatabaseCommand, Query as DatabaseQuery, QueryResult as DatabaseQueryResult, ViewDefinition as DatabaseView } from "@unlock/structured-data";

export interface DatabaseArtifactResult { artifact: ArtifactDefinition; view: ViewDefinition; result: QueryResult }
export interface DatabaseOperationResult {
  operationId: string;
  status: "queued" | "committed" | "cancelled" | "conflict" | "rejected" | "unavailable";
  receipt?: Receipt;
  code?: string;
}
export interface DatabaseCatalog {
  databases: RecordRevision<DatabaseDefinition>[];
  tables: (RecordRevision<TableDefinition> & { coverage?: string })[];
  views: RecordRevision<ViewDefinition>[];
  artifacts: { artifactId: string; title: string; revision: number; dataMode?: "live" | "snapshot" }[];
}
export interface DatabaseCommandInput { idempotencyKey: string; command: Command }
export interface DatabaseQueryInput { query: Query }

export const databaseArtifactReference = z.object({ artifactId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/) }).strict();
export const databaseReplyArtifact = databaseArtifactReference.extend({ kind: z.literal("database"), state: z.enum(["available", "unavailable"]) }).strict();
export type DatabaseArtifactReference = z.infer<typeof databaseArtifactReference>;
export type DatabaseReplyArtifact = z.infer<typeof databaseReplyArtifact>;
