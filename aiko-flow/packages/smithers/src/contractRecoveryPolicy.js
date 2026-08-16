/**
 * Pure operational recovery policy for the Smithers/Contract boundary.
 *
 * This module decides admission, scheduling, and transport recovery only. It
 * deliberately has no journal writer and cannot interpret task outcomes.
 */

export const FAILURE_CLASSES = Object.freeze({
  RETRYABLE: "retryable",
  PERMANENT: "permanent",
  UNCERTAIN: "uncertain",
});

export const RECEIPT_STATES = Object.freeze({
  RECEIVED: "received",
  DURABLY_ACCEPTED: "durably_accepted",
  ACKNOWLEDGED: "acknowledged",
});

const FAILURE_SET = new Set(Object.values(FAILURE_CLASSES));
const RECEIPT_SET = new Set(Object.values(RECEIPT_STATES));

export function defineRecoveryLimits(input = {}) {
  const limits = {
    maxAttempts: input.maxAttempts ?? 5,
    maxQueue: input.maxQueue ?? 1_000,
    maxInFlight: input.maxInFlight ?? 32,
    maxTenantInFlight: input.maxTenantInFlight ?? 4,
    maxRootInFlight: input.maxRootInFlight ?? 1,
    baseDelayMs: input.baseDelayMs ?? 250,
    maxDelayMs: input.maxDelayMs ?? 30_000,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.baseDelayMs > limits.maxDelayMs) {
    throw new RangeError("baseDelayMs must not exceed maxDelayMs");
  }
  return Object.freeze(limits);
}

export function classifyFailure(value) {
  if (!FAILURE_SET.has(value)) {
    return Object.freeze({ accepted: false, reason: "unknown_failure_class" });
  }
  return Object.freeze({ accepted: true, failureClass: value });
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

export function immutableAttemptIdentity(input) {
  const identity = {
    tenantId: requireString(input?.tenantId, "tenantId"),
    rootId: requireString(input?.rootId, "rootId"),
    operationId: requireString(input?.operationId, "operationId"),
    attempt: input?.attempt,
  };
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1) {
    throw new TypeError("attempt must be a positive safe integer");
  }
  return Object.freeze(identity);
}

// FNV-1a over an explicitly ordered identity is stable across processes. The
// derived spread is not entropy and therefore cannot change a replay identity.
function identityHash(identity) {
  const text = `${identity.tenantId}\u001f${identity.rootId}\u001f${identity.operationId}\u001f${identity.attempt}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function deterministicBackoff(attemptInput, limitsInput = {}) {
  const identity = immutableAttemptIdentity(attemptInput);
  const limits = defineRecoveryLimits(limitsInput);
  // Clamp the exponent before arithmetic so even hostile attempt values cannot
  // overflow or evade the configured cap.
  const exponent = Math.min(identity.attempt - 1, 30);
  const exponential = Math.min(limits.maxDelayMs, limits.baseDelayMs * 2 ** exponent);
  const floor = Math.floor(exponential / 2);
  const spread = exponential - floor;
  return floor + (identityHash(identity) % (spread + 1));
}

export function recoveryDecision(failureClass, attemptInput, limitsInput = {}) {
  const classified = classifyFailure(failureClass);
  if (!classified.accepted) return classified;
  const identity = immutableAttemptIdentity(attemptInput);
  const limits = defineRecoveryLimits(limitsInput);

  if (failureClass === FAILURE_CLASSES.UNCERTAIN) {
    return Object.freeze({ action: "reconcile", method: "read_back", reason: "effect_uncertain" });
  }
  if (failureClass === FAILURE_CLASSES.PERMANENT) {
    return Object.freeze({ action: "refuse_retry", reason: "permanent_failure" });
  }
  if (identity.attempt >= limits.maxAttempts) {
    return Object.freeze({ action: "refuse_retry", reason: "attempt_budget_exhausted" });
  }
  return Object.freeze({
    action: "retry",
    nextAttempt: identity.attempt + 1,
    delayMs: deterministicBackoff(identity, limits),
  });
}

function countsFor(active = []) {
  const tenant = new Map();
  const root = new Map();
  for (const item of active) {
    tenant.set(item.tenantId, (tenant.get(item.tenantId) ?? 0) + 1);
    root.set(item.rootId, (root.get(item.rootId) ?? 0) + 1);
  }
  return { tenant, root };
}

export function admitToQueue(queue, item, limitsInput = {}) {
  const limits = defineRecoveryLimits(limitsInput);
  if (!Array.isArray(queue)) throw new TypeError("queue must be an array");
  if (queue.length >= limits.maxQueue) {
    return Object.freeze({ accepted: false, reason: "queue_overloaded", queue });
  }
  immutableAttemptIdentity(item);
  return Object.freeze({ accepted: true, queue: Object.freeze([...queue, Object.freeze({ ...item })]) });
}

function rotateAfter(values, previous) {
  if (values.length === 0) return values;
  const at = values.indexOf(previous);
  if (at < 0) return values;
  return [...values.slice(at + 1), ...values.slice(0, at + 1)];
}

/**
 * Hierarchical round-robin: tenant first, then root within that tenant.
 * Cursors are returned to the caller and must be persisted with its own
 * operational state; selection itself performs no writes.
 */
export function selectFair(queue, active = [], limitsInput = {}, cursor = {}) {
  const limits = defineRecoveryLimits(limitsInput);
  if (!Array.isArray(queue) || !Array.isArray(active)) throw new TypeError("queue and active must be arrays");
  if (active.length >= limits.maxInFlight) {
    return Object.freeze({ selected: null, reason: "global_concurrency_full", cursor: Object.freeze({ ...cursor }) });
  }
  const counts = countsFor(active);
  const tenants = rotateAfter([...new Set(queue.map((x) => x.tenantId))].sort(), cursor.tenantId);

  for (const tenantId of tenants) {
    if ((counts.tenant.get(tenantId) ?? 0) >= limits.maxTenantInFlight) continue;
    const tenantItems = queue.filter((x) => x.tenantId === tenantId);
    const roots = rotateAfter([...new Set(tenantItems.map((x) => x.rootId))].sort(), cursor.roots?.[tenantId]);
    for (const rootId of roots) {
      if ((counts.root.get(rootId) ?? 0) >= limits.maxRootInFlight) continue;
      const index = queue.findIndex((x) => x.tenantId === tenantId && x.rootId === rootId);
      const rootsCursor = Object.freeze({ ...(cursor.roots ?? {}), [tenantId]: rootId });
      return Object.freeze({
        selected: queue[index],
        index,
        reason: "selected",
        cursor: Object.freeze({ tenantId, roots: rootsCursor }),
      });
    }
  }
  return Object.freeze({ selected: null, reason: "concurrency_full", cursor: Object.freeze({ ...cursor }) });
}

export function receiptTransition(state, event) {
  if (!RECEIPT_SET.has(state)) return Object.freeze({ accepted: false, reason: "unknown_receipt_state", state });
  if (event === "drop") return Object.freeze({ accepted: false, reason: "drop_forbidden", state });
  if (event === "ack") {
    if (state !== RECEIPT_STATES.DURABLY_ACCEPTED) {
      return Object.freeze({ accepted: false, reason: "durable_accept_required", state });
    }
    return Object.freeze({ accepted: true, state: RECEIPT_STATES.ACKNOWLEDGED });
  }
  if (event === "durable_accept" && state === RECEIPT_STATES.RECEIVED) {
    return Object.freeze({ accepted: true, state: RECEIPT_STATES.DURABLY_ACCEPTED });
  }
  return Object.freeze({ accepted: false, reason: "invalid_receipt_transition", state });
}
