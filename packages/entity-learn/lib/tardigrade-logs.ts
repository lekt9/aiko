import { byteLength, canonical, digest, fail, number, object, safePayload, sourceInput, text } from "./codec.js";
import type { Json, Link, SourceInput, SourceRunner } from "./types.js";

/** Public Tardie 0.5 client.events() wire shape; no dependency on its internal SQLite tables. */
export interface TardigradeLogRow { readonly seq: number; readonly event: { readonly type: string; readonly [key: string]: unknown } }
export interface TardigradeLogOptions {
  id: string;
  actor: string;
  thread: string;
  after?: number;
  maxEvents?: number;
  ttlSeconds?: number;
  /** Host-bound transport/authorization. Bound network bodies and honor signal in this function. */
  read: (request: { actor: string; thread: string; after: number; limit: number; signal: AbortSignal; maxBytes: number }) => Promise<ReadonlyArray<TardigradeLogRow>>;
  /** Defaults to metadata only. Explicitly select/redact content before admitting it to memory. */
  project?: (row: TardigradeLogRow) => Json;
  /** Relationship hints to existing entities, never automatic supports/dependsOn evidence. */
  relate?: (row: TardigradeLogRow) => Link[];
  /** Required for custom projection/link policy; change it when that host policy changes. */
  policyVersion?: string;
}

/** One approved, bounded log window, composable with every other entity source. No append or replay. */
export function tardigradeLogSource(options: TardigradeLogOptions): { source: SourceInput; run: SourceRunner } {
  const id = text(options.id, "id", 256);
  const actor = text(options.actor, "actor", 256); const thread = text(options.thread, "thread", 256);
  const after = number(options.after ?? 0, "after", 0, Number.MAX_SAFE_INTEGER);
  const maxEvents = number(options.maxEvents ?? 50, "maxEvents", 1, 500);
  const ttlSeconds = number(options.ttlSeconds ?? 60, "ttlSeconds", 0, 31536000);
  const policy = options.project || options.relate ? text(options.policyVersion, "policyVersion", 128) : "metadata-v1";
  const namespace = `tardigrade/${encodeURIComponent(actor)}/${encodeURIComponent(thread)}`;
  const reference = `tardigrade-log:${encodeURIComponent(actor)}/${encodeURIComponent(thread)}`;
  const locator = `tdg-log:${digest("entity-learn.log-recipe/v1", { actor, thread, after, maxEvents, policy })}`;
  const source = sourceInput({ id, namespace, type: "event", kind: "episode", resolver: "adapter", locator,
    format: "json", ttlSeconds, schema: { id: "seq", title: "title" } });
  const recipe = canonical(source);
  const read = options.read; const project = options.project; const relate = options.relate;
  const run: SourceRunner = async (registered, context) => {
    const { revision: _rev, enabled: _on, lastSuccess: _ok, lastAttemptAt: _at, error: _error,
      failures: _failures, coverage: _coverage, ...input } = registered;
    if (canonical(input) !== recipe) fail("adapter_mismatch", "Log adapter requires its exact host-bound recipe");
    context.signal.throwIfAborted();
    // One extra row establishes whether a page was capped. Never infer exhaustion from a full page.
    const rows = await read({ actor, thread, after, limit: maxEvents + 1, ...context });
    context.signal.throwIfAborted();
    if (!Array.isArray(rows) || rows.length > maxEvents + 1) fail("schema_drift", "Log reader ignored its page bound");
    const data: Json[] = []; const links: Record<string, Link[]> = Object.create(null);
    const reasons = new Set<string>(after > 0 ? ["log_window"] : []);
    if (rows.length > maxEvents) reasons.add("event_limit");
    let previous = after; let nextAfter = after;
    for (const row of rows) {
      object(row, ["seq", "event"]);
      number(row.seq, "event seq", 1, Number.MAX_SAFE_INTEGER);
      if (row.seq !== previous + 1) fail("schema_drift", "Log reader must return contiguous, unfiltered sequence numbers");
      previous = row.seq;
      if (data.length === maxEvents) break;
      if (!row.event || typeof row.event !== "object" || Array.isArray(row.event)) fail("schema_drift", "Invalid log event");
      const eventType = text(row.event.type, "event type", 128);
      const metadata: Record<string, Json> = {};
      for (const key of ["type", "name", "method", "package", "callId", "turn", "at"]) {
        const value = row.event[key];
        if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) metadata[key] = value;
      }
      const item: Json = { seq: row.seq, title: `${eventType} #${row.seq}`, actor, thread, eventType,
        reference: `${reference}#${row.seq}`, eventDigest: digest("entity-learn.tardigrade-event/v1", row.event),
        projection: project ? policy : "metadata-only", data: project ? safePayload(project(row)) : metadata };
      if (byteLength([...data, item]) > context.maxBytes) { reasons.add("byte_limit"); break; }
      data.push(item); nextAfter = row.seq;
      if (relate) links[`${namespace}/event/${row.seq}`] = relate(row);
    }
    return { data, links, producer: { kind: "tool", reference },
      coverage: { complete: reasons.size === 0, reasons: [...reasons], nextAfter } };
  };
  return { source, run };
}
