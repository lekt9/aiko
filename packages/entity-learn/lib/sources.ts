import { createHash } from "node:crypto";
import { digest, fail, safePayload, MAX_PAYLOAD_BYTES } from "./codec.js";
import type { Json, RememberInput, Source } from "./types.js";

export function normalizeSource(source: Source, data: Json): RememberInput[] {
  const items = Array.isArray(data) ? data : [data];
  if (items.length > 500) fail("too_large", "A source refresh may admit at most 500 entities");
  const seen = new Set<string>();
  return items.map(item => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail("schema_drift", "Expected JSON objects, or an array of objects");
    const row = item as Record<string, Json>;
    const find = (explicit: string | undefined, candidates: string[]) => {
      if (explicit && !(explicit in row)) fail("schema_drift", `Required source field disappeared: ${explicit}`);
      return explicit ?? candidates.find(k => row[k] !== undefined && row[k] !== null);
    };
    const idField = find(source.schema?.id, ["id", "number", "key", "slug", "login"]);
    const titleField = find(source.schema?.title, ["title", "name", "subject", "summary", "text"]);
    if (source.schema?.status) find(source.schema.status, []);
    const idValue = idField ? row[idField] : undefined;
    if (idField && (typeof idValue !== "string" && typeof idValue !== "number")) fail("schema_drift", "Entity identity must be a string or number");
    // No positional identities: array reordering cannot silently rename an entity.
    const localId = idValue === undefined ? (!Array.isArray(data) ? "document" : digest("entity-learn.unkeyed/v1", row)) : String(idValue);
    if (!localId.length) fail("schema_drift", "Entity identity cannot be empty");
    const subject = `${source.namespace}/${encodeURIComponent(source.type)}/${encodeURIComponent(localId)}`;
    if (seen.has(subject)) fail("schema_drift", "Duplicate entity identity in one source response");
    seen.add(subject);
    const title = titleField ? row[titleField] : localId;
    if (typeof title !== "string" && typeof title !== "number") fail("schema_drift", "Entity title must be text or a number");
    return { subject, title: String(title).replace(/[\u0000-\u001f]/g, " ").slice(0, 1000) || localId,
      type: source.type, kind: source.kind ?? (source.format === "text" ? "episode" : "entity"), payload: row, ttlSeconds: source.ttlSeconds };
  });
}

/** Read-only projection of one exact Contract settlement. No Contract execution or ledger writes. */
export function contractEvidence(line: unknown): { data: Json; evidenceDigest: string; settlementDigest: string; reference: string }[] {
  if (!line || typeof line !== "object" || Array.isArray(line)) return [];
  const row = line as Record<string, unknown>;
  if (row.event === "neuron_transaction") {
    if (!Array.isArray(row.rows)) return fail("invalid_evidence", "Malformed Contract transaction");
    return row.rows.flatMap(contractEvidence);
  }
  if (row.event !== "neuron_skill_node_settled") return [];
  if (typeof row.evidence_digest !== "string" || !/^[a-f0-9]{64}$/.test(row.evidence_digest) || row.evidence_payload === undefined)
    return fail("invalid_evidence", "Contract settlement lacks an exact payload digest");
  // Contract hashes its compact JSON serialization, not this package's canonical JSON.
  const bytes = JSON.stringify(row.evidence_payload);
  if (Buffer.byteLength(bytes) > MAX_PAYLOAD_BYTES) fail("too_large", "Contract evidence exceeds 64 KiB");
  // SHA256 over raw compact bytes is the existing artifact.zig contract.
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== row.evidence_digest) fail("invalid_evidence", "Contract evidence digest mismatch");
  const settlementDigest = digest("entity-learn.contract-settlement/v1", row);
  return [{ data: safePayload(row.evidence_payload), evidenceDigest: row.evidence_digest, settlementDigest,
    reference: `contract-settlement:${settlementDigest}/evidence:sha256:${row.evidence_digest}` }];
}
