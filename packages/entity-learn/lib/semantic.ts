import { byteLength, canonical, digest, fail, number, object, receipt, text } from "./codec.js";
import type { Memory, ScanInput } from "./memory-core.js";
import { rank, tokenize } from "./recall.js";
import type { MemoryHit, Observation } from "./types.js";

/** Revision is a host-pinned provider/config identity, not a vendor authenticity claim. */
export interface EmbeddingSpace { model: string; revision: string; dimensions: number; }
export interface EmbeddingDocument { observation: string; digest: string; text: string; }
export interface SemanticInput {
  search: string; vector: readonly number[]; limit?: number; maxCandidates?: number;
  maxBytes?: number; maxCorpusBytes?: number; minSimilarity: number; includeStale?: boolean; type?: string; kind?: ScanInput["kind"];
}
export interface SemanticResult {
  items: { hit: MemoryHit; similarity: number | null; score: number; matchedBy: ("lexical" | "semantic")[] }[];
  coverage: "complete" | "partial"; reasons: string[]; corpus: "recorded-observations";
  scanned: number; indexed: number; bytes: number; sourceVersion: number;
}
export function checkedVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(n => typeof n !== "number" || !Number.isFinite(n)))
    return fail("invalid_embedding", "Embedding must contain the configured number of finite values");
  // Scaling first avoids overflow/underflow and rejects a directionless all-zero vector.
  const scale = Math.max(...value.map(Math.abs));
  if (!scale) return fail("invalid_embedding", "Embedding must have a nonzero norm");
  const scaled = value.map(n => n / scale); const norm = Math.sqrt(scaled.reduce((sum, n) => sum + n * n, 0));
  return scaled.map(n => n / norm);
}
export function embeddingText(o: Observation): string {
  return canonical({ subject: o.subject, title: o.title, type: o.type, kind: o.kind, payload: o.payload,
    observedAt: o.observedAt, validFrom: o.validFrom, validTo: o.validTo });
}

