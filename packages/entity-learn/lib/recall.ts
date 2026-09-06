import { byteLength, recallInput } from "./codec.js";
import type { Memory } from "./memory-core.js";
import type { Json, MemoryHit, Observation, RecallInput, RecallResult } from "./types.js";

export function tokenize(text: string): string[] { return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []; }
function values(value: Json): string {
  if (value === null) return "";
  if (typeof value !== "object") return String(value);
  return (Array.isArray(value) ? value : Object.values(value)).map(values).join(" ");
}
/** Corpus contains identifiers, numbers, booleans and Unicode, not just string fields. */
export function rank(observations: Observation[], search = ""): Observation[] {
  const query = [...new Set(tokenize(search))];
  if (query.length === 0) return observations;
  const docs = observations.map(o => ({ o, tokens: tokenize([o.subject, o.title, o.type, values(o.payload), ...o.links.map(link => `${link.subject} ${link.relation}`)].join(" ")) }));
  const avg = docs.reduce((sum, d) => sum + d.tokens.length, 0) / (docs.length || 1) || 1;
  const df = new Map(query.map(q => [q, docs.filter(d => d.tokens.includes(q)).length]));
  return docs.map(d => {
    let score = d.o.subject.toLowerCase() === search.toLowerCase() ? 1000 : 0;
    for (const q of query) {
      const tf = d.tokens.filter(t => t === q).length;
      const idf = Math.log(1 + (docs.length - df.get(q)! + 0.5) / (df.get(q)! + 0.5));
      score += idf * tf * 2.5 / (tf + 1.5 * (0.25 + 0.75 * d.tokens.length / avg));
    }
    return { o: d.o, score };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score || b.o.recordedAt - a.o.recordedAt || a.o.id.localeCompare(b.o.id)).map(d => d.o);
}

export function accessible(memory: Memory, observation: Observation): boolean {
  const queue = [observation]; const seen = new Set<string>();
  while (queue.length) {
    const o = queue.pop()!;
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    // Evidence closure is fail-closed; pathological chains never leak an unverified summary.
    if (seen.size > 256 || memory.journal.head(memory.scope, o.subject)?.forgotten) return false;
    for (const id of [...o.supports, ...o.dependsOn]) {
      const dependency = memory.journal.observation(memory.scope, id);
      if (!dependency) return false;
      queue.push(dependency);
    }
  }
  return true;
}
function current(memory: Memory, o: Observation, asOf?: number): boolean {
  const head = asOf === undefined ? memory.journal.head(memory.scope, o.subject)?.id
    : memory.journal.candidates(memory.scope, { subject: o.subject, asOf, cap: 1 })[0]?.id;
  if (head !== o.id) return false;
  if (o.producer.sourceId) {
    const source = memory.journal.source(memory.scope, o.producer.sourceId, asOf);
    return source?.lastSuccess === o.producer.reference && source.revision === o.producer.sourceRevision;
  }
  return true;
}
function stale(memory: Memory, observation: Observation, now: number, asOf?: number): boolean {
  const queue = [observation]; const seen = new Set<string>();
  while (queue.length) {
    const o = queue.pop()!;
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    if (seen.size > 256) return true;
    if ((o.expiresAt !== null && now >= o.expiresAt) || (o.validFrom !== null && now < o.validFrom) || (o.validTo !== null && now >= o.validTo)) return true;
    if (o.producer.sourceId) {
      const source = memory.journal.source(memory.scope, o.producer.sourceId, asOf);
      if (!source?.enabled || source.error || !current(memory, o, asOf)) return true;
    }
    for (const id of o.dependsOn) {
      const input = memory.journal.observation(memory.scope, id);
      if (!input || !current(memory, input, asOf)) return true;
      queue.push(input);
    }
  }
  return false;
}
export function hit(memory: Memory, observation: Observation, now: number, asOf: number | undefined, via: MemoryHit["via"]): MemoryHit | null {
  if (!accessible(memory, observation)) return null;
  const source = observation.producer.sourceId ? memory.journal.source(memory.scope, observation.producer.sourceId, asOf) : undefined;
  return { observation, freshness: stale(memory, observation, now, asOf) ? "stale" : observation.expiresAt === null ? "not-applicable" : "fresh",
    state: asOf !== undefined ? "historical" : current(memory, observation) ? "current" : "superseded", refreshError: source?.error ?? null, via };
}
export function recall(memory: Memory, value: RecallInput): RecallResult {
  const input = recallInput(value);
  const now = input.asOf ?? memory.now();
  const limit = input.limit ?? 10; const maxBytes = input.maxBytes ?? 12000;
  const maxCandidates = input.maxCandidates ?? 2000; const maxNodes = input.maxNodes ?? 32; const depth = input.depth ?? 0;
  const reasons = new Set<string>();
  const candidates = memory.journal.candidates(memory.scope, { ...input, cap: maxCandidates + 1 });
  if (candidates.length > maxCandidates) { candidates.pop(); reasons.add("candidate_budget"); }
  const selected: Observation[] = [];
  for (const o of candidates) {
    if (!current(memory, o, input.asOf)) continue; // Removed entities and replaced source revisions are not current.
    const item = hit(memory, o, now, input.asOf, "match");
    if (!item) { reasons.add("evidence_unavailable"); continue; }
    if (input.includeStale === false && item.freshness === "stale") { reasons.add("stale_excluded"); continue; }
    selected.push(o);
  }
  for (const source of memory.sources().filter(s => !input.type || s.type === input.type)) {
    const historical = input.asOf === undefined ? source : memory.journal.source(memory.scope, source.id, input.asOf);
    if (historical && !historical.lastSuccess) reasons.add("unobserved_sources");
    if (historical?.error) reasons.add("source_errors");
    if (historical?.coverage && !historical.coverage.complete) reasons.add("source_partial");
  }
  const ranked = rank(selected, input.search);
  if (ranked.length > limit) reasons.add("result_budget");
  const queue = ranked.slice(0, limit).map(o => ({ o, depth: 0, via: "match" as MemoryHit["via"] }));
  const seen = new Set<string>(); const items: MemoryHit[] = []; let used = 0; let expanded = 0;
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node.o.id)) continue;
    if (seen.size >= maxNodes) { reasons.add("node_budget"); break; }
    seen.add(node.o.id);
    const item = hit(memory, node.o, now, input.asOf, node.via);
    if (!item || (input.includeStale === false && item.freshness === "stale")) { reasons.add("evidence_unavailable"); continue; }
    const bytes = byteLength(item) + 1;
    if (used + bytes > maxBytes - 512) { reasons.add("byte_budget"); continue; }
    items.push(item); used += bytes;
    if (node.depth > 0) expanded++;
    if (node.depth >= depth) continue;
    for (const [refs, via] of [[node.o.supports, "supports"], [node.o.dependsOn, "depends_on"]] as const) {
      for (const id of refs) {
        const o = memory.journal.observation(memory.scope, id);
        if (o && (input.asOf === undefined || o.recordedAt <= input.asOf)) queue.push({ o, depth: node.depth + 1, via });
      }
    }
    for (const link of node.o.links) {
      const o = memory.journal.candidates(memory.scope, { subject: link.subject, ...(input.asOf === undefined ? {} : { asOf: input.asOf }), cap: 1 })[0];
      if (o && current(memory, o, input.asOf)) queue.push({ o, depth: node.depth + 1, via: "related" });
    }
  }
  const result: RecallResult = { items, coverage: reasons.size ? "partial" : "complete", corpus: "recorded-observations",
    reasons: [...reasons].sort(), scanned: candidates.length, expanded, bytes: 0, sourceVersion: memory.journal.scopeVersion(memory.scope) };
  while (result.bytes !== byteLength(result)) result.bytes = byteLength(result);
  return result;
}
