import { randomUUID } from "node:crypto";

const OWN = Object.prototype.hasOwnProperty;
const FORBIDDEN_KEYS = new Set([
  "id", "endpointId", "tenant", "tenantId", "subject", "authenticatedSubject",
  "generation", "endpointGeneration", "status", "createdAt", "updatedAt",
  "rawBody", "body", "payload", "secret", "secretBytes", "secretValue",
  "store", "db", "record", "row", "occurrenceId", "contractRoot",
]);
const CREATE_KEYS = new Set([
  "provider", "audience", "route", "methods", "contentType", "bodyLimitBytes",
  "credentialHandle", "replayWindowSeconds", "contractTemplate", "requiredScopes",
]);
const ROTATE_KEYS = new Set(["expectedGeneration", "credentialHandle"]);
const CAS_KEYS = new Set(["expectedGeneration"]);
const STATES = new Set(["active", "paused", "revoked"]);

export class WebhookLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebhookLifecycleError";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new WebhookLifecycleError(code, message);
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("INVALID", `${name} must be an object`);
  return value;
}
function closed(value, allowed, name) {
  object(value, name);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) refuse("CALLER_AUTHORITY", `${name}.${key} is not caller-controlled`);
    if (!allowed.has(key)) refuse("CLOSED_BINDING", `${name}.${key} is not admitted`);
  }
}
function text(value, name, pattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/) {
  if (typeof value !== "string" || !pattern.test(value)) refuse("INVALID", `${name} is invalid`);
  return value;
}
function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) refuse("INVALID", `${name} is invalid`);
  return value;
}
function strings(value, name, normalise = (x) => x) {
  if (!Array.isArray(value) || value.length === 0) refuse("INVALID", `${name} must be a non-empty array`);
  const result = value.map((x, i) => normalise(text(x, `${name}[${i}]`)));
  if (new Set(result).size !== result.length) refuse("INVALID", `${name} contains duplicates`);
  return Object.freeze([...result].sort());
}
function authority(value) {
  object(value, "authority");
  const tenantId = text(value.verifiedTenant, "authority.verifiedTenant");
  const subject = text(value.authenticatedSubject, "authority.authenticatedSubject");
  const scopes = new Set(strings(value.grantedScopes, "authority.grantedScopes"));
  return { tenantId, subject, scopes };
}
function credential(value, name = "credentialHandle") {
  object(value, name);
  const keys = Object.keys(value);
  if (keys.length !== 2 || !OWN.call(value, "handle") || !OWN.call(value, "generation")) {
    refuse("CLOSED_BINDING", `${name} must contain only handle and generation`);
  }
  return Object.freeze({
    handle: text(value.handle, `${name}.handle`, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/),
    generation: integer(value.generation, `${name}.generation`, 1),
  });
}
function template(value) {
  object(value, "contractTemplate");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !OWN.call(value, "name") || !OWN.call(value, "generation")) {
    refuse("CLOSED_BINDING", "contractTemplate must contain only name and generation");
  }
  return Object.freeze({
    name: text(value.name, "contractTemplate.name"),
    generation: integer(value.generation, "contractTemplate.generation", 1),
  });
}
function storedBindings(input, name = "Contract projection bindings") {
  closed(input, CREATE_KEYS, name);
  for (const key of CREATE_KEYS) if (!OWN.call(input, key)) refuse("PROJECTION_VIOLATION", `${name}.${key} is required`);
  const requiredScopes = strings(input.requiredScopes, `${name}.requiredScopes`);
  const methods = strings(input.methods, `${name}.methods`, (x) => x.toUpperCase());
  for (const method of methods) if (!/^(POST|PUT|PATCH)$/.test(method)) refuse("CLOSED_BINDING", `method is not admitted: ${method}`);
  const route = text(input.route, `${name}.route`, /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,254}$/);
  if (route.includes("*") || route.includes("//") || route.includes("..")) refuse("CLOSED_BINDING", "route must be fixed");
  return Object.freeze({
    provider: text(input.provider, `${name}.provider`),
    audience: text(input.audience, `${name}.audience`, /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/),
    route,
    methods,
    contentType: text(input.contentType, `${name}.contentType`, /^application\/[A-Za-z0-9.+-]+$/),
    bodyLimitBytes: integer(input.bodyLimitBytes, `${name}.bodyLimitBytes`, 1, 10 * 1024 * 1024),
    credentialHandle: credential(input.credentialHandle, `${name}.credentialHandle`),
    replayWindowSeconds: integer(input.replayWindowSeconds, `${name}.replayWindowSeconds`, 1, 86400),
    contractTemplate: template(input.contractTemplate),
    requiredScopes,
  });
}
function createBindings(input, actor) {
  const bindings = storedBindings(input, "declaration");
  for (const scope of bindings.requiredScopes) if (!actor.scopes.has(scope)) refuse("SCOPE_WIDENING", `scope is not granted: ${scope}`);
  return bindings;
}
function assertRecord(record, tenantId, endpointId) {
  if (!record) refuse("NOT_FOUND", "webhook endpoint not found");
  object(record, "Contract projection");
  if (record.tenantId !== tenantId || record.endpointId !== endpointId) refuse("PROJECTION_VIOLATION", "Contract projection escaped tenant or endpoint scope");
  if (!STATES.has(record.status) || !Number.isSafeInteger(record.endpointGeneration)) refuse("PROJECTION_VIOLATION", "Contract projection is malformed");
  return record;
}
function project(record) {
  const b = storedBindings(record.bindings);
  return Object.freeze({
    endpointId: record.endpointId,
    tenantId: record.tenantId,
    status: record.status,
    endpointGeneration: record.endpointGeneration,
    provider: b.provider,
    audience: b.audience,
    route: b.route,
    methods: Object.freeze([...b.methods]),
    contentType: b.contentType,
    bodyLimitBytes: b.bodyLimitBytes,
    credentialHandle: Object.freeze({ handle: b.credentialHandle.handle, generation: b.credentialHandle.generation }),
    replayWindowSeconds: b.replayWindowSeconds,
    contractTemplate: Object.freeze({ ...b.contractTemplate }),
    requiredScopes: Object.freeze([...b.requiredScopes]),
  });
}

