export { Memory, type MemoryOptions } from "./memory.js";
export type { ScanInput, ScanResult } from "./memory-core.js";
export { memoryGraph } from "./graph.js";
export type { GraphInput, GraphNode, GraphEdge, MemoryGraph } from "./graph.js";
export { Knowledge, chunkKnowledgeText, KNOWLEDGE_PAGE, KNOWLEDGE_SOURCE } from "./knowledge.js";
export type { Citation, KnowledgeClaim, KnowledgePage, PageDraft } from "./knowledge.js";
export { renderKnowledgeHtml, KNOWLEDGE_CSP } from "./knowledge-html.js";
export { SemanticIndex, embeddingText, checkedVector } from "./semantic.js";
export type { EmbeddingSpace, EmbeddingDocument, SemanticInput, SemanticResult } from "./semantic.js";
export { openRouterEmbeddings, GEMINI_EMBEDDING_2 } from "./embeddings.js";
export type { EmbeddingProvider, EmbeddingAdmission, EmbeddingRequest, EmbeddingUsage } from "./embeddings.js";
export { nodeStorage } from "./storage-node.js";
export type { MemoryStorage } from "./storage.js";
export type { MemoryArchive } from "./journal.js";
export { rememberInput as validateRememberInput, sourceInput as validateSourceInput, safePayload as validatePayload,
  assertNoSecrets as validateNoSecrets } from "./codec.js";
export { MemoryError } from "./types.js";
export type { Json, RememberInput, Observation, Producer, Source, SourceInput, SourceRunner, SourceResult,
  RecallInput, RecallResult, MemoryHit, WriteOptions, MemoryKind } from "./types.js";
export { importContract, importLegacy } from "./imports.js";
export { contractEvidence } from "./sources.js";
// Framework-neutral log adapter: importing it does not load a version-specific Tardie package.
export { tardigradeLogSource } from "./tardigrade-logs.js";
export type { TardigradeLogOptions, TardigradeLogRow } from "./tardigrade-logs.js";
