import { canonical, clone, fail, number, object, receipt, safePayload, text } from "./codec.js";
import type { Memory, ScanInput } from "./memory-core.js";
import type { Json, MemoryHit, Observation, WriteOptions } from "./types.js";

export const KNOWLEDGE_PAGE = "knowledge-page";
export const KNOWLEDGE_SOURCE = "knowledge-source";
export interface Citation { observation: string; path: (string | number)[]; quote: string; }
export interface KnowledgeClaim {
  text: string;
  /** A label supplied by the compiler, not proof of entailment. Inferences remain useful but qualified. */
  basis: "stated" | "inferred";
  citations: Citation[];
}
export interface PageDraft { subject: string; title: string; claims: KnowledgeClaim[]; supersedes?: string; }
export interface KnowledgePage {
  hit: MemoryHit;
  claims: KnowledgeClaim[];
  citations: { citation: Citation; subject: string; title: string; observedAt: number; recordedAt: number;
    producer: Observation["producer"]; freshness: MemoryHit["freshness"]; state: MemoryHit["state"] }[];
  verification: "quote-presence-only";
}
function prose(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    return fail("invalid_input", `Invalid ${field}`);
  return value;
}
function claims(value: unknown): KnowledgeClaim[] {
  if (!Array.isArray(value) || !value.length || value.length > 24) return fail("invalid_input", "A page requires 1–24 cited claims");
  return value.map(raw => {
    const row = object(raw, ["text", "basis", "citations"]);
    prose(row.text, "claim text", 2048);
    if (!["stated", "inferred"].includes(String(row.basis))) fail("invalid_input", "A claim requires an explicit basis label");
    if (!Array.isArray(row.citations) || !row.citations.length || row.citations.length > 8) fail("invalid_input", "Every claim requires 1–8 citations");
    for (const rawCitation of row.citations as unknown[]) {
      const cite = object(rawCitation, ["observation", "path", "quote"]); receipt(cite.observation);
      prose(cite.quote, "quotation", 2048);
      if (!Array.isArray(cite.path) || cite.path.length > 16) fail("invalid_input", "Citation path must be a bounded JSON path");
      for (const part of cite.path as unknown[]) {
        if (typeof part === "number") number(part, "path index", 0, 100000);
        else text(part, "path field", 128);
      }
    }
    return clone(raw) as KnowledgeClaim;
  });
}

/** Exact, lossless UTF-8-bounded source chunks. Caller owns admission, scheduling and per-chunk write keys. */
export function chunkKnowledgeText(value: string, maxBytes = 3000): string[] {
  number(maxBytes, "maxBytes", 4, 16000);
  if (typeof value !== "string" || Buffer.byteLength(value) > 4 * 1024 * 1024) fail("too_large", "Explicit source chunking is bounded at 4 MiB");
  const chunks: string[] = []; let chunk = ""; let bytes = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point);
    if (bytes + size > maxBytes) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += point; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** A compiled wiki is ordinary versioned memory, not a second database or an implicit model loop. */
export class Knowledge {
  constructor(readonly memory: Memory) {}
  source(input: { subject: string; title: string; text: string; reference: string; supersedes?: string; observedAt?: number }, options: WriteOptions): Observation {
    object(input, ["subject", "title", "text", "reference", "supersedes", "observedAt"]);
    prose(input.text, "source text", 16000); text(input.reference, "reference", 2048);
    return this.memory.remember({ subject: input.subject, title: input.title, type: KNOWLEDGE_SOURCE, kind: "episode",
      payload: { schema: "entity-learn.knowledge-source/v1", text: input.text, reference: input.reference },
      ...(input.supersedes ? { supersedes: input.supersedes } : {}), ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }) }, options);
  }
  private citation(cite: Citation) {
    const source = this.memory.get(cite.observation);
    if (!source) return fail("evidence_unavailable", "Cited evidence is unavailable in this scope");
    let value: Json = source.observation.payload;
    for (const part of cite.path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return fail("invalid_citation", "Citation path does not exist");
      value = (value as Record<string | number, Json>)[part]!;
    }
    if (typeof value !== "string" || !value.includes(cite.quote)) fail("invalid_citation", "Quotation must occur verbatim at the cited payload path");
    return { citation: cite, subject: source.observation.subject, title: source.observation.title,
      observedAt: source.observation.observedAt, recordedAt: source.observation.recordedAt,
      producer: source.observation.producer, freshness: source.freshness, state: source.state };
  }
  publish(input: PageDraft, options: WriteOptions): Observation {
    object(input, ["subject", "title", "claims", "supersedes"]);
    const checked = claims(input.claims);
    // Reading never runs a source. Memory.remember rechecks the transitive evidence closure on commit.
    this.memory.journal.read(() => { for (const claim of checked) for (const cite of claim.citations) this.citation(cite); });
    const refs = [...new Set(checked.flatMap(c => c.citations.map(cite => cite.observation)))].sort();
    if (refs.length > 16) fail("too_large", "A page may depend on at most 16 observations");
    return this.memory.remember({ subject: input.subject, title: input.title, type: KNOWLEDGE_PAGE, kind: "fact",
      payload: safePayload({ schema: "entity-learn.knowledge-page/v1", claims: checked }),
      supports: refs, dependsOn: refs, ...(input.supersedes ? { supersedes: input.supersedes } : {}) }, options);
  }
  get(id: string): KnowledgePage | null {
    return this.memory.journal.read(() => {
      const item = this.memory.get(id);
      if (!item || item.observation.type !== KNOWLEDGE_PAGE) return null;
      const payload = object(item.observation.payload, ["schema", "claims"]);
      if (payload.schema !== "entity-learn.knowledge-page/v1") fail("invalid_page", "Unknown compiled page schema");
      const checked = claims(payload.claims); const refs = [...new Set(checked.flatMap(c => c.citations.map(cite => cite.observation)))].sort();
      if (canonical(refs) !== canonical([...item.observation.supports].sort()) || canonical(refs) !== canonical([...item.observation.dependsOn].sort()))
        fail("invalid_page", "Compiled page must pin every citation as evidence and a current-input dependency");
      return { hit: item, claims: checked, citations: checked.flatMap(c => c.citations.map(cite => this.citation(cite))), verification: "quote-presence-only" };
    });
  }
  list(input: Omit<ScanInput, "type" | "kind"> = {}) {
    return this.memory.scan({ ...input, type: KNOWLEDGE_PAGE, kind: "fact" });
  }
  /** Structural/staleness audit only. Pagination must finish before claiming corpus-wide coverage. */
  lint(input: Omit<ScanInput, "type" | "kind"> = {}) {
    return this.memory.journal.read(() => {
      const page = this.list(input);
      const issues: { observation: string; code: string }[] = [];
      for (const item of page.items) {
        try {
          const view = this.get(item.observation.id)!;
          if (view.hit.freshness === "stale") issues.push({ observation: item.observation.id, code: "stale_inputs" });
          if (view.claims.some(c => c.basis === "inferred")) issues.push({ observation: item.observation.id, code: "inference_requires_review" });
        } catch { issues.push({ observation: item.observation.id, code: "invalid_page" }); }
      }
      return { issues, nextAfter: page.nextAfter, scanned: page.scanned, coverage: page.coverage, reasons: page.reasons,
        sourceVersion: page.sourceVersion, semanticTruthChecked: false as const };
    });
  }
}
