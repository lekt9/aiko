import type { MemoryStorage } from "./storage.js";
import { canonical, digest, fail, observationId, sourceInput, object, text, number, MAX_EVENT_BYTES } from "./codec.js";
import type { MemoryEvent, Observation, Source, StoredEvent } from "./types.js";

const SUBJECT_ERASURE_PREFIX = "entity-learn:subject-erasure:";
const subjectErasureKey = (scope: string, key: string) => `${SUBJECT_ERASURE_PREFIX}${digest("entity-learn.erasure-operation/v1", { scope, key })}`;
const erasedReadKey = (scope: string, key: string) => `erased-read:${digest("entity-learn.erased-read/v1", { scope, key })}`;
const subjectFence = (scope: string, subject: string) => digest("entity-learn.erased-subject/v1", { scope, subject });
const ERASURE_KEY = "entity-learn:scope-erasure/v1";
const ZERO = "0".repeat(64);
type Row = Record<string, unknown>;
type StoredObservation = Omit<Observation, "payload">;
type StoredMemoryEvent = Omit<MemoryEvent, "observations"> & { observations: StoredObservation[] };
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ROWS = 16384;
type JournalRow = { seq: number; scope: string; request_key: string; request_digest: string; previous: string; digest: string; body: string };
/** Host-only, complete single-scope transfer. Includes retained/forgotten data; never expose as a model tool. */
export interface MemoryArchive {
  format: "entity-learn.sqlite/v1";
  scope: string;
  root: string;
  journal: JournalRow[];
  artifacts: { digest: string; body: string }[];
}
/** Host-retained checkpoint, obtained from a verified native journal, never from the candidate archive. */
export interface ErasureFence { version: 1; scope: string; seq: number; digest: string }
export interface SubjectErasureInput { subject: string; expectedHead: string; expectedScopeVersion: number; key: string }
export interface PreparedSubjectErasure { scope: string; key: string; receiptKey: string; requestDigest: string; request: { operation: "erase-subject"; subject: string; expectedHead: string; expectedScopeVersion: number } }
export interface ArchiveErasureCheck { scope: string; fence: ErasureFence; journalRows: number; artifacts: number; chainVerified: false }
export interface ErasureCommit { fence: ErasureFence; operation: "erase" | "erase-subject"; receipt: { key: string; seq: number; digest: string; requestDigest: string; scopeVersion: number } }
export type OnErasure = (commit: ErasureCommit) => void;
export type RestoreAuthority = (scope: string) => ErasureFence | null | undefined;
/** Atomic journal + content-addressed artifacts, with disposable read projections. */
export class Journal {
  constructor(private readonly db: MemoryStorage, private readonly restoreAuthority?: RestoreAuthority, private readonly onErasure?: OnErasure) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        seq INTEGER PRIMARY KEY, scope TEXT NOT NULL, request_key TEXT NOT NULL,
        request_digest TEXT NOT NULL, previous TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL,
        UNIQUE(scope, request_key));
      CREATE INDEX IF NOT EXISTS journal_scope_seq ON journal(scope, seq);
      CREATE TABLE IF NOT EXISTS artifacts (digest TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, subject TEXT NOT NULL, type TEXT NOT NULL,
        kind TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observation_scope ON observations(scope, seq);
      CREATE INDEX IF NOT EXISTS observation_subject ON observations(scope, subject, seq);
      CREATE TABLE IF NOT EXISTS heads (
        scope TEXT NOT NULL, subject TEXT NOT NULL, observation TEXT NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(scope, subject));
      CREATE TABLE IF NOT EXISTS sources (scope TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,id));`);
  }
  close(): void { this.db.close(); }
  scopeVersion(scope: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE scope=?").get(scope) as Row).n);
  }
  private depth = 0;
  private inside<T>(fn: () => T): T { this.depth++; try { return fn(); } finally { this.depth--; } }
  private transaction<T>(fn: () => T): T {
    if (this.depth) return fail("nested_write", "A read snapshot cannot be escalated to a write");
    return this.db.transaction(() => this.inside(fn));
  }
  /** One consistent snapshot; nested reads share it, including heads and suppression checks. */
  read<T>(fn: () => T): T {
    return this.depth ? fn() : this.db.read(() => this.inside(fn));
  }
  /** Host-only atomic projection updates. Does not create evidence or advance the journal. */
  derive<T>(fn: () => T): T { return this.transaction(fn); }
  private retired(scope: string): boolean {
    return !!this.db.prepare("SELECT 1 AS found FROM journal WHERE scope=? AND request_key=?").get(scope, ERASURE_KEY);
  }
  private erasedRead(scope: string, key: string): boolean {
    return key.startsWith("erased-read:") || !!this.db.prepare("SELECT 1 AS found FROM journal WHERE scope=? AND request_key=?")
      .get(scope, erasedReadKey(scope, key));
  }
  isErasedSubject(scope: string, subject: string): boolean {
    const fence = subjectFence(scope, subject);
    return this.db.prepare("SELECT body FROM journal WHERE scope=? AND request_key LIKE ?")
      .all(scope, `${SUBJECT_ERASURE_PREFIX}%`).some(row =>
        (JSON.parse(String(row.body)) as StoredMemoryEvent).erasure?.subjects?.includes(fence));
  }
  prior(scope: string, key: string, fingerprint: string): MemoryEvent | undefined {
    if (key !== ERASURE_KEY && this.retired(scope)) fail("erased", "Memory scope has been permanently erased");
    if (this.erasedRead(scope, key)) fail("erased", "Original memory operation contains erased evidence");
    const row = this.db.prepare("SELECT request_digest, body FROM journal WHERE scope=? AND request_key=?").get(scope, key) as Row | undefined;
    if (!row) return undefined;
    if (row.request_digest !== fingerprint) return fail("idempotency_conflict", "This request key was already used with different input");
    return this.hydrate(JSON.parse(String(row.body)) as StoredMemoryEvent);
  }
  /** Exact retained commit plus its original scope ordinal. The key lookup uses
   * UNIQUE(scope, request_key); ordinal counting scans the covering (scope, seq)
   * index through this commit, not O(1). Only this event's artifacts are hydrated.
   * Verifies this stored row, not the preceding chain. Like prior(), this is
   * a host journal API, not an authorization boundary. */
  receipt(scope: string, key: string): (StoredEvent & { scopeVersion: number }) | undefined {
    return this.read(() => {
      if (key !== ERASURE_KEY && this.retired(scope)) fail("erased", "Memory scope has been permanently erased");
    if (this.erasedRead(scope, key)) fail("erased", "Original memory operation contains erased evidence");
      const row = this.db.prepare("SELECT * FROM journal WHERE scope=? AND request_key=?").get(scope, key) as Row | undefined;
      if (!row) return undefined;
      const scopeVersion = Number(this.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE scope=? AND seq<=?").get(scope, Number(row.seq))!.n);
      const seq = Number(row.seq), previous = String(row.previous), savedDigest = String(row.digest);
      if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(scopeVersion) ||
          scopeVersion < 1 || scopeVersion > seq || !/^[a-f0-9]{64}$/.test(previous))
        return fail("corrupt_store", "Journal receipt position mismatch");
      let stored: StoredMemoryEvent;
      try { stored = JSON.parse(String(row.body)) as StoredMemoryEvent; }
      catch { return fail("corrupt_store", "Journal receipt body is invalid"); }
      const original = digest("entity-learn.journal/v1", { seq, previous, event: stored }) === savedDigest;
      const proof = original ? undefined : this.replacementProofs().get(seq);
      const replaced = proof?.scope === scope && proof.digest === savedDigest && proof.replacement === digest("entity-learn.erasure-body/v1", stored);
      if (canonical(stored) !== row.body ||
          (!replaced && !original))
        return fail("corrupt_store", "Journal receipt digest mismatch");
      const event = this.hydrate(stored);
      if (event.scope !== scope || event.key !== key || event.requestDigest !== row.request_digest)
        return fail("corrupt_store", "Journal receipt identity mismatch");
      return { seq, previous, digest: savedDigest, event, scopeVersion };
    });
  }
  /** Host-authorized whole-scope erasure. Permanently retires this scope. Live
   * SQLite contents only: old exports, WAL, backups and external logs are not erased. */
  eraseScope(scope: string, expectedVersion: number, key: string, at: number): { scope: string; erased: true; retired: true } {
    text(scope, "scope", 256); text(key, "key"); number(expectedVersion, "expectedVersion", 0, Number.MAX_SAFE_INTEGER);
    if (this.retired(scope)) this.receipt(scope, ERASURE_KEY);
    const request = { operation: "erase", expectedVersion, key };
    this.commit(scope, ERASURE_KEY, request, requestDigest => {
      if (this.scopeVersion(scope) !== expectedVersion) fail("scope_conflict", "Erasure requires the exact current scope version");
      this.verifyJournal(false);
      const rows = this.db.prepare("SELECT * FROM journal WHERE scope=? ORDER BY seq").all(scope) as JournalRow[];
      if (rows.length > 4096) fail("too_large", "Scope erasure exceeds 4096 journal rows");
      const replacements = rows.map(row => {
        const tombstone: MemoryEvent = { version: 1, scope, key: `erased:${row.seq}`,
          requestDigest: digest("entity-learn.erased/v1", { seq: row.seq, digest: row.digest }),
          recordedAt: 0, operation: "erased", observations: [] };
        const body = canonical(tombstone);
        this.db.prepare("UPDATE journal SET request_key=?,request_digest=?,body=? WHERE seq=? AND scope=?")
          .run(tombstone.key, tombstone.requestDigest, body, row.seq, scope);
        return { seq: row.seq, digest: row.digest, replacement: digest("entity-learn.erasure-body/v1", tombstone) };
      });
      for (const table of ["observations", "heads", "sources"])
        this.db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scope);
      if (this.hasDerived()) this.db.prepare("DELETE FROM derived WHERE scope=?").run(scope);
      // Global content deduplication: retain bytes still referenced by another scope.
      this.db.exec(`DELETE FROM artifacts WHERE digest NOT IN
        (SELECT json_extract(o.value, '$.payloadDigest') FROM journal j, json_each(j.body, '$.observations') o)`);
      return { version: 1, scope, key: ERASURE_KEY, requestDigest, recordedAt: at,
        operation: "erase", observations: [], erasure: { rows: replacements } };
    });
    return { scope, erased: true, retired: true };
  }
  /** Original caller key, not the transformed journal key. Verifies retained history
   * before reporting absence; a retired scope no longer retains these receipts. */
  subjectErasureReceipt(scope: string, key: string): (StoredEvent & { scopeVersion: number }) | undefined {
    text(scope, "scope", 256); text(key, "key");
    return this.read(() => {
      this.verifyJournal(false);
      if (this.restoreAuthority) {
        const authority = this.restoreAuthority(scope), current = this.erasureFence(scope);
        if (!authority || authority.version !== 1 || authority.scope !== scope || authority.seq !== current.seq || authority.digest !== current.digest)
          fail("corrupt_store", "Subject receipt history conflicts with restore authority");
      }
      if (this.retired(scope)) fail("erased", "Subject receipt unavailable after scope retirement");
      const receipt = this.receipt(scope, subjectErasureKey(scope, key));
      if (receipt && (receipt.event.operation !== "erase-subject" || !receipt.event.erasure?.subjects ||
          !receipt.event.erasure.observationIds || !Array.isArray(receipt.event.erasure.rows)))
        fail("corrupt_store", "Invalid subject erasure receipt");
      return receipt;
    });
  }
  private subjectErasureIdentity(scope: string, input: SubjectErasureInput): PreparedSubjectErasure {
    text(scope, "scope", 256);
    object(input, ["subject", "expectedHead", "expectedScopeVersion", "key"]);
    text(input.subject, "subject"); text(input.expectedHead, "expectedHead"); text(input.key, "key");
    number(input.expectedScopeVersion, "expectedScopeVersion", 1, Number.MAX_SAFE_INTEGER);
    const request = { operation: "erase-subject" as const, subject: subjectFence(scope, input.subject),
      expectedHead: input.expectedHead, expectedScopeVersion: input.expectedScopeVersion };
    return { scope, key: input.key, receiptKey: subjectErasureKey(scope, input.key),
      requestDigest: digest("entity-learn.request/v1", request), request };
  }
  /** Read-only identity and current-state check, never a reservation or permission. */
  prepareSubjectErasure(scope: string, input: SubjectErasureInput): PreparedSubjectErasure {
    const prepared = this.subjectErasureIdentity(scope, input);
    return this.read(() => {
      const prior = this.subjectErasureReceipt(scope, input.key);
      if (prior) {
        if (prior.event.requestDigest !== prepared.requestDigest) fail("idempotency_conflict", "Erasure request key conflict");
      } else {
        if (this.scopeVersion(scope) !== input.expectedScopeVersion) fail("scope_conflict", "Erasure requires the exact current scope version");
        if (this.head(scope, input.subject)?.id !== input.expectedHead) fail("head_conflict", "Erasure requires the exact current observation");
      }
      return prepared;
    });
  }
  /** Erases one subject's complete history and known dependent subjects, retaining
   * unrelated observations (including those in the same source refresh commit). */
  eraseSubject(scope: string, input: { subject: string; expectedHead: string; expectedScopeVersion: number; key: string }, at: number):
    { scope: string; erased: true; retired: false; subjects: number; observations: number; observationIds: string[]; replacements: { previous: string; observation: string }[] } {
    const { receiptKey: key, request } = this.subjectErasureIdentity(scope, input);
    this.receipt(scope, key);
    const result = this.commit(scope, key, request, requestDigest => {
      if (this.scopeVersion(scope) !== input.expectedScopeVersion) fail("scope_conflict", "Erasure requires the exact current scope version");
      if (this.head(scope, input.subject)?.id !== input.expectedHead) fail("head_conflict", "Erasure requires the exact current observation");
      this.verifyJournal(false);
      const rows = this.db.prepare("SELECT * FROM journal WHERE scope=? ORDER BY seq").all(scope) as JournalRow[];
      if (rows.length > 4096) fail("too_large", "Subject erasure exceeds 4096 journal rows");
      const entries = rows.map(row => ({ row, event: JSON.parse(row.body) as StoredMemoryEvent }));
      const observations = entries.flatMap(({ event }) => event.observations);
      if (observations.length > 16384) fail("too_large", "Subject erasure exceeds 16384 observations");
      const subjects = new Set([input.subject]);
      let ids = new Set<string>();
      for (;;) {
        ids = new Set(observations.filter(o => subjects.has(o.subject)).map(o => o.id));
        const before = subjects.size;
        for (const o of observations)
          if ([...o.supports, ...o.dependsOn].some(id => ids.has(id))) subjects.add(o.subject);
        if (subjects.size > 256) fail("too_large", "Subject erasure dependency closure exceeds 256 subjects");
        if (subjects.size === before) break;
      }
      const proofs = this.replacementProofs();
      const replacements: NonNullable<MemoryEvent["erasure"]>["rows"] = [];
      const rewritten = new Map<string, string>();
      for (const { row, event } of entries) {
        const kept = event.observations.filter(o => !ids.has(o.id)).map(o => {
          const { id, ...original } = o;
          const updated = { ...original, links: o.links.filter(link => !subjects.has(link.subject)),
            supersedes: o.supersedes ? rewritten.get(o.supersedes) ?? o.supersedes : null,
            supports: o.supports.map(ref => rewritten.get(ref) ?? ref),
            dependsOn: o.dependsOn.map(ref => rewritten.get(ref) ?? ref) };
          const next = observationId({ ...updated, payload: null });
          if (next !== id) rewritten.set(id, next);
          return { ...updated, id: next };
        });
        if (canonical(kept) === canonical(event.observations) && !(event.subject && subjects.has(event.subject))) continue;
        const replacementKey = row.request_key.startsWith("erased-read:") ? row.request_key : erasedReadKey(scope, row.request_key);
        const replacement: StoredMemoryEvent = { version: 1, scope, key: replacementKey,
          requestDigest: digest("entity-learn.erased-request/v1", { seq: row.seq, digest: row.digest }),
          recordedAt: event.recordedAt, operation: event.operation, observations: kept,
          ...(event.source ? { source: event.source } : {}) };
        const body = canonical(replacement);
        this.db.prepare("UPDATE journal SET request_key=?,request_digest=?,body=? WHERE seq=? AND scope=?")
          .run(replacement.key, replacement.requestDigest, body, row.seq, scope);
        const prior = proofs.get(row.seq);
        replacements.push({ seq: row.seq, digest: row.digest, replacement: digest("entity-learn.erasure-body/v1", replacement),
          ...(prior ? { previousReplacement: prior.replacement } : {}) });
      }
      // Reproject this scope in original order so canonical link replacements and
      // their supersedes/supports references agree. Other scopes remain untouched.
      for (const table of ["observations", "heads", "sources"])
        this.db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scope);
      for (const row of this.db.prepare("SELECT seq,body FROM journal WHERE scope=? ORDER BY seq").all(scope))
        this.project(this.hydrate(JSON.parse(String(row.body)) as StoredMemoryEvent), Number(row.seq));
      // Derived vectors have no general quotation lineage; invalidate the disposable scope cache.
      if (this.hasDerived()) this.db.prepare("DELETE FROM derived WHERE scope=?").run(scope);
      this.db.exec(`DELETE FROM artifacts WHERE digest NOT IN
        (SELECT json_extract(o.value, '$.payloadDigest') FROM journal j, json_each(j.body, '$.observations') o)`);
      return { version: 1, scope, key, requestDigest, recordedAt: at, operation: "erase-subject", observations: [],
        erasure: { rows: replacements, subjects: [...subjects].map(subject => subjectFence(scope, subject)).sort(), observationIds: [...ids].sort(), replacements: [...rewritten].map(([previous, observation]) => ({ previous, observation })) },
        // Counts only; no erased titles, quotes or raw subject identity.
        erasedObservations: ids.size };
    });
    return { scope, erased: true, retired: false, subjects: result.erasure!.subjects!.length,
      observations: result.erasedObservations!, observationIds: result.erasure!.observationIds!, replacements: result.erasure!.replacements ?? [] };
  }
  private artifact(hash: string): Observation["payload"] {
    const row = this.db.prepare("SELECT body FROM artifacts WHERE digest=?").get(hash) as Row | undefined;
    if (!row) return fail("corrupt_store", "Referenced artifact is missing");
    const payload = JSON.parse(String(row.body)) as Observation["payload"];
    if (digest("entity-learn.payload/v1", payload) !== hash) fail("corrupt_store", "Artifact integrity check failed");
    return payload;
  }
  private hydrate(event: StoredMemoryEvent): MemoryEvent {
    return { ...event, observations: event.observations.map(o => ({ ...o, payload: this.artifact(o.payloadDigest) })) };
  }
  private storeArtifacts(event: MemoryEvent): StoredMemoryEvent {
    const observations = event.observations.map(({ payload, ...o }) => {
      this.db.prepare("INSERT OR IGNORE INTO artifacts VALUES(?,?)").run(o.payloadDigest, canonical(payload));
      this.artifact(o.payloadDigest); // Existing digest paths must contain the expected bytes.
      return o;
    });
    return { ...event, observations };
  }
  commit(scope: string, key: string, request: unknown, create: (fingerprint: string) => MemoryEvent): MemoryEvent {
    const fingerprint = digest("entity-learn.request/v1", request);
    return this.transaction(() => {
      const previous = this.prior(scope, key, fingerprint);
      if (previous) { this.notifyErasure(previous); return previous; }
      if (this.retired(scope)) fail("erased", "Memory scope has been permanently erased");
      const event = create(fingerprint);
      if (key === ERASURE_KEY && event.operation !== "erase") fail("invalid_input", "Reserved scope erasure key");
      if (key.startsWith(SUBJECT_ERASURE_PREFIX) && event.operation !== "erase-subject") fail("invalid_input", "Reserved subject erasure key");
      if (event.observations.some(o => this.isErasedSubject(scope, o.subject))) fail("erased", "Observation subject has been erased");
      if (Buffer.byteLength(canonical(event)) > MAX_EVENT_BYTES) fail("too_large", "Atomic observation batch exceeds 1 MiB");
      const stored = this.storeArtifacts(event);
      const body = canonical(stored);
      const head = this.db.prepare("SELECT seq, digest FROM journal ORDER BY seq DESC LIMIT 1").get() as Row | undefined;
      const seq = Number(head?.seq ?? 0) + 1;
      const parent = String(head?.digest ?? ZERO);
      const hash = digest("entity-learn.journal/v1", { seq, previous: parent, event: stored });
      this.db.prepare("INSERT INTO journal VALUES (?,?,?,?,?,?,?)").run(seq, scope, key, fingerprint, parent, hash, body);
      this.project(event, seq);
      this.notifyErasure(event);
      return event;
    });
  }
  private notifyErasure(event: MemoryEvent): void {
    if (!this.onErasure || (event.operation !== "erase" && event.operation !== "erase-subject")) return;
    const row = this.receipt(event.scope, event.key);
    if (!row) fail("corrupt_store", "Erasure receipt unavailable");
    const result: unknown = this.onErasure({ fence: this.erasureFence(event.scope), operation: event.operation,
      receipt: { key: event.key, seq: row!.seq, digest: row!.digest, requestDigest: event.requestDigest, scopeVersion: row!.scopeVersion } });
    if (result && typeof (result as { then?: unknown }).then === "function")
      fail("invalid_input", "Erasure callback must be synchronous");
  }
  private project(event: MemoryEvent, seq: number): void {
    for (const observation of event.observations) {
      this.db.prepare("INSERT INTO observations VALUES (?,?,?,?,?,?,?)").run(
        observation.id, observation.scope, observation.subject, observation.type, observation.kind, seq,
        canonical(Object.fromEntries(Object.entries(observation).filter(([key]) => key !== "payload"))));
      this.db.prepare(`INSERT INTO heads(scope,subject,observation,forgotten) VALUES(?,?,?,0)
        ON CONFLICT(scope,subject) DO UPDATE SET observation=excluded.observation`).run(event.scope, observation.subject, observation.id);
    }
    if (event.source) this.db.prepare(`INSERT INTO sources VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET body=excluded.body`)
      .run(event.scope, event.source.id, canonical(event.source));
    if (event.operation === "forget" && event.subject) this.db.prepare("UPDATE heads SET forgotten=1 WHERE scope=? AND subject=?").run(event.scope, event.subject);
  }
  head(scope: string, subject: string): { id: string; forgotten: boolean } | undefined {
    const row = this.db.prepare("SELECT observation,forgotten FROM heads WHERE scope=? AND subject=?").get(scope, subject) as Row | undefined;
    return row ? { id: String(row.observation), forgotten: row.forgotten === 1 } : undefined;
  }
  observation(scope: string, id: string): Observation | undefined {
    const row = this.db.prepare("SELECT body FROM observations WHERE scope=? AND id=?").get(scope, id) as Row | undefined;
    if (!row) return undefined;
    const stored = JSON.parse(String(row.body)) as StoredObservation;
    if ("payload" in stored) fail("corrupt_store", "Observation integrity check failed: payload must be content-addressed");
    const observation: Observation = { ...stored, payload: this.artifact(stored.payloadDigest) };
    const { id: saved, ...content } = observation;
    if (saved !== id || observation.scope !== scope || observationId(content) !== saved || digest("entity-learn.payload/v1", observation.payload) !== observation.payloadDigest)
      return fail("corrupt_store", "Observation integrity check failed");
    return observation;
  }
  private checkedSource(source: Source): Source {
    const { revision, enabled, lastSuccess: _success, lastAttemptAt: _at, error: _error, failures: _failures, coverage: _coverage, ...recipe } = source;
    if (typeof enabled !== "boolean" || digest("entity-learn.source/v1", sourceInput(recipe)) !== revision)
      fail("corrupt_store", "Source recipe integrity check failed; execution refused");
    return source;
  }
  source(scope: string, id: string, asOf?: number): Source | undefined {
    if (asOf !== undefined) {
      const row = this.db.prepare(`SELECT body FROM journal WHERE scope=? AND json_extract(body,'$.source.id')=?
        AND json_extract(body,'$.recordedAt')<=? ORDER BY seq DESC LIMIT 1`).get(scope, id, asOf) as Row | undefined;
      return row ? this.checkedSource((JSON.parse(String(row.body)) as MemoryEvent).source!) : undefined;
    }
    const row = this.db.prepare("SELECT body FROM sources WHERE scope=? AND id=?").get(scope, id) as Row | undefined;
    return row ? this.checkedSource(JSON.parse(String(row.body)) as Source) : undefined;
  }
  sources(scope: string): Source[] {
    return (this.db.prepare("SELECT body FROM sources WHERE scope=? ORDER BY id").all(scope) as Row[]).map(r => this.checkedSource(JSON.parse(String(r.body)) as Source));
  }
  candidates(scope: string, input: { subject?: string; type?: string; kind?: string; asOf?: number; cap: number }): Observation[] {
    // Filtering is inside the scoped query, before lexical scoring or graph expansion.
    const conditions = ["o.scope=?", "h.forgotten=0"];
    const args: (string | number)[] = [scope];
    if (input.subject !== undefined) { conditions.push("o.subject=?"); args.push(input.subject); }
    if (input.type !== undefined) { conditions.push("o.type=?"); args.push(input.type); }
    if (input.kind !== undefined) { conditions.push("o.kind=?"); args.push(input.kind); }
    if (input.asOf === undefined) conditions.push("h.observation=o.id");
    else {
      conditions.push("json_extract(o.body,'$.recordedAt')<=?"); args.push(input.asOf);
      conditions.push(`NOT EXISTS(SELECT 1 FROM observations newer WHERE newer.scope=o.scope AND newer.subject=o.subject
        AND newer.seq>o.seq AND json_extract(newer.body,'$.recordedAt')<=?)`); args.push(input.asOf);
    }
    args.push(input.cap);
    const rows = this.db.prepare(`SELECT o.id FROM observations o JOIN heads h ON h.scope=o.scope AND h.subject=o.subject
      WHERE ${conditions.join(" AND ")} ORDER BY o.seq DESC,o.id LIMIT ?`).all(...args) as Row[];
    return rows.map(r => this.observation(scope, String(r.id))!);
  }
  /** Keyset paging, not recent-N preselection. Canonical hydration remains authoritative. */
  page(scope: string, input: { after?: string; type?: string; kind?: string; limit: number }): Observation[] {
    const conditions = ["o.scope=?", "h.forgotten=0", "h.observation=o.id", "o.id>?"];
    const args: (string | number)[] = [scope, input.after ?? ""];
    for (const field of ["type", "kind"] as const) if (input[field] !== undefined) { conditions.push(`o.${field}=?`); args.push(input[field]!); }
    args.push(input.limit);
    return this.db.prepare(`SELECT o.id FROM observations o JOIN heads h ON h.scope=o.scope AND h.subject=o.subject
      WHERE ${conditions.join(" AND ")} ORDER BY o.id LIMIT ?`).all(...args).map(row => this.observation(scope, String(row.id))!);
  }
  private hasDerived(): boolean { return !!this.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='derived'").get(); }
  /** Disposable, scoped derived data. Never exported as evidence or used without canonical joins.
   * Lazy schema: reading a pre-index database remains possible on a read-only connection. */
  derived(scope: string, namespace: string, key: string): unknown | undefined {
    if (!this.hasDerived()) return undefined;
    const row = this.db.prepare("SELECT body,digest FROM derived WHERE scope=? AND namespace=? AND key=?").get(scope, namespace, key);
    if (!row) return undefined;
    const value = JSON.parse(String(row.body));
    if (digest("entity-learn.derived/v1", { scope, namespace, key, value }) !== row.digest) fail("corrupt_store", "Derived data integrity check failed");
    return value;
  }
  putDerived(scope: string, namespace: string, key: string, value: unknown): void {
    if (this.retired(scope)) fail("erased", "Memory scope has been permanently erased");
    const body = canonical(value);
    if (Buffer.byteLength(body) > MAX_EVENT_BYTES) fail("too_large", "Derived entry exceeds its bound");
    this.db.exec(`CREATE TABLE IF NOT EXISTS derived (
      scope TEXT NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL,
      PRIMARY KEY(scope, namespace, key))`);
    this.db.prepare(`INSERT OR IGNORE INTO derived SELECT ?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM journal WHERE scope=? AND request_key=?)
      AND NOT EXISTS (SELECT 1 FROM journal j, json_each(j.body, '$.erasure.observationIds') o WHERE j.scope=? AND o.value=?)
      AND NOT EXISTS (SELECT 1 FROM journal j, json_each(j.body, '$.erasure.replacements') r WHERE j.scope=? AND json_extract(r.value, '$.previous')=?)`).run(scope, namespace, key, body,
      digest("entity-learn.derived/v1", { scope, namespace, key, value }), scope, ERASURE_KEY, scope, key, scope, key);
    if (this.retired(scope)) fail("erased", "Memory scope has been permanently erased");
  }
  clearDerived(scope: string, namespace: string): void {
    if (!this.hasDerived()) return;
    this.db.prepare("DELETE FROM derived WHERE scope=? AND namespace=?").run(scope, namespace);
  }
  history(scope: string, subject: string, limit: number): Observation[] {
    const rows = this.db.prepare("SELECT id FROM observations WHERE scope=? AND subject=? ORDER BY seq DESC LIMIT ?").all(scope, subject, limit) as Row[];
    return rows.map(r => this.observation(scope, String(r.id))!);
  }
  /** Validates the canonical chain; rebuilding never executes a source. */
  rebuild(): { events: number; observations: number; root: string } {
    return this.transaction(() => {
      this.db.exec("DELETE FROM observations; DELETE FROM heads; DELETE FROM sources;");
      if (this.hasDerived()) this.db.exec("DELETE FROM derived;");
      return this.verifyJournal(true);
    });
  }
  private replacementProofs(): Map<number, { scope: string; digest: string; replacement: string }> {
    const proofs = new Map<number, { scope: string; digest: string; replacement: string }>();
    for (const row of this.db.prepare("SELECT * FROM journal WHERE request_key=? OR request_key LIKE ? ORDER BY seq")
      .all(ERASURE_KEY, `${SUBJECT_ERASURE_PREFIX}%`) as JournalRow[]) {
      const event = JSON.parse(row.body) as StoredMemoryEvent;
      if (!["erase", "erase-subject"].includes(event.operation) || !event.erasure || event.scope !== row.scope ||
          digest("entity-learn.journal/v1", { seq: row.seq, previous: row.previous, event }) !== row.digest)
        fail("corrupt_store", "Invalid erasure proof");
      for (const proof of event.erasure!.rows) {
        const previous = proofs.get(proof.seq);
        if (!Number.isSafeInteger(proof.seq) || proof.seq < 1 || proof.seq >= row.seq ||
            (previous && (previous.scope !== row.scope || previous.digest !== proof.digest ||
              (event.operation !== "erase" && proof.previousReplacement !== previous.replacement))) ||
            (!previous && proof.previousReplacement !== undefined))
          fail("corrupt_store", "Invalid cumulative erasure proof");
        proofs.set(proof.seq, { ...proof, scope: row.scope });
      }
    }
    return proofs;
  }
  private verifyJournal(project: boolean): { events: number; observations: number; root: string } {
      const erased = this.replacementProofs();
      let parent = ZERO; let seq = 0; let observations = 0;
      for (const raw of this.db.prepare("SELECT * FROM journal ORDER BY seq").iterate()) {
        const row = raw as Row;
        const stored = JSON.parse(String(row.body)) as StoredMemoryEvent;
        seq++;
        const proof = erased.get(seq);
        const replacement = proof !== undefined && proof.scope === row.scope && proof.digest === row.digest &&
          proof.replacement === digest("entity-learn.erasure-body/v1", stored);
        if (stored.operation === "erased" && !replacement) fail("corrupt_store", "Erased row lacks a valid erasure proof");
        if (proof && !replacement) fail("corrupt_store", "Erasure proof does not match the removed row");
        if (row.seq !== seq || row.previous !== parent || stored.version !== 1 || stored.scope !== row.scope ||
            stored.key !== row.request_key || stored.requestDigest !== row.request_digest ||
            (!replacement && digest("entity-learn.journal/v1", { seq, previous: parent, event: stored }) !== row.digest))
          fail("corrupt_store", "Journal chain verification failed; projections were not replaced");
        const event = this.hydrate(stored);
        for (const o of event.observations) {
          const { id, ...content } = o;
          if (o.scope !== event.scope || observationId(content) !== id ||
              digest("entity-learn.payload/v1", o.payload) !== o.payloadDigest) fail("corrupt_store", "Invalid journal observation");
        }
        if (project) this.project(event, seq);
        observations += event.observations.length; parent = String(row.digest);
      }
      return { events: seq, observations, root: parent };
  }
  /** Export authority is separate from recall: this contains suppressed historical payloads. */
  exportArchive(scope: string): MemoryArchive {
    text(scope, "scope", 256);
    return this.read(() => {
      if (this.db.prepare("SELECT scope FROM journal WHERE scope<>? LIMIT 1").get(scope))
        fail("scope_mismatch", "Archive requires a dedicated single-scope store");
      const budget = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM journal`).get()!;
      const artifactsBudget = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM artifacts`).get()!;
      if (Number(budget.n) > MAX_ARCHIVE_ROWS || Number(artifactsBudget.n) > MAX_ARCHIVE_ROWS ||
          Number(budget.bytes) + Number(artifactsBudget.bytes) > MAX_ARCHIVE_BYTES)
        fail("too_large", "Atomic memory archive exceeds its 8 MiB / 16384-row bound; no partial export was made");
      const checked = this.verifyJournal(false);
      const archive: MemoryArchive = { format: "entity-learn.sqlite/v1", scope, root: checked.root,
        journal: this.db.prepare("SELECT * FROM journal ORDER BY seq").all() as JournalRow[],
        artifacts: this.db.prepare("SELECT digest,body FROM artifacts ORDER BY digest").all() as MemoryArchive["artifacts"] };
      this.checkArchive(archive, scope);
      return archive;
    });
  }
  private checkArchive(value: unknown, scope: string): MemoryArchive {
    const archive = object(value, ["format", "scope", "root", "journal", "artifacts"]);
    if (archive.format !== "entity-learn.sqlite/v1") fail("invalid_archive", "Unsupported memory archive format");
    if (archive.scope !== scope) fail("scope_mismatch", "Memory archive belongs to another scope");
    const hash = (value: unknown): string => {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return fail("invalid_archive", "Invalid archive digest");
      return value;
    };
    hash(archive.root);
    if (!Array.isArray(archive.journal) || !Array.isArray(archive.artifacts) ||
        archive.journal.length > MAX_ARCHIVE_ROWS || archive.artifacts.length > MAX_ARCHIVE_ROWS)
      fail("invalid_archive", "Invalid or oversized memory archive tables");
    if (Buffer.byteLength(canonical(archive)) > MAX_ARCHIVE_BYTES) fail("too_large", "Atomic memory archive exceeds 8 MiB");
    const needed = new Set<string>();
    for (const raw of archive.journal as unknown[]) {
      const row = object(raw, ["seq", "scope", "request_key", "request_digest", "previous", "digest", "body"]);
      number(row.seq, "seq", 1, Number.MAX_SAFE_INTEGER);
      if (row.scope !== scope) fail("scope_mismatch", "Memory archive contains a foreign journal row");
      text(row.request_key, "request_key"); hash(row.request_digest); hash(row.previous); hash(row.digest);
      if (typeof row.body !== "string" || Buffer.byteLength(row.body) > MAX_EVENT_BYTES) fail("invalid_archive", "Invalid journal body");
      const event = JSON.parse(row.body as string) as StoredMemoryEvent;
      if (canonical(event) !== row.body || !Array.isArray(event.observations)) fail("invalid_archive", "Noncanonical journal body");
      for (const observation of event.observations) needed.add(hash(observation.payloadDigest));
      if (event.source) this.checkedSource(event.source);
    }
    const supplied = new Set<string>();
    for (const raw of archive.artifacts as unknown[]) {
      const row = object(raw, ["digest", "body"]); const id = hash(row.digest);
      if (supplied.has(id) || !needed.has(id) || typeof row.body !== "string") fail("invalid_archive", "Unexpected or duplicate memory artifact");
      const payload = JSON.parse(row.body as string);
      if (canonical(payload) !== row.body || digest("entity-learn.payload/v1", payload) !== id)
        fail("corrupt_store", "Archive artifact integrity check failed");
      supplied.add(id);
    }
    if (supplied.size !== needed.size) fail("invalid_archive", "Memory archive is missing artifacts");
    return archive as unknown as MemoryArchive;
  }
  /** Empty-only atomic restore retains original citations, request keys, timestamps and chain root. */
  /** Persist externally after each erasure; host must serialize authority updates with restore. */
  erasureFence(scope: string): ErasureFence {
    text(scope, "scope", 256);
    return this.read(() => {
      this.verifyJournal(false);
      const row = this.db.prepare("SELECT seq,digest FROM journal WHERE scope=? AND (request_key=? OR request_key LIKE ?) ORDER BY seq DESC LIMIT 1")
        .get(scope, ERASURE_KEY, `${SUBJECT_ERASURE_PREFIX}%`);
      return { version: 1, scope, seq: row ? Number(row.seq) : 0, digest: row ? String(row.digest) : ZERO };
    });
  }
  private checkedArchiveErasure(scope: string, value: unknown, required: boolean): { archive: MemoryArchive; fence: ErasureFence | null | undefined } {
    const fence = this.restoreAuthority?.(scope);
    if ((required || this.restoreAuthority) && (!fence || fence.version !== 1 || fence.scope !== scope ||
        !Number.isSafeInteger(fence.seq) || fence.seq < 0 || typeof fence.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(fence.digest) || (fence.seq === 0 && fence.digest !== ZERO)))
      fail("invalid_input", "Restore authority is unavailable or invalid");
    const archive = this.checkArchive(value, scope);
    if (fence) {
      const latest = archive.journal.filter(row => row.request_key === ERASURE_KEY || row.request_key.startsWith(SUBJECT_ERASURE_PREFIX)).at(-1);
      if ((latest?.seq ?? 0) !== fence.seq || (latest?.digest ?? ZERO) !== fence.digest)
        fail("invalid_input", "Archive conflicts with retained erasure fence");
    }
    return { archive, fence };
  }
  /** Structural/artifact and current fence preflight only; does not verify the journal chain. */
  checkArchiveErasure(scope: string, value: unknown): ArchiveErasureCheck {
    text(scope, "scope", 256);
    return this.read(() => {
      const { archive, fence } = this.checkedArchiveErasure(scope, value, true);
      return { scope, fence: { ...fence! }, journalRows: archive.journal.length, artifacts: archive.artifacts.length, chainVerified: false };
    });
  }
  importArchive(scope: string, value: unknown): { events: number; observations: number; root: string } {
    text(scope, "scope", 256);
    return this.transaction(() => {
      // Refuse rollback over retained receipts before inspecting old private artifacts.
      for (const table of ["journal", "artifacts", "observations", "heads", "sources"])
        if (this.db.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get())
          fail("store_not_empty", "Memory archive import requires an empty destination");
      const { archive } = this.checkedArchiveErasure(scope, value, false);
      if (this.hasDerived()) this.db.exec("DELETE FROM derived;");
      for (const row of archive.artifacts)
        this.db.prepare("INSERT INTO artifacts VALUES(?,?)").run(row.digest, row.body);
      for (const row of archive.journal)
        this.db.prepare("INSERT INTO journal VALUES(?,?,?,?,?,?,?)")
          .run(row.seq, row.scope, row.request_key, row.request_digest, row.previous, row.digest, row.body);
      const verified = this.verifyJournal(true);
      if (verified.root !== archive.root) fail("corrupt_store", "Memory archive root mismatch");
      return verified;
    });
  }
  events(scope: string): StoredEvent[] {
    return (this.db.prepare("SELECT * FROM journal WHERE scope=? ORDER BY seq").all(scope) as Row[]).map(row => ({
      seq: Number(row.seq), previous: String(row.previous), digest: String(row.digest), event: this.hydrate(JSON.parse(String(row.body)) as StoredMemoryEvent),
    }));
  }
}
