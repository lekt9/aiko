import { Journal } from "./journal.js";
import type { MemoryStorage } from "./storage.js";
import { assertNoSecrets, canonical, clone, digest, fail, number, object, observationId, receipt, rememberInput, sourceCoverage, sourceInput, text, MAX_PAYLOAD_BYTES } from "./codec.js";
import { normalizeSource } from "./sources.js";
import { recall, hit, accessible } from "./recall.js";
import { MemoryError, type MemoryEvent, type Observation, type Producer, type RecallInput, type RecallResult,
  type RememberInput, type Source, type SourceInput, type SourceRunner, type SourceResult, type RefreshResult, type WriteOptions, type MemoryHit } from "./types.js";

export interface ScanInput { after?: string; limit?: number; type?: string; kind?: "fact" | "episode" | "skill" | "entity"; }
export interface ScanResult {
  items: MemoryHit[]; nextAfter: string | null; scanned: number; sourceVersion: number;
  coverage: "complete" | "partial"; reasons: string[];
}
export interface MemoryOptions {
  storage: MemoryStorage;
  /** Bound by the host, not supplied by the model on each call. */
  scope: string;
  clock?: () => number;
  adapters?: Readonly<Record<string, SourceRunner>>;
  /** Optional host capability. Worker hosts do not implicitly gain filesystem access. */
  files?: { canonicalPath(path: string): string; read(source: Source, maxBytes: number): Promise<SourceResult> };
}
export class Memory {
  readonly journal: Journal;
  readonly scope: string;
  private readonly clock: () => number;
  private readonly adapters: Readonly<Record<string, SourceRunner>>;
  private readonly files: MemoryOptions["files"];
  constructor(options: MemoryOptions) {
    this.scope = text(options.scope, "scope", 256);
    this.clock = options.clock ?? Date.now;
    this.adapters = Object.assign(Object.create(null), options.adapters ?? {});
    this.files = options.files;
    this.journal = new Journal(options.storage);
  }
  close(): void { this.journal.close(); }
  /** Operator-only migration, including suppressed history. Not a model-facing recall operation. */
  exportArchive() { return this.journal.exportArchive(this.scope); }
  importArchive(value: unknown) { return this.journal.importArchive(this.scope, value); }
  now(): number { return number(this.clock(), "clock", 0, 8640000000000000); }
  private base(key: string, fingerprint: string, operation: MemoryEvent["operation"], at: number): MemoryEvent {
    return { version: 1, scope: this.scope, key, requestDigest: fingerprint, recordedAt: at, operation, observations: [] };
  }
  private writeOptions(options: WriteOptions): WriteOptions {
    text(options.key, "key", 512);
    if (!options.producer || !["user", "agent", "tool", "file", "contract", "legacy"].includes(options.producer.kind)) fail("invalid_input", "A host-assigned producer is required");
    text(options.producer.reference, "producer.reference", 2048);
    assertNoSecrets(options.producer);
    return clone(options);
  }
  private observation(input: RememberInput, producer: Producer, at: number): Observation {
    const observedAt = input.observedAt ?? at;
    if (observedAt > at) fail("invalid_input", "Observation time cannot be in the future");
    const head = this.journal.head(this.scope, input.subject);
    if (head?.forgotten) fail("forgotten", "This subject is suppressed; refresh and replay cannot restore it");
    if (head?.id !== input.supersedes) fail("head_conflict", "Correction requires the exact current supersedes reference");
    const refs = [...new Set([...(input.supports ?? []), ...(input.dependsOn ?? [])])];
    for (const id of refs) {
      const parent = this.journal.observation(this.scope, id);
      if (!parent) return fail("evidence_unavailable", "Evidence is unavailable in this scope");
      // Only committed earlier observations may be referenced: no self/forward edges or cycles.
      if (parent.recordedAt > at) fail("invalid_input", "Evidence cannot come from the future");
    }
    const content: Omit<Observation, "id"> = {
      payloadDigest: digest("entity-learn.payload/v1", input.payload), scope: this.scope,
      subject: input.subject, title: input.title, type: input.type, kind: input.kind ?? "fact", payload: input.payload,
      producer, observedAt, recordedAt: at, expiresAt: input.ttlSeconds === undefined ? null : observedAt + input.ttlSeconds * 1000,
      validFrom: input.validFrom ?? null, validTo: input.validTo ?? null, supersedes: input.supersedes ?? null,
      supports: [...new Set(input.supports ?? [])], dependsOn: [...new Set(input.dependsOn ?? [])], links: input.links ?? [],
    };
    const observation = { id: observationId(content), ...content };
    if (!accessible(this, observation)) fail("evidence_unavailable", "Evidence is unavailable or its closure exceeds 256 observations");
    return observation;
  }
  remember(value: RememberInput, options: WriteOptions): Observation {
    const input = rememberInput(value); const opts = this.writeOptions(options);
    if (opts.producer.sourceId !== undefined) fail("invalid_input", "Source-bound observations must use refresh");
    const event = this.journal.commit(this.scope, opts.key, { operation: "remember", input, producer: opts.producer }, fingerprint => {
      const at = this.now();
      return { ...this.base(opts.key, fingerprint, "remember", at), observations: [this.observation(input, opts.producer, at)] };
    });
    // A replay acknowledges the prior write but cannot disclose forgotten payloads.
    const saved = event.observations[0]!;
    const admitted = this.get(saved.id);
    if (!admitted) return fail("forgotten", "The original write or its supporting evidence was subsequently forgotten");
    return admitted.observation;
  }
  forget(subject: string, expected: string, key: string): { subject: string; forgotten: true; erased: false } {
    text(subject, "subject"); receipt(expected); text(key, "key");
    this.journal.commit(this.scope, key, { operation: "forget", subject, expected }, fingerprint => {
      const head = this.journal.head(this.scope, subject);
      if (!head || head.id !== expected) fail("head_conflict", "Forget requires the exact current observation");
      return { ...this.base(key, fingerprint, "forget", this.now()), subject };
    });
    return { subject, forgotten: true, erased: false };
  }
  get(id: string): MemoryHit | null {
    receipt(id);
    return this.journal.read(() => {
      const observation = this.journal.observation(this.scope, id);
      return observation ? hit(this, observation, this.now(), undefined, "match") : null;
    });
  }
  history(subject: string, limit = 20): MemoryHit[] {
    text(subject, "subject"); number(limit, "limit", 1, 100);
    return this.journal.read(() => this.journal.history(this.scope, subject, limit)
      .flatMap(o => { const item = hit(this, o, this.now(), undefined, "match"); return item ? [item] : []; }));
  }
  recall(input: RecallInput = {}): RecallResult { return this.journal.read(() => recall(this, input)); }
  /** Bounded current-record keyset page. No execution, embeddings, or recency cutoff. */
  scan(input: ScanInput = {}): ScanResult {
    object(input, ["after", "limit", "type", "kind"]);
    const limit = number(input.limit ?? 16, "limit", 1, 128);
    if (input.after !== undefined) receipt(input.after);
    if (input.type !== undefined) text(input.type, "type", 80);
    if (input.kind !== undefined && !["fact", "episode", "skill", "entity"].includes(input.kind)) fail("invalid_input", "Unknown memory kind");
    return this.journal.read(() => {
      const rows = this.journal.page(this.scope, { ...input, limit: limit + 1 });
      const more = rows.length > limit; if (more) rows.pop();
      const reasons = new Set<string>([...(more ? ["page_limit"] : []), ...(input.after ? ["page_window"] : [])]);
      const now = this.now();
      const items = rows.flatMap(o => {
        const item = hit(this, o, now, undefined, "match");
        if (!item) { reasons.add("evidence_unavailable"); return []; }
        return item.state === "current" ? [item] : [];
      });
      return { items, nextAfter: more ? rows.at(-1)!.id : null, scanned: rows.length,
        sourceVersion: this.journal.scopeVersion(this.scope), coverage: reasons.size ? "partial" : "complete", reasons: [...reasons] };
    });
  }
  sources(): Source[] { return this.journal.sources(this.scope); }
  registerSource(value: SourceInput, key: string): Source {
    const input = sourceInput(value); text(key, "key");
    if (input.resolver === "file") {
      if (!this.files) fail("adapter_unavailable", "The host has not mounted file sources");
      input.locator = this.files!.canonicalPath(input.locator);
    }
    const revision = digest("entity-learn.source/v1", input);
    const event = this.journal.commit(this.scope, key, { operation: "register", input }, fingerprint => {
      const prior = this.journal.source(this.scope, input.id);
      const source: Source = prior?.revision === revision ? prior : { ...input, revision, enabled: false, lastSuccess: null, lastAttemptAt: null, error: null, failures: 0 };
      return { ...this.base(key, fingerprint, "source", this.now()), source };
    });
    return clone(event.source!);
  }
  approveSource(id: string, revision: string, enabled: boolean, key: string): Source {
    text(id, "source"); text(revision, "revision"); text(key, "key");
    if (typeof enabled !== "boolean") fail("invalid_input", "enabled must be boolean");
    return clone(this.journal.commit(this.scope, key, { operation: "approve", id, revision, enabled }, fingerprint => {
      const source = this.journal.source(this.scope, id);
      if (!source || source.revision !== revision) return fail("source_changed", "Approval must pin the current source revision");
      return { ...this.base(key, fingerprint, "source", this.now()), source: { ...source, enabled, failures: 0, error: null } };
    }).source!);
  }
  async refresh(id: string, options: { key: string; timeoutMs?: number; maxBytes?: number }): Promise<RefreshResult> {
    text(id, "source"); text(options.key, "key");
    const timeoutMs = number(options.timeoutMs ?? 10000, "timeoutMs", 1, 30000);
    const maxBytes = number(options.maxBytes ?? MAX_PAYLOAD_BYTES, "maxBytes", 1, MAX_PAYLOAD_BYTES);
    const source = this.journal.source(this.scope, id);
    if (!source) return fail("source_unavailable", "Source is not registered in this scope");
    const request = { operation: "refresh", id, revision: source.revision, timeoutMs, maxBytes };
    const fingerprint = digest("entity-learn.request/v1", request);
    const prior = this.journal.prior(this.scope, options.key, fingerprint);
    if (prior) return this.refreshResult(prior);
    if (!source.enabled) fail("source_disabled", "Source must be explicitly approved before refresh");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const runner = source.resolver === "file"
        ? this.files && (() => this.files!.read(source, maxBytes))
        : this.adapters[source.locator];
      if (!runner) fail("adapter_unavailable", "The host has not mounted this source adapter");
      const result = await Promise.race([
        Promise.resolve().then(() => runner!(clone(source), { signal: controller.signal, maxBytes })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MemoryError("timeout", "Source refresh deadline exceeded")); }, timeoutMs); }),
      ]);
      if (Buffer.byteLength(canonical(result.data)) > maxBytes) fail("too_large", "Source exceeded its response budget");
      assertNoSecrets(result.data);
      const inputs = normalizeSource(source, result.data);
      const coverage = sourceCoverage(result.coverage ?? { complete: true, reasons: [] });
      const event = this.journal.commit(this.scope, options.key, request, hash => {
        this.requireUnchangedSource(source);
        const at = this.now();
        const batch = `source:${source.id}:${digest("entity-learn.batch/v1", { request: hash, key: options.key })}`;
        const producer: Producer = { kind: source.resolver === "file" ? "file" : "tool", reference: batch,
          sourceId: source.id, sourceRevision: source.revision };
        // An adapter may supply an evidence citation, but not spoof the source identity/batch.
        if (result.producer) {
          this.writeOptions({ key: options.key, producer: result.producer });
          producer.kind = result.producer.kind;
          producer.evidenceReference = result.producer.reference;
        }
        const observations = inputs.filter(i => !this.journal.head(this.scope, i.subject)?.forgotten).map(i => {
          const head = this.journal.head(this.scope, i.subject);
          if (head) {
            const existing = this.journal.observation(this.scope, head.id)!;
            if (existing.producer.sourceId !== source.id) fail("identity_conflict", "Source namespace overlaps a different producer");
          }
          const input = { ...i, ...(result.links?.[i.subject] ? { links: result.links[i.subject] } : {}), ...(head ? { supersedes: head.id } : {}), ...(result.observedAt === undefined ? {} : { observedAt: result.observedAt }) };
          return this.observation(rememberInput(input), producer, at);
        });
        return { ...this.base(options.key, hash, "refresh", at), observations,
          source: { ...source, lastSuccess: batch, lastAttemptAt: at, error: null, failures: 0, coverage } };
      });
      return this.refreshResult(event);
    } catch (error) {
      const code = error instanceof MemoryError ? error.code : "source_failed";
      // Configuration/concurrent refresh changes do not poison the newer source's health.
      if (["source_changed", "idempotency_conflict"].includes(code)) throw error;
      const event = this.journal.commit(this.scope, options.key, request, hash => {
        this.requireUnchangedSource(source);
        const failures = source.failures + 1;
        return { ...this.base(options.key, hash, "failure", this.now()),
          source: { ...source, lastAttemptAt: this.now(), error: code, failures, enabled: failures < 3 } };
      });
      return this.refreshResult(event);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private refreshResult(event: MemoryEvent): RefreshResult {
    return { observations: event.observations.map(o => o.id), error: event.source?.error ?? null,
      coverage: event.operation === "failure" ? { complete: false, reasons: ["source_error"] }
        : event.source?.coverage ?? { complete: true, reasons: [] } };
  }
  private requireUnchangedSource(source: Source): void {
    const current = this.journal.source(this.scope, source.id);
    if (!current || !current.enabled || canonical(current) !== canonical(source))
      fail("source_changed", "Source changed while the refresh was running; retry with a new key");
  }
  rebuild(): ReturnType<Journal["rebuild"]> { return this.journal.rebuild(); }
}
