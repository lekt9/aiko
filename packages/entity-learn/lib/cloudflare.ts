import type { MemoryStorage, SqlRow, SqlValue } from "./storage.js";

/** Structural subset of DurableObjectStorage; no dependency on ambient Worker types. */
export interface CloudflareMemoryStorage {
  sql: { exec(query: string, ...parameters: SqlValue[]): Iterable<SqlRow> };
  transactionSync<T>(run: () => T): T;
}

/** Native SQLite DO driver. Durable Object storage, transaction and lifetime remain host-owned. */
export function cloudflareStorage(storage: CloudflareMemoryStorage): MemoryStorage {
  return {
    exec: sql => { storage.sql.exec(sql); },
    prepare: sql => ({
      get: (...args) => storage.sql.exec(sql, ...args)[Symbol.iterator]().next().value,
      all: (...args) => Array.from(storage.sql.exec(sql, ...args)),
      run: (...args) => { storage.sql.exec(sql, ...args); },
      iterate: (...args) => storage.sql.exec(sql, ...args),
    }),
    transaction: run => storage.transactionSync(run),
    read: run => storage.transactionSync(run),
    close: () => {},
  };
}

export { Memory, type MemoryOptions, type ScanInput, type ScanResult } from "./memory-core.js";
export { memoryGraph } from "./graph.js";
export type { GraphInput, GraphNode, GraphEdge, MemoryGraph } from "./graph.js";
export { Knowledge, chunkKnowledgeText, KNOWLEDGE_PAGE, KNOWLEDGE_SOURCE } from "./knowledge.js";
export type { Citation, KnowledgeClaim, KnowledgePage, PageDraft } from "./knowledge.js";
export { renderKnowledgeHtml, KNOWLEDGE_CSP } from "./knowledge-html.js";
export { SemanticIndex, embeddingText, checkedVector } from "./semantic.js";
export type { EmbeddingSpace, EmbeddingDocument, SemanticInput, SemanticResult } from "./semantic.js";
export { openRouterEmbeddings, GEMINI_EMBEDDING_2 } from "./embeddings.js";
export type { EmbeddingProvider, EmbeddingAdmission, EmbeddingRequest, EmbeddingUsage } from "./embeddings.js";
export { MemoryError } from "./types.js";
export type { MemoryStorage } from "./storage.js";
export type { MemoryArchive } from "./journal.js";
export type { Json, RememberInput, Observation, Producer, Source, SourceInput, SourceRunner, SourceResult,
  RecallInput, RecallResult, MemoryHit, WriteOptions, MemoryKind } from "./types.js";
export { rememberInput as validateRememberInput, sourceInput as validateSourceInput, safePayload as validatePayload,
  assertNoSecrets as validateNoSecrets } from "./codec.js";
export { importContract, importLegacy } from "./imports.js";
export { contractEvidence } from "./sources.js";
export { tardigradeLogSource } from "./tardigrade-logs.js";
export type { TardigradeLogOptions, TardigradeLogRow } from "./tardigrade-logs.js";
