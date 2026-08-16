import { randomUUID } from "node:crypto";

const OWN = Object.prototype.hasOwnProperty;
const PHASES = new Set(["runnable", "active", "paused", "cancelled", "settled", "invalidated"]);
const PIN_KINDS = ["graph", "input", "cell", "limb", "credential"];

export class ContractLifecyclePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractLifecyclePolicyError";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new ContractLifecyclePolicyError(code, message);
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("INVALID", `${name} must be an object`);
  return value;
}
function text(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value)) refuse("INVALID", `${name} is invalid`);
  return value;
}
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) refuse("INVALID", `${name} is invalid`);
  return value;
}
function closed(value, keys, name) {
  object(value, name);
  for (const key of Object.keys(value)) if (!keys.has(key)) refuse("CLOSED_BINDING", `${name}.${key} is not admitted`);
}
function authority(value) {
  object(value, "authority");
  const tenantId = text(value.verifiedTenant, "authority.verifiedTenant");
  const ownerId = text(value.verifiedOwner, "authority.verifiedOwner");
  if (!Array.isArray(value.grantedScopes) || !value.grantedScopes.every((scope) => typeof scope === "string")) {
    refuse("INVALID", "authority.grantedScopes is invalid");
  }
  if (!new Set(value.grantedScopes).has("run:write")) refuse("FORBIDDEN", "run:write is required");
  return { tenantId, ownerId };
}
function assertRun(record, actor, runId) {
  if (!record) refuse("NOT_FOUND", "run not found");
  object(record, "Contract run projection");
  if (record.tenantId !== actor.tenantId) refuse("TENANT_MISMATCH", "run escaped verified tenant");
  if (record.ownerId !== actor.ownerId) refuse("OWNER_MISMATCH", "run is owned by another principal");
  if (record.runId !== runId || !PHASES.has(record.phase)) refuse("PROJECTION_VIOLATION", "Contract run projection is malformed");
  integer(record.lifecycleGeneration, "Contract run lifecycleGeneration", 1);
  text(record.contractRoot, "Contract run contractRoot");
  if (!Array.isArray(record.pins)) refuse("PROJECTION_VIOLATION", "Contract run pins are malformed");
  return record;
}
function normalizedPins(pins) {
  const result = [];
  const identities = new Set();
  for (const [index, value] of pins.entries()) {
    object(value, `pin[${index}]`);
    const pin = {
      kind: text(value.kind, `pin[${index}].kind`),
      id: text(value.id, `pin[${index}].id`),
      digest: text(value.digest, `pin[${index}].digest`),
      generation: integer(value.generation, `pin[${index}].generation`, 1),
    };
    if (!PIN_KINDS.includes(pin.kind)) refuse("PROJECTION_VIOLATION", `unknown pin kind: ${pin.kind}`);
    const identity = `${pin.kind}\0${pin.id}`;
    if (identities.has(identity)) refuse("PROJECTION_VIOLATION", "duplicate pin identity");
    identities.add(identity);
    result.push(Object.freeze(pin));
  }
  for (const required of ["graph", "input", "cell"]) {
    if (!result.some((pin) => pin.kind === required)) refuse("PROJECTION_VIOLATION", `run lacks ${required} pin`);
  }
  return Object.freeze(result);
}
function projectedRun(record) {
  return Object.freeze({
    tenantId: record.tenantId,
    ownerId: record.ownerId,
    contractRoot: record.contractRoot,
    runId: record.runId,
    phase: record.phase,
    lifecycleGeneration: record.lifecycleGeneration,
    pins: normalizedPins(record.pins),
  });
}

