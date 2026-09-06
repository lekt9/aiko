import {
  MemoryError, validateNoSecrets, validateRememberInput,
  type Memory, type MemoryHit, type RememberInput, type WriteOptions,
} from "entity-learn/cloudflare";

/** Host service, not a second store. Pass the same openMemory(binding) handle used by
 * native memory tools. The host owns authorization, handle lifetime and write keys.
 * Append contextBundle to the existing request-memory automatic context; do not
 * replace that path or persist hydrated browser responses in this projection.
 */
export interface WikiMemoryBinding {
  owner: string;
  memory: Memory;
  /** Host credential redactor, identical to the native memory binding's redactor. */
  redact(text: string): string;
  /** Optional host consent policy. Never derive consent from a learned payload.
   * Private examples remain visible in owner views but are excluded from bundles
   * unless this callback approves the exact observation on each request. */
  styleExampleConsent?(observationId: string): boolean;
}
export interface WikiBudget { limit?: number; maxBytes?: number }
export type WikiSourceLabel = "available" | "stale" | "missing";
export interface WikiCitation {
  relation: "supports" | "depends_on" | "producer";
  id: string;
  label: WikiSourceLabel;
  subject?: string;
  sourceId?: string;
  sourceRevision?: string;
  evidenceReference?: string;
}
export interface WikiPage {
  /** Exact entity-learn observation ID is the revision and citation identity. */
  revision: string;
  subject: string;
  hit: MemoryHit;
  sources: WikiCitation[];
  privateStyleExample: boolean;
}
export interface WikiView<T> {
  items: T[];
  coverage: "complete" | "partial";
  corpus: "recorded-observations";
  reasons: string[];
  bytes: number;
}
export interface WikiBundle extends WikiView<WikiPage> {
  owner: string;
  trust: "untrusted-recorded-evidence";
  missing: { id: string; label: "missing" }[];
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function text(value: unknown, name: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new MemoryError("invalid_input", `Invalid ${name}`);
  return value;
}
function integer(value: number | undefined, fallback: number, min: number, max: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new MemoryError("invalid_input", "Invalid wiki budget");
  return n;
}
function budget(input: WikiBudget) {
  return { limit: integer(input.limit, 10, 1, 100), maxBytes: integer(input.maxBytes, 12000, 512, 262144) };
}
function bound<T, V extends WikiView<T>>(view: V, maxBytes: number): V {
  const size = () => { let old: number; do { old = view.bytes; view.bytes = bytes(view); } while (view.bytes !== old); };
  size();
  while (view.bytes > maxBytes && view.items.length) {
    view.items.pop();
    view.coverage = "partial";
    if (!view.reasons.includes("byte_budget")) view.reasons.push("byte_budget");
    size();
  }
  if (view.bytes > maxBytes) throw new MemoryError("too_large", "Wiki metadata exceeds byte budget");
  return view;
}
function view<T>(items: T[], reasons: string[] = []): WikiView<T> {
  return { items, coverage: reasons.length ? "partial" : "complete", corpus: "recorded-observations", reasons: [...new Set(reasons)], bytes: 0 };
}

export class WikiMemory {
  private readonly binding: WikiMemoryBinding;
  constructor(binding: WikiMemoryBinding) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(binding.owner) || binding.memory.scope !== `aiko:${binding.owner}`)
      throw new MemoryError("forbidden", "Incorrect wiki memory owner scope");
    this.binding = { ...binding };
  }
  private get memory() { return this.binding.memory; }
  private safe(value: unknown) {
    const encoded = JSON.stringify(value);
    if (bytes(value) > 262144) throw new MemoryError("too_large", "Wiki input exceeds budget");
    validateNoSecrets(value);
    if (this.binding.redact(encoded) !== encoded) throw new MemoryError("sensitive_material", "Credentials must not enter wiki memory");
  }
  private pageOf(hit: MemoryHit): WikiPage {
    const o = hit.observation;
    const sources: WikiCitation[] = [];
    for (const [ids, relation] of [[o.supports, "supports"], [o.dependsOn, "depends_on"]] as const) {
      for (const id of ids) {
        const ref = this.memory.get(id);
        sources.push({ relation, id, label: !ref ? "missing" : ref.freshness === "stale" || ref.state !== "current" ? "stale" : "available", ...(ref ? { subject: ref.observation.subject } : {}) });
      }
    }
    const p = o.producer;
    if (p.sourceId) {
      const source = this.memory.sources().find(s => s.id === p.sourceId);
      sources.push({ relation: "producer", id: p.reference, sourceId: p.sourceId,
        sourceRevision: p.sourceRevision, evidenceReference: p.evidenceReference,
        label: !source ? "missing" : !source.enabled || !!source.error || source.revision !== p.sourceRevision || source.lastSuccess !== p.reference || hit.freshness === "stale" ? "stale" : "available" });
    } else {
      // A producer reference alone is a claim citation, not a verified source read.
      sources.push({ relation: "producer", id: p.reference, label: "missing" });
    }
    return { revision: o.id, subject: o.subject, hit, sources, privateStyleExample: o.type === "style-example" };
  }
  /** Current subject page; pinned revisions use read(). */
  page(subject: string, options: WikiBudget = {}) {
    text(subject, "subject");
    const b = budget(options);
    const result = this.memory.recall({ subject, limit: 1, maxBytes: b.maxBytes, maxCandidates: 1, maxNodes: 1, depth: 0 });
    return bound(view(result.items.map(h => this.pageOf(h)), [...result.reasons,
      ...(result.items.length ? [] : ["missing_or_suppressed"])]), b.maxBytes);
  }
  read(revision: string, options: WikiBudget = {}) {
    const b = budget(options);
    const hit = this.memory.get(text(revision, "revision"));
    return bound(view(hit ? [this.pageOf(hit)] : [], hit ? [] : ["missing_or_suppressed"]), b.maxBytes);
  }
  search(query: string, options: WikiBudget = {}) {
    text(query, "query", 2000); this.safe(query);
    const b = budget(options);
    const result = this.memory.recall({ search: query, ...b, maxCandidates: 2000, maxNodes: b.limit, depth: 0 });
    return bound(view(result.items.map(h => this.pageOf(h)), result.reasons), b.maxBytes);
  }
  revisions(subject: string, options: WikiBudget = {}) {
    const b = budget(options);
    const hits = this.memory.history(text(subject, "subject"), Math.min(100, b.limit + 1));
    // Native history has no cursor/count API. At its hard cap completeness is unknown.
    const reasons = hits.length > b.limit || hits.length === 100 ? ["revision_budget"] : [];
    return bound(view(hits.slice(0, b.limit).map(h => this.pageOf(h)), reasons), b.maxBytes);
  }
  backlinks(subject: string, options: WikiBudget = {}) {
    text(subject, "subject"); const b = budget(options);
    // Native recall is the sole navigation layer. No hidden SQL or shadow index.
    const scan = this.memory.recall({ limit: 100, maxCandidates: 2000, maxNodes: 100, maxBytes: 262144, depth: 0 });
    const items = scan.items.filter(({ observation: o }) => o.links.some(l => l.subject === subject) ||
      [...o.supports, ...o.dependsOn].some(id => this.memory.get(id)?.observation.subject === subject));
    const reasons = [...scan.reasons, ...(items.length > b.limit ? ["result_budget"] : [])];
    return bound(view(items.slice(0, b.limit).map(h => this.pageOf(h)), reasons), b.maxBytes);
  }
  sources(options: WikiBudget = {}) {
    const b = budget(options);
    const sources = this.memory.sources();
    // Adapter locators are host configuration, not model context.
    const items = sources.slice(0, b.limit).map(s => ({ id: s.id, revision: s.revision, namespace: s.namespace,
      type: s.type, enabled: s.enabled, lastAttemptAt: s.lastAttemptAt, error: s.error,
      label: (!s.lastSuccess ? "missing" : !s.enabled || s.error || s.lastAttemptAt === null || this.memory.now() >= s.lastAttemptAt + s.ttlSeconds * 1000 ? "stale" : "available") as WikiSourceLabel }));
    return bound(view(items, sources.length > b.limit ? ["source_budget"] : []), b.maxBytes);
  }
  /** Explicit query and/or pinned IDs; never an unscoped dump or provider call.
   * Sources are native observation/source citations, not executable URLs.
   * Missing includes suppressed evidence without revealing why it is unavailable. */
  contextBundle(input: WikiBudget & { query?: string; revisions?: string[] }): WikiBundle {
    const b = budget(input);
    if (!input.query && !input.revisions?.length) throw new MemoryError("invalid_input", "Bundle requires a query or pinned revisions");
    if (input.revisions !== undefined && (!Array.isArray(input.revisions) || input.revisions.length > 16)) throw new MemoryError("invalid_input", "Too many pinned revisions");
    const hits = new Map<string, MemoryHit>();
    const missing: WikiBundle["missing"] = [];
    const reasons: string[] = [];
    for (const id of new Set(input.revisions ?? [])) {
      const hit = this.memory.get(text(id, "revision"));
      if (hit) hits.set(id, hit); else missing.push({ id, label: "missing" });
    }
    if (input.query !== undefined) {
      text(input.query, "query", 2000); this.safe(input.query);
      const result = this.memory.recall({ search: input.query, ...b, maxCandidates: 2000, maxNodes: Math.min(100, b.limit * 3), depth: 1 });
      reasons.push(...result.reasons);
      for (const hit of result.items) hits.set(hit.observation.id, hit);
    }
    if (missing.length) reasons.push("missing_sources");
    const pages = [...hits.values()].filter(hit => {
      if (hit.observation.type !== "style-example") return true;
      if (this.binding.styleExampleConsent?.(hit.observation.id) === true) return true;
      reasons.push("style_consent_required"); return false;
    }).map(h => this.pageOf(h));
    if (pages.length > b.limit) reasons.push("result_budget");
    const result: WikiBundle = { ...view(pages.slice(0, b.limit), reasons), owner: this.binding.owner, trust: "untrusted-recorded-evidence", missing };
    // Missing labels also consume the total envelope budget.
    while (bytes(result) > b.maxBytes && result.missing.length) {
      result.missing.pop(); result.coverage = "partial";
      if (!result.reasons.includes("byte_budget")) result.reasons.push("byte_budget");
    }
    return bound(result, b.maxBytes);
  }
  /** options are host-assigned, never forward a model-supplied producer/key. */
  edit(input: RememberInput, options: WriteOptions) {
    this.safe(input); this.safe(options);
    const validated = validateRememberInput(input);
    return this.pageOf(this.memory.get(this.memory.remember(validated, options).id)!);
  }
  supersede(revision: string, replacement: Omit<RememberInput, "subject" | "supersedes">, options: WriteOptions) {
    const hit = this.memory.get(text(revision, "revision"));
    if (!hit) throw new MemoryError("evidence_unavailable", "Revision unavailable");
    return this.edit({ ...replacement, subject: hit.observation.subject, supersedes: revision }, options);
  }
  forget(subject: string, expectedRevision: string, key: string) {
    this.safe({ subject, expectedRevision, key });
    return this.memory.forget(text(subject, "subject"), text(expectedRevision, "revision"), text(key, "key"));
  }
}
