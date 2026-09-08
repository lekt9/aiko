export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type MemoryKind = "fact" | "episode" | "skill" | "entity";
export interface Producer {
  kind: "user" | "agent" | "tool" | "file" | "contract" | "legacy";
  reference: string;
  sourceId?: string;
  sourceRevision?: string;
  evidenceReference?: string;
}
export interface Link { subject: string; relation: string }
export interface RememberInput {
  subject: string;
  title: string;
  type: string;
  payload: Json;
  kind?: MemoryKind;
  /** Compare-and-swap: required when correcting an existing subject. */
  supersedes?: string;
  observedAt?: number;
  ttlSeconds?: number;
  validFrom?: number;
  validTo?: number;
  /** Citations to exact earlier observations; never executable. */
  supports?: string[];
  /** Current-input dependencies: moving a head makes the derivation stale. */
  dependsOn?: string[];
  links?: Link[];
}
export interface Observation {
  id: string;
  payloadDigest: string;
  scope: string;
  subject: string;
  title: string;
  type: string;
  kind: MemoryKind;
  payload: Json;
  producer: Producer;
  observedAt: number;
  recordedAt: number;
  expiresAt: number | null;
  validFrom: number | null;
  validTo: number | null;
  supersedes: string | null;
  supports: string[];
  dependsOn: string[];
  links: Link[];
}
export interface SourceSchema {
  id?: string;
  title?: string;
  status?: string;
}
export interface SourceInput {
  id: string;
  namespace: string;
  type: string;
  resolver: "file" | "adapter";
  /** File path or host-owned adapter name. Never a shell command. */
  locator: string;
  format: "json" | "jsonl" | "text";
  ttlSeconds: number;
  kind?: MemoryKind;
  schema?: SourceSchema;
}
export interface Source extends SourceInput {
  revision: string;
  enabled: boolean;
  lastSuccess: string | null;
  lastAttemptAt: number | null;
  error: string | null;
  failures: number;
  coverage?: SourceCoverage;
}
export interface SourceCoverage { complete: boolean; reasons: string[]; nextAfter?: number }
export interface RefreshResult { observations: string[]; error: string | null; coverage: SourceCoverage }
export interface SourceResult {
  data: Json;
  observedAt?: number;
  /** Optional host-owned evidence attribution, not a model argument. */
  producer?: Producer;
  /** Host-declared relationships are hints, never evidence or grants. Keyed by normalized subject. */
  links?: Record<string, Link[]>;
  coverage?: SourceCoverage;
}
export type SourceRunner = (source: Readonly<Source>, context: {
  signal: AbortSignal; maxBytes: number;
}) => Promise<SourceResult>;
export interface WriteOptions { key: string; producer: Producer }
export interface RecallInput {
  search?: string;
  subject?: string;
  type?: string;
  kind?: MemoryKind;
  /** Transaction-time query; does not manufacture missing world history. */
  asOf?: number;
  limit?: number;
  maxBytes?: number;
  maxCandidates?: number;
  maxNodes?: number;
  depth?: number;
  includeStale?: boolean;
}
export interface MemoryHit {
  observation: Observation;
  freshness: "fresh" | "stale" | "not-applicable";
  state: "current" | "superseded" | "historical";
  refreshError: string | null;
  via: "match" | "supports" | "depends_on" | "related";
}
export interface RecallResult {
  items: MemoryHit[];
  coverage: "complete" | "partial";
  /** Coverage refers only to the scoped, recorded corpus. */
  corpus: "recorded-observations";
  reasons: string[];
  scanned: number;
  expanded: number;
  bytes: number;
  sourceVersion: number;
}
export interface MemoryEvent {
  version: 1;
  scope: string;
  key: string;
  requestDigest: string;
  recordedAt: number;
  operation: "remember" | "refresh" | "source" | "forget" | "failure" | "erase" | "erased" | "erase-subject";
  observations: Observation[];
  source?: Source;
  subject?: string;
  erasedObservations?: number;
  erasure?: { rows: { seq: number; digest: string; replacement: string; previousReplacement?: string }[]; subjects?: string[]; observationIds?: string[]; replacements?: { previous: string; observation: string }[] };
}
export interface StoredEvent { seq: number; previous: string; digest: string; event: MemoryEvent }
export class MemoryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "MemoryError"; }
}
