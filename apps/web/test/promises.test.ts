import { expect, test } from "vitest";
import { decidePromise, listPromises, pendingPromiseCount, promiseAccessDenied, promiseStatus, type PromiseRequest, type PromiseReview } from "../src/lib/promises";

test("human decisions use the shell transport path and exact reviewed identity only", async () => {
  const calls: unknown[][] = [];
  const request: PromiseRequest = async <T,>(...args: Parameters<PromiseRequest>) => { calls.push(args); return {} as T; };
  const controller = new AbortController();
  await listPromises(request, controller.signal);
  const review = { id: "owner-promise", hash: "immutable-final-payload" };
  await decidePromise(request, review, "approve", controller.signal);
  expect(calls).toEqual([["/promises", undefined, controller.signal], ["/promises/decision", { ...review, decision: "approve" }, controller.signal]]);
});

test("status and counts distinguish queued, running, expired and unconfirmed work", () => {
  const row = { state: "pending", when: { kind: "approval" }, expiresAt: Date.now() + 60_000 } as PromiseReview;
  expect(pendingPromiseCount([row, { ...row, state: "resolved" }, { ...row, expiresAt: 0 }])).toBe(1);
  expect(promiseStatus({ ...row, state: "resolved" })).toContain("queued");
  expect(promiseStatus({ ...row, state: "dispatching" })).toContain("not yet completed");
  expect(promiseStatus({ ...row, state: "unknown" })).toContain("unconfirmed");
  // A task can expire after approval while it is still queued.
  expect(promiseStatus({ ...row, state: "expired" })).toBe("Expired before dispatch");
  expect(promiseStatus({ ...row, state: "settled", outcome: "failed" })).toBe("Could not complete");
  expect(promiseAccessDenied({ status: 403 })).toBe(true);
  expect(promiseAccessDenied({ status: 503 })).toBe(false);
});
