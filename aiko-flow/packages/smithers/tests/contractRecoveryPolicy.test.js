import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FAILURE_CLASSES,
  RECEIPT_STATES,
  admitToQueue,
  classifyFailure,
  defineRecoveryLimits,
  deterministicBackoff,
  receiptTransition,
  recoveryDecision,
  selectFair,
} from "../src/contractRecoveryPolicy.js";

const limits = defineRecoveryLimits({
  maxAttempts: 3,
  maxQueue: 3,
  maxInFlight: 3,
  maxTenantInFlight: 2,
  maxRootInFlight: 1,
  baseDelayMs: 100,
  maxDelayMs: 500,
});
const job = (tenantId, rootId, operationId, attempt = 1) => ({ tenantId, rootId, operationId, attempt });

describe("closed recovery classification", () => {
  test("accepts exactly retryable, permanent, and uncertain", () => {
    expect(Object.values(FAILURE_CLASSES).sort()).toEqual(["permanent", "retryable", "uncertain"]);
    for (const value of Object.values(FAILURE_CLASSES)) expect(classifyFailure(value)).toEqual({ accepted: true, failureClass: value });
    for (const mutant of ["success", "timeout", "unknown", "RETRYABLE", "", null, undefined]) {
      expect(classifyFailure(mutant)).toEqual({ accepted: false, reason: "unknown_failure_class" });
    }
  });

  test("only retryable failures can retry and the attempt budget is closed", () => {
    expect(recoveryDecision("retryable", job("t", "r", "op", 1), limits).action).toBe("retry");
    expect(recoveryDecision("retryable", job("t", "r", "op", 2), limits).nextAttempt).toBe(3);
    expect(recoveryDecision("retryable", job("t", "r", "op", 3), limits)).toEqual({
      action: "refuse_retry", reason: "attempt_budget_exhausted",
    });
    expect(recoveryDecision("permanent", job("t", "r", "op"), limits)).toEqual({
      action: "refuse_retry", reason: "permanent_failure",
    });
  });

  test("uncertain effects have exactly the read-back reconciliation route", () => {
    for (const attempt of [1, 2, 3, 99]) {
      expect(recoveryDecision("uncertain", job("t", "r", "op", attempt), limits)).toEqual({
        action: "reconcile", method: "read_back", reason: "effect_uncertain",
      });
    }
  });
});

describe("immutable deterministic backoff", () => {
  test("is stable, identity-derived, and capped without clock or random", () => {
    const identity = job("tenant", "root", "effect", 2);
    const expected = deterministicBackoff(identity, limits);
    const oldNow = Date.now;
    const oldRandom = Math.random;
    Date.now = () => { throw new Error("wall clock entered policy identity"); };
    Math.random = () => { throw new Error("random jitter entered policy identity"); };
    try {
      expect(deterministicBackoff({ ...identity }, limits)).toBe(expected);
      expect(deterministicBackoff(job("tenant", "root", "effect", 1000), limits)).toBeLessThanOrEqual(500);
    } finally {
      Date.now = oldNow;
      Math.random = oldRandom;
    }
  });

  test("attempt identity rejects mutable substitutes and invalid attempts", () => {
    for (const mutant of [
      { ...job("t", "r", "o"), tenantId: "" },
      { ...job("t", "r", "o"), rootId: null },
      { ...job("t", "r", "o"), operationId: undefined },
      job("t", "r", "o", 0), job("t", "r", "o", 1.5),
    ]) expect(() => deterministicBackoff(mutant, limits)).toThrow();
  });
});

describe("bounded queue and fair concurrency", () => {
  test("explicitly refuses queue overload without changing the caller queue", () => {
    const queue = [job("a", "a1", "1"), job("b", "b1", "2"), job("c", "c1", "3")];
    const result = admitToQueue(queue, job("d", "d1", "4"), limits);
    expect(result).toEqual({ accepted: false, reason: "queue_overloaded", queue });
    expect(queue).toHaveLength(3);
  });

  test("never exceeds global, per-tenant, or per-root concurrency", () => {
    const queue = [job("a", "a1", "next"), job("a", "a2", "other"), job("b", "b1", "b")];
    expect(selectFair(queue, [job("x", "x1", "1"), job("y", "y1", "2"), job("z", "z1", "3")], limits).reason)
      .toBe("global_concurrency_full");
    expect(selectFair(queue, [job("a", "live1", "1"), job("a", "live2", "2")], limits).selected.tenantId).toBe("b");
    expect(selectFair([job("a", "a1", "next")], [job("z", "a1", "live")], limits)).toMatchObject({
      selected: null, reason: "concurrency_full",
    });
  });

  test("round-robins tenants and roots instead of serving the hot prefix", () => {
    let cursor = {};
    const queue = [
      job("a", "a1", "a-hot-1"), job("a", "a1", "a-hot-2"), job("a", "a2", "a-root-2"),
      job("b", "b1", "b-one"), job("c", "c1", "c-one"),
    ];
    const tenants = [];
    for (let i = 0; i < 6; i += 1) {
      const pick = selectFair(queue, [], limits, cursor);
      tenants.push(pick.selected.tenantId);
      cursor = pick.cursor;
    }
    expect(tenants).toEqual(["a", "b", "c", "a", "b", "c"]);

    cursor = {};
    const roots = [];
    for (let i = 0; i < 4; i += 1) {
      const pick = selectFair(queue.filter((x) => x.tenantId === "a"), [], limits, cursor);
      roots.push(pick.selected.rootId);
      cursor = pick.cursor;
    }
    expect(roots).toEqual(["a1", "a2", "a1", "a2"]);
  });
});

describe("durable acceptance owns ACK ordering", () => {
  test("refuses early ACK and every drop transition", () => {
    expect(receiptTransition(RECEIPT_STATES.RECEIVED, "ack")).toEqual({
      accepted: false, reason: "durable_accept_required", state: "received",
    });
    for (const state of Object.values(RECEIPT_STATES)) {
      expect(receiptTransition(state, "drop")).toEqual({ accepted: false, reason: "drop_forbidden", state });
    }
  });

  test("permits ACK only after durable acceptance", () => {
    const accepted = receiptTransition(RECEIPT_STATES.RECEIVED, "durable_accept");
    expect(accepted).toEqual({ accepted: true, state: "durably_accepted" });
    expect(receiptTransition(accepted.state, "ack")).toEqual({ accepted: true, state: "acknowledged" });
    expect(receiptTransition("acknowledged", "ack").accepted).toBe(false);
  });
});

describe("falsifier mutation guard", () => {
  test("public kernel exposes decisions, not a semantic outcome or a second ledger", async () => {
    const module = await import("../src/contractRecoveryPolicy.js");
    const forbiddenExports = Object.keys(module).filter((name) => /settle|satisf|ledger|journal|write/i.test(name));
    expect(forbiddenExports).toEqual([]);
    const source = readFileSync(new URL("../src/contractRecoveryPolicy.js", import.meta.url), "utf8");
    expect(source).not.toContain("Date.now(");
    expect(source).not.toContain("Math.random(");
  });

  test("invalid limit mutations fail closed", () => {
    for (const mutant of [
      { maxAttempts: 0 }, { maxQueue: -1 }, { maxInFlight: Infinity },
      { maxTenantInFlight: 1.2 }, { maxRootInFlight: 0 },
      { baseDelayMs: 501, maxDelayMs: 500 },
    ]) expect(() => defineRecoveryLimits(mutant)).toThrow();
  });
});