/** Pure lifecycle policy over Contract. `read` is the only projection and `command` the only writer. */
export function createContractWebhookLifecycle({ contract, allocateEndpointId = () => `wh_${randomUUID()}` } = {}) {
  if (!contract || typeof contract.read !== "function" || typeof contract.command !== "function") refuse("INVALID_INTERFACE", "Contract read/command interface is required");
  if (typeof allocateEndpointId !== "function") refuse("INVALID_INTERFACE", "endpoint allocator is required");

  const readOne = async (actor, endpointId) => assertRecord(
    await contract.read({ projection: "webhook_endpoint", tenantId: actor.tenantId, endpointId }), actor.tenantId, endpointId,
  );
  const after = async (actor, endpointId, generation) => {
    const record = await readOne(actor, endpointId);
    if (record.endpointGeneration !== generation) refuse("READBACK_MISMATCH", "Contract command was not independently projected");
    return project(record);
  };

  return Object.freeze({
    async create(verifiedAuthority, declaration) {
      const actor = authority(verifiedAuthority);
      const bindings = createBindings(declaration, actor);
      const endpointId = text(await allocateEndpointId(), "allocated endpoint ID", /^wh_[A-Za-z0-9-]{16,255}$/);
      await contract.command({
        type: "webhook_endpoint.create", tenantId: actor.tenantId, endpointId,
        authenticatedSubject: actor.subject, expectedGeneration: 0,
        next: { tenantId: actor.tenantId, endpointId, status: "active", endpointGeneration: 1, bindings },
      });
      return after(actor, endpointId, 1);
    },
    async list(verifiedAuthority) {
      const actor = authority(verifiedAuthority);
      const records = await contract.read({ projection: "webhook_endpoints", tenantId: actor.tenantId });
      if (!Array.isArray(records)) refuse("PROJECTION_VIOLATION", "Contract list projection is malformed");
      return Object.freeze(records.map((r) => project(assertRecord(r, actor.tenantId, r?.endpointId))));
    },
    async inspect(verifiedAuthority, endpointId) {
      const actor = authority(verifiedAuthority);
      endpointId = text(endpointId, "endpointId", /^wh_[A-Za-z0-9-]{16,255}$/);
      return project(await readOne(actor, endpointId));
    },
    async rotate(verifiedAuthority, endpointId, input) {
      const actor = authority(verifiedAuthority);
      endpointId = text(endpointId, "endpointId", /^wh_[A-Za-z0-9-]{16,255}$/);
      closed(input, ROTATE_KEYS, "rotation");
      const expected = integer(input.expectedGeneration, "expectedGeneration", 1);
      const old = await readOne(actor, endpointId);
      if (old.status !== "active") refuse("FENCED", "only an active endpoint can rotate");
      if (old.endpointGeneration !== expected) refuse("CAS_CONFLICT", "stale endpoint generation");
      const nextCredential = credential(input.credentialHandle, "rotation.credentialHandle");
      if (nextCredential.generation !== old.bindings.credentialHandle.generation + 1) refuse("CREDENTIAL_FENCE", "credential generation must increment exactly once");
      const nextGeneration = expected + 1;
      await contract.command({
        type: "webhook_endpoint.rotate", tenantId: actor.tenantId, endpointId,
        authenticatedSubject: actor.subject, expectedGeneration: expected,
        next: { tenantId: actor.tenantId, endpointId, status: "active", endpointGeneration: nextGeneration, bindings: { ...storedBindings(old.bindings), credentialHandle: nextCredential } },
      });
      return after(actor, endpointId, nextGeneration);
    },
    async pause(verifiedAuthority, endpointId, input) {
      return transition(verifiedAuthority, endpointId, input, "paused");
    },
    async revoke(verifiedAuthority, endpointId, input) {
      return transition(verifiedAuthority, endpointId, input, "revoked");
    },
    async authorizeGeneration(verifiedAuthority, endpointId, { endpointGeneration, credentialGeneration } = {}) {
      const actor = authority(verifiedAuthority);
      endpointId = text(endpointId, "endpointId", /^wh_[A-Za-z0-9-]{16,255}$/);
      const record = await readOne(actor, endpointId);
      if (record.status !== "active" || record.endpointGeneration !== endpointGeneration || record.bindings.credentialHandle.generation !== credentialGeneration) {
        refuse("FENCED", "endpoint or credential generation is no longer active");
      }
      return project(record);
    },
  });

  async function transition(verifiedAuthority, endpointId, input, status) {
    const actor = authority(verifiedAuthority);
    endpointId = text(endpointId, "endpointId", /^wh_[A-Za-z0-9-]{16,255}$/);
    closed(input, CAS_KEYS, status);
    const expected = integer(input.expectedGeneration, "expectedGeneration", 1);
    const old = await readOne(actor, endpointId);
    if (old.endpointGeneration !== expected) refuse("CAS_CONFLICT", "stale endpoint generation");
    if (old.status === "revoked") refuse("FENCED", "revocation is terminal");
    if (status === "paused" && old.status !== "active") refuse("FENCED", "only an active endpoint can pause");
    const nextGeneration = expected + 1;
    await contract.command({
      type: `webhook_endpoint.${status === "paused" ? "pause" : "revoke"}`,
      tenantId: actor.tenantId, endpointId, authenticatedSubject: actor.subject,
      expectedGeneration: expected, next: { tenantId: actor.tenantId, endpointId, status, endpointGeneration: nextGeneration, bindings: storedBindings(old.bindings) },
    });
    return after(actor, endpointId, nextGeneration);
  }
}