/** Contract-owned lifecycle policy. Contract read/command are its only authority. */
export function createContractLifecyclePolicy({ contract, allocateForkRunId = () => `fork_${randomUUID()}` } = {}) {
  if (!contract || typeof contract.read !== "function" || typeof contract.command !== "function") {
    refuse("INVALID_INTERFACE", "Contract read/command interface is required");
  }
  if (typeof allocateForkRunId !== "function") refuse("INVALID_INTERFACE", "fork allocator is required");

  const readRun = async (actor, runId) => assertRun(
    await contract.read({ projection: "execution_run", tenantId: actor.tenantId, runId }), actor, runId,
  );
  const readBack = async (actor, old, generation, phase = undefined) => {
    const fresh = await readRun(actor, old.runId);
    if (fresh.contractRoot !== old.contractRoot || fresh.runId !== old.runId) refuse("IDENTITY_MISMATCH", "Contract changed run identity");
    if (fresh.lifecycleGeneration !== generation || (phase && fresh.phase !== phase)) refuse("READBACK_MISMATCH", "Contract command was not independently projected");
    return projectedRun(fresh);
  };
  const cas = (record, expected) => {
    integer(expected, "expectedGeneration", 1);
    if (record.lifecycleGeneration !== expected) refuse("CAS_CONFLICT", "stale lifecycle generation");
  };
  const mutable = (record) => {
    if (record.phase === "cancelled") refuse("CANCELLED", "cancellation is terminal");
    if (record.phase === "settled") refuse("SETTLED", "settlement is terminal");
  };

  return Object.freeze({
    async inspect(verifiedAuthority, runId) {
      const actor = authority(verifiedAuthority);
      runId = text(runId, "runId");
      return projectedRun(await readRun(actor, runId));
    },

    async claim(verifiedAuthority, runId, input) {
      const actor = authority(verifiedAuthority);
      runId = text(runId, "runId");
      closed(input, new Set(["expectedGeneration", "nodeId"]), "claim");
      const record = await readRun(actor, runId);
      cas(record, input.expectedGeneration);
      if (record.phase === "paused") refuse("PAUSED", "new claims are blocked while paused");
      mutable(record);
      if (record.phase !== "runnable" && record.phase !== "active") refuse("NOT_RUNNABLE", "run cannot accept a claim");
      const nodeId = text(input.nodeId, "claim.nodeId");
      return contract.command({
        type: "execution.claim", tenantId: actor.tenantId, ownerId: actor.ownerId,
        contractRoot: record.contractRoot, runId, expectedGeneration: record.lifecycleGeneration, nodeId,
      });
    },

    async pause(verifiedAuthority, runId, input) {
      const actor = authority(verifiedAuthority);
      runId = text(runId, "runId");
      closed(input, new Set(["expectedGeneration"]), "pause");
      const record = await readRun(actor, runId);
      cas(record, input.expectedGeneration);
      mutable(record);
      if (record.phase === "paused") refuse("PAUSED", "run is already paused");
      const activeClaims = Array.isArray(record.activeClaims) ? record.activeClaims : [];
      const claims = activeClaims.map((claim, index) => {
        object(claim, `activeClaims[${index}]`);
        return Object.freeze({
          claimId: text(claim.claimId, `activeClaims[${index}].claimId`),
          instruction: claim.crossed === true ? "drain" : "park",
        });
      });
      const nextGeneration = record.lifecycleGeneration + 1;
      await contract.command({
        type: "execution.pause", tenantId: actor.tenantId, ownerId: actor.ownerId,
        contractRoot: record.contractRoot, runId, expectedGeneration: record.lifecycleGeneration,
        next: { ...projectedRun(record), phase: "paused", lifecycleGeneration: nextGeneration },
        claims,
      });
      return Object.freeze({ run: await readBack(actor, record, nextGeneration, "paused"), newClaims: "blocked", claims: Object.freeze(claims) });
    },

    async resume(verifiedAuthority, runId, input) {
      const actor = authority(verifiedAuthority);
      runId = text(runId, "runId");
      closed(input, new Set(["expectedGeneration"]), "resume");
      const record = await readRun(actor, runId);
      cas(record, input.expectedGeneration);
      mutable(record);
      if (record.phase !== "paused") refuse("NOT_PAUSED", "only a paused run can resume");
      const pins = normalizedPins(record.pins);
      const receipts = [];
      for (const pin of pins) {
        const receipt = await contract.read({
          projection: "pin_validity", tenantId: actor.tenantId, ownerId: actor.ownerId,
          contractRoot: record.contractRoot, runId, ...pin,
        });
        if (!receipt || receipt.valid !== true || receipt.tenantId !== actor.tenantId || receipt.runId !== runId ||
            receipt.kind !== pin.kind || receipt.id !== pin.id || receipt.digest !== pin.digest || receipt.generation !== pin.generation) {
          refuse("PIN_MOVED", `${pin.kind} pin ${pin.id} did not revalidate`);
        }
        receipts.push(Object.freeze({ ...pin, valid: true }));
      }
      const nextGeneration = record.lifecycleGeneration + 1;
      await contract.command({
        type: "execution.resume", tenantId: actor.tenantId, ownerId: actor.ownerId,
        contractRoot: record.contractRoot, runId, expectedGeneration: record.lifecycleGeneration,
        next: { ...projectedRun(record), phase: "runnable", lifecycleGeneration: nextGeneration },
        revalidatedPins: receipts,
      });
      return readBack(actor, record, nextGeneration, "runnable");
    },

    async cancel(verifiedAuthority, runId, input) {
      const actor = authority(verifiedAuthority);
      runId = text(runId, "runId");
      closed(input, new Set(["expectedGeneration", "reason"]), "cancel");
      const record = await readRun(actor, runId);
      cas(record, input.expectedGeneration);
      mutable(record);
      const nextGeneration = record.lifecycleGeneration + 1;
      await contract.command({
        type: "execution.cancel", tenantId: actor.tenantId, ownerId: actor.ownerId,
        contractRoot: record.contractRoot, runId, expectedGeneration: record.lifecycleGeneration,
        reason: text(input.reason, "cancel.reason"),
        next: { ...projectedRun(record), phase: "cancelled", lifecycleGeneration: nextGeneration },
      });
      return readBack(actor, record, nextGeneration, "cancelled");
    },

    async revoke(verifiedAuthority, runId, input) {
      const actor = authority(verifiedAuthority);
      runId = text(runId, "runId");
      closed(input, new Set(["kind", "id", "expectedGeneration", "reason"]), "revoke");
      const record = await readRun(actor, runId);
      mutable(record);
      if (input.kind !== "tool" && input.kind !== "credential") refuse("INVALID", "only a tool or credential can be revoked");
      const id = text(input.id, "revoke.id");
      const expectedGeneration = integer(input.expectedGeneration, "revoke.expectedGeneration", 1);
      const pin = await contract.read({ projection: "capability_generation", tenantId: actor.tenantId, ownerId: actor.ownerId, runId, kind: input.kind, id });
      if (!pin || pin.tenantId !== actor.tenantId || pin.runId !== runId || pin.kind !== input.kind || pin.id !== id) refuse("PROJECTION_VIOLATION", "capability projection escaped scope");
      if (pin.revoked === true) refuse("REVOKED", "revocation is terminal");
      if (pin.generation !== expectedGeneration) refuse("CAS_CONFLICT", "stale capability generation");
      await contract.command({
        type: "capability.revoke", tenantId: actor.tenantId, ownerId: actor.ownerId, contractRoot: record.contractRoot, runId,
        kind: input.kind, id, expectedGeneration, nextGeneration: expectedGeneration + 1,
        reason: text(input.reason, "revoke.reason"), appendOnly: true,
      });
      return Object.freeze({ kind: input.kind, id, generation: expectedGeneration + 1, revoked: true });
    },

    async semanticRollback(verifiedAuthority, runId, input) {
      const actor = authority(verifiedAuthority);
      runId = text(runId, "runId");
      closed(input, new Set(["expectedGeneration", "targetOccurrenceId", "reason"]), "semanticRollback");
      const record = await readRun(actor, runId);
      cas(record, input.expectedGeneration);
      mutable(record);
      const targetOccurrenceId = text(input.targetOccurrenceId, "semanticRollback.targetOccurrenceId");
      const boundary = await contract.read({ projection: "settlement_boundary", tenantId: actor.tenantId, ownerId: actor.ownerId, runId, targetOccurrenceId });
      if (!boundary || boundary.tenantId !== actor.tenantId || boundary.runId !== runId || !Array.isArray(boundary.settlements)) refuse("PROJECTION_VIOLATION", "settlement boundary is malformed");
      const occurrences = [{ kind: "invalidation", targetOccurrenceId, reason: text(input.reason, "semanticRollback.reason") }];
      for (const settlement of boundary.settlements) {
        object(settlement, "settlement");
        if (settlement.crossed === true) occurrences.push({ kind: "compensation", settlementId: text(settlement.settlementId, "settlement.settlementId"), resend: false });
      }
      await contract.command({
        type: "execution.semantic_rollback", tenantId: actor.tenantId, ownerId: actor.ownerId,
        contractRoot: record.contractRoot, runId, expectedGeneration: record.lifecycleGeneration,
        appendOnly: true, preserveSettlements: true, occurrences,
      });
      return Object.freeze({ targetOccurrenceId, occurrences: Object.freeze(occurrences.map(Object.freeze)) });
    },

    async timeTravelFork(verifiedAuthority, runId, input) {
      const actor = authority(verifiedAuthority);
      runId = text(runId, "runId");
      closed(input, new Set(["expectedGeneration", "frameNo"]), "timeTravelFork");
      const record = await readRun(actor, runId);
      cas(record, input.expectedGeneration);
      mutable(record);
      const childRunId = text(await allocateForkRunId(), "allocated fork runId");
      if (childRunId === runId) refuse("IDENTITY_MISMATCH", "fork must have a new run id");
      await contract.command({
        type: "execution.operational_fork", tenantId: actor.tenantId, ownerId: actor.ownerId,
        contractRoot: record.contractRoot, parentRunId: runId, childRunId,
        expectedGeneration: record.lifecycleGeneration, frameNo: integer(input.frameNo, "timeTravelFork.frameNo"),
        semantics: "operational-only",
      });
      return Object.freeze({ contractRoot: record.contractRoot, parentRunId: runId, childRunId, frameNo: input.frameNo });
    },
  });
}