/** No provider, scheduler or source runner here. Prepare → host embeds → commit; reads only join recorded data. */
export class SemanticIndex {
  readonly space: Readonly<EmbeddingSpace>;
  private readonly namespace: string;
  constructor(readonly memory: Memory, space: EmbeddingSpace, readonly maxDocumentBytes = 4096) {
    object(space, ["model", "revision", "dimensions"]);
    text(space.model, "model", 256); text(space.revision, "revision", 256); number(space.dimensions, "dimensions", 1, 4096);
    number(maxDocumentBytes, "maxDocumentBytes", 128, 65536);
    this.space = Object.freeze({ ...space });
    this.namespace = `semantic:${digest("entity-learn.embedding-space/v1", { ...space, format: "observation-json/v1", maxDocumentBytes })}`;
  }
  private document(o: Observation): EmbeddingDocument {
    const content = embeddingText(o);
    return { observation: o.id, text: content, digest: digest("entity-learn.embedding-document/v1", content) };
  }
  private cached(doc: EmbeddingDocument): number[] | undefined {
    const value = this.memory.journal.derived(this.memory.scope, this.namespace, doc.observation);
    if (value === undefined) return undefined;
    const row = object(value, ["digest", "vector"]);
    if (row.digest !== doc.digest) return fail("corrupt_store", "Embedding content identity mismatch");
    return checkedVector(row.vector, this.space.dimensions);
  }
  prepare(input: ScanInput = {}, allow: (hit: MemoryHit) => boolean = () => true) {
    const page = this.memory.scan(input); const documents: EmbeddingDocument[] = []; const reasons = new Set(page.reasons);
    for (const item of page.items) {
      if (!allow(item)) { reasons.add("egress_policy"); continue; }
      const doc = this.document(item.observation);
      if (Buffer.byteLength(doc.text) > this.maxDocumentBytes) { reasons.add("document_too_large"); continue; }
      if (!this.cached(doc)) documents.push(doc);
    }
    return { documents, nextAfter: page.nextAfter, scanned: page.scanned, sourceVersion: page.sourceVersion,
      coverage: reasons.size ? "partial" as const : "complete" as const, reasons: [...reasons].sort() };
  }
  /** Rechecks heads/evidence after the host's asynchronous I/O. Never replaces a receipt or stale head. */
  commit(documents: readonly EmbeddingDocument[], vectors: readonly (readonly number[])[]) {
    number(documents.length, "batch", 1, 128);
    if (documents.length !== vectors.length || new Set(documents.map(d => d.observation)).size !== documents.length)
      fail("invalid_embedding", "Embedding batch identities must be unique and aligned");
    const normalized = vectors.map(v => checkedVector(v, this.space.dimensions));
    return this.memory.journal.derive(() => {
      const accepted: string[] = []; const rejected: string[] = [];
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i]!; receipt(doc.observation);
        const item = this.memory.get(doc.observation);
        if (!item || item.state !== "current") { rejected.push(doc.observation); continue; }
        const expected = this.document(item.observation);
        if (doc.digest !== expected.digest || doc.text !== expected.text || Buffer.byteLength(doc.text) > this.maxDocumentBytes)
          fail("invalid_embedding", "Embedding document changed or exceeds its bound");
        this.memory.journal.putDerived(this.memory.scope, this.namespace, doc.observation, { digest: doc.digest, vector: normalized[i] });
        accepted.push(doc.observation);
      }
      return { accepted, rejected };
    });
  }
  clear(): void { this.memory.journal.clearDerived(this.memory.scope, this.namespace); }
  /** Bounded corpus walk avoids recent-N blind spots; BM25 + cosine lists use reciprocal rank fusion.
   * Every returned item is rehydrated with scope, suppression, head, source and dependency checks.
   * No unconditional nearest-neighbor fallback: callers must explicitly select a similarity floor.
   */
  search(input: SemanticInput, allow: (hit: MemoryHit) => boolean = () => true): SemanticResult {
    object(input, ["search", "vector", "limit", "maxCandidates", "maxBytes", "maxCorpusBytes", "minSimilarity", "includeStale", "type", "kind"]);
    if (input.includeStale !== undefined && typeof input.includeStale !== "boolean") fail("invalid_input", "includeStale must be boolean");
    if (input.type !== undefined) text(input.type, "type", 80);
    text(input.search, "search", 4096);
    const query = checkedVector(input.vector, this.space.dimensions);
    if (!Number.isFinite(input.minSimilarity) || input.minSimilarity < -1 || input.minSimilarity > 1)
      fail("invalid_input", "An explicit similarity floor between -1 and 1 is required");
    const cap = number(input.maxCandidates ?? 10000, "maxCandidates", 1, 10000);
    const corpusCap = number(input.maxCorpusBytes ?? 4 * 1024 * 1024, "maxCorpusBytes", 1024, 16 * 1024 * 1024);
    const limit = number(input.limit ?? 10, "limit", 1, 50); const maxBytes = number(input.maxBytes ?? 12000, "maxBytes", 1024, 262144);
    return this.memory.journal.read(() => {
      const reasons = new Set<string>(); const hits = new Map<string, MemoryHit>();
      let scanned = 0; let after: string | undefined; let corpusBytes = 0; let full = false;
      do {
        const page = this.memory.scan({ ...(after ? { after } : {}), ...(input.type ? { type: input.type } : {}),
          ...(input.kind ? { kind: input.kind } : {}), limit: Math.min(128, cap - scanned) });
        scanned += page.scanned;
        for (const reason of page.reasons) if (reason !== "page_limit" && reason !== "page_window") reasons.add(reason);
        for (const item of page.items) {
          if (!allow(item)) { reasons.add("host_policy"); continue; }
          if (!input.includeStale && item.freshness === "stale") { reasons.add("stale_excluded"); continue; }
          corpusBytes += byteLength(item);
          if (corpusBytes > corpusCap) { full = true; reasons.add("corpus_byte_budget"); break; }
          hits.set(item.observation.id, item);
        }
        after = page.nextAfter ?? undefined;
      } while (after && scanned < cap && !full);
      if (after) reasons.add("candidate_budget");
      for (const source of this.memory.sources().filter(s => !input.type || s.type === input.type)) {
        if (!source.lastSuccess) reasons.add("unobserved_sources");
        if (source.error) reasons.add("source_errors");
        if (source.coverage && !source.coverage.complete) reasons.add("source_partial");
      }
      const semantic: { id: string; similarity: number }[] = []; let indexed = 0;
      for (const [id, item] of hits) {
        const vector = this.cached(this.document(item.observation));
        if (!vector) { reasons.add("missing_embeddings"); continue; }
        indexed++;
        const similarity = Math.max(-1, Math.min(1, query.reduce((sum, n, i) => sum + n * vector[i]!, 0)));
        if (similarity >= input.minSimilarity) semantic.push({ id, similarity });
      }
      semantic.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
      const fused = new Map<string, SemanticResult["items"][number]>();
      const add = (id: string, position: number, method: "lexical" | "semantic", similarity: number | null) => {
        const row = fused.get(id) ?? { hit: hits.get(id)!, score: 0, similarity, matchedBy: [] };
        row.score += 1 / (60 + position + 1); row.matchedBy.push(method);
        if (similarity !== null) row.similarity = similarity;
        fused.set(id, row);
      };
      const lexical = tokenize(input.search).length ? rank([...hits.values()].map(h => h.observation), input.search) : [];
      lexical.forEach((o, i) => add(o.id, i, "lexical", null));
      semantic.forEach((o, i) => add(o.id, i, "semantic", o.similarity));
      const exact = (row: SemanticResult["items"][number]) => Number(row.hit.observation.subject.toLowerCase() === input.search.toLowerCase());
      const ranked = [...fused.values()].sort((a, b) => exact(b) - exact(a) || b.score - a.score || a.hit.observation.id.localeCompare(b.hit.observation.id));
      if (ranked.length > limit) reasons.add("result_budget");
      const items: SemanticResult["items"] = []; let used = 512;
      for (const row of ranked.slice(0, limit)) {
        const size = byteLength(row) + 1;
        if (used + size > maxBytes) { reasons.add("byte_budget"); continue; }
        items.push(row); used += size;
      }
      const result: SemanticResult = { items, coverage: reasons.size ? "partial" : "complete", reasons: [...reasons].sort(),
        corpus: "recorded-observations", scanned, indexed, bytes: 0, sourceVersion: this.memory.journal.scopeVersion(this.memory.scope) };
      while (result.bytes !== byteLength(result)) result.bytes = byteLength(result);
      return result;
    });
  }
}
