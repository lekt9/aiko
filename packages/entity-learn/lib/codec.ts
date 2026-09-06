import { createHash } from "node:crypto";
import { MemoryError, type Json, type RememberInput, type SourceInput, type RecallInput, type Observation, type SourceCoverage } from "./types.js";

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_EVENT_BYTES = 1024 * 1024;
export const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
export const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export function canonical(value: unknown, depth = 0): string {
  if (depth > 24) throw new MemoryError("invalid_input", "JSON nesting exceeds 24 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(",")}]`;
  if (typeof value === "object" && value !== null &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  }
  throw new MemoryError("invalid_input", "Expected finite, plain JSON data");
}
export const digest = (domain: string, value: unknown): string => sha256(`${domain}\n${canonical(value)}`);
export function observationId(content: Omit<Observation, "id">): string {
  const { payload: _payload, ...node } = content;
  return `obs_${digest("entity-learn.observation/v1", node)}`;
}
export const clone = <T>(value: T): T => JSON.parse(canonical(value)) as T;
export const fail = (code: string, message: string): never => { throw new MemoryError(code, message); };
export function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("invalid_input", "Expected an object");
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail("invalid_input", `Unknown field: ${key}`);
  return obj;
}
export function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    return fail("invalid_input", `${field} must be non-empty text, at most ${max} characters, without control characters`);
  return value;
}
export function number(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return fail("invalid_input", `${field} must be an integer between ${min} and ${max}`);
  return value;
}
export function receipt(value: unknown): string {
  if (typeof value !== "string" || !/^obs_[a-f0-9]{64}$/.test(value)) return fail("invalid_input", "Invalid observation reference");
  return value;
}
export function safePayload(value: unknown): Json {
  const bytes = canonical(value);
  if (Buffer.byteLength(bytes) > MAX_PAYLOAD_BYTES) fail("too_large", "Payload exceeds 64 KiB; chunk it explicitly");
  assertNoSecrets(value);
  return JSON.parse(bytes) as Json;
}
/** Defense in depth, not DLP or an authorization mechanism. */
export function assertNoSecrets(value: unknown): void {
  const bytes = canonical(value);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:github_pat_|ghp_|xox[baprs]-|sk-(?:proj-|ant-)?)[a-zA-Z0-9_-]{16,}|Authorization\s*:\s*Bearer\s+\S+|\bAKIA[A-Z0-9]{16}\b/i.test(bytes))
    fail("sensitive_material", "Credential-shaped material must not enter memory");
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (/^(?:authorization|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)$/i.test(k)
          && x !== null && x !== "" && x !== "[REDACTED]") fail("sensitive_material", "Credential fields must be removed before admission");
      walk(x);
    }
  };
  walk(value);
}
export function rememberInput(value: unknown): RememberInput {
  const v = object(value, ["subject", "title", "type", "payload", "kind", "supersedes", "observedAt", "ttlSeconds", "validFrom", "validTo", "supports", "dependsOn", "links"]);
  text(v.subject, "subject"); text(v.title, "title", 1000); text(v.type, "type", 80);
  safePayload(v.payload);
  assertNoSecrets(v);
  if (v.kind !== undefined && !["fact", "episode", "skill", "entity"].includes(String(v.kind))) fail("invalid_input", "Unknown memory kind");
  if (v.supersedes !== undefined) receipt(v.supersedes);
  for (const k of ["observedAt", "validFrom", "validTo"] as const) if (v[k] !== undefined) number(v[k], k, 0, 8640000000000000);
  if (v.validFrom !== undefined && v.validTo !== undefined && Number(v.validTo) <= Number(v.validFrom)) fail("invalid_input", "validTo must be after validFrom");
  if (v.ttlSeconds !== undefined) number(v.ttlSeconds, "ttlSeconds", 0, 31536000);
  for (const k of ["supports", "dependsOn"] as const) if (v[k] !== undefined) {
    if (!Array.isArray(v[k]) || v[k].length > 16) fail("invalid_input", `${k} must contain at most 16 references`);
    (v[k] as unknown[]).forEach(receipt);
  }
  if (v.links !== undefined) {
    if (!Array.isArray(v.links) || v.links.length > 16) fail("invalid_input", "links must contain at most 16 entries");
    for (const link of v.links as unknown[]) {
      const l = object(link, ["subject", "relation"]); text(l.subject, "link.subject"); text(l.relation, "link.relation", 80);
    }
  }
  return clone(v) as unknown as RememberInput;
}
export function sourceInput(value: unknown): SourceInput {
  const v = object(value, ["id", "namespace", "type", "resolver", "locator", "format", "ttlSeconds", "kind", "schema"]);
  text(v.id, "id", 160); text(v.namespace, "namespace"); text(v.type, "type", 80); text(v.locator, "locator", 4096);
  if (!["file", "adapter"].includes(String(v.resolver))) fail("invalid_input", "Only file and host-owned adapter resolvers are supported");
  if (!["json", "jsonl", "text"].includes(String(v.format))) fail("invalid_input", "format must be json, jsonl, or text");
  number(v.ttlSeconds, "ttlSeconds", 0, 31536000);
  if (v.kind !== undefined && !["fact", "episode", "skill", "entity"].includes(String(v.kind))) fail("invalid_input", "Unknown memory kind");
  if (v.schema !== undefined) {
    const s = object(v.schema, ["id", "title", "status"]);
    Object.entries(s).forEach(([k, x]) => text(x, `schema.${k}`, 80));
  }
  assertNoSecrets(v);
  return clone(v) as unknown as SourceInput;
}
export function sourceCoverage(value: unknown): SourceCoverage {
  const v = object(value, ["complete", "reasons", "nextAfter"]);
  if (typeof v.complete !== "boolean" || !Array.isArray(v.reasons) || v.reasons.length > 8) fail("invalid_input", "Invalid source coverage");
  for (const reason of v.reasons as unknown[]) {
    if (!/^[a-z_]+$/.test(text(reason, "coverage reason", 80))) fail("invalid_input", "Coverage reasons must be codes");
  }
  if (v.complete !== ((v.reasons as string[]).length === 0)) fail("invalid_input", "Source coverage and reasons disagree");
  if (v.nextAfter !== undefined) number(v.nextAfter, "nextAfter", 0, Number.MAX_SAFE_INTEGER);
  return clone(v) as unknown as SourceCoverage;
}
export function recallInput(value: unknown): RecallInput {
  const v = object(value, ["search", "subject", "type", "kind", "asOf", "limit", "maxBytes", "maxCandidates", "maxNodes", "depth", "includeStale"]);
  if (v.search !== undefined && v.search !== "") text(v.search, "search", 1000);
  if (v.subject !== undefined) text(v.subject, "subject");
  if (v.type !== undefined) text(v.type, "type", 80);
  if (v.kind !== undefined && !["fact", "episode", "skill", "entity"].includes(String(v.kind))) fail("invalid_input", "Unknown memory kind");
  if (v.asOf !== undefined) number(v.asOf, "asOf", 0, 8640000000000000);
  for (const [k, min, max] of [["limit", 1, 100], ["maxBytes", 512, 262144], ["maxCandidates", 1, 10000], ["maxNodes", 1, 500], ["depth", 0, 4]] as const)
    if (v[k] !== undefined) number(v[k], k, min, max);
  if (v.includeStale !== undefined && typeof v.includeStale !== "boolean") fail("invalid_input", "includeStale must be boolean");
  return clone(v) as unknown as RecallInput;
}
