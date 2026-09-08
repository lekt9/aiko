/** Owner-private promise review; decisions are human HTTP actions, never tools. */
export type PromiseRequest = <T>(path: string, body?: object, signal?: AbortSignal) => Promise<T>;
export type PromiseReview = {
  id: string; hash: string; label: string;
  when: { kind: "approval" } | { kind: "at"; at: number } | { kind: "hook"; eventType: string };
  state: "pending" | "resolved" | "dispatching" | "settled" | "unknown" | "rejected" | "expired" | "cancelled";
  createdAt: number; expiresAt: number; outcome?: "succeeded" | "failed";
  payload: { kind: "harness"; segment: { version: 1; code: string; values: Record<string, unknown>; packages: Record<string, string[]> } };
};
export type PromiseDecision = "approve" | "reject" | "cancel";
export function promiseStatus(row: PromiseReview): string {
  switch (row.state) {
    case "pending": return row.when.kind === "approval" ? "Needs your approval" : "Scheduled";
    case "resolved": return "Approved or triggered · queued";
    case "dispatching": return "Running · not yet completed";
    case "settled": return row.outcome === "succeeded" ? "Completed · check action receipts" : "Could not complete";
    case "unknown": return "Outcome unconfirmed · check the app before trying again";
    case "rejected": return "Declined";
    case "expired": return "Expired · not approved";
    case "cancelled": return "Cancelled before dispatch";
  }
}
export const pendingPromiseCount = (rows: readonly PromiseReview[]) => rows.filter(row => row.state === "pending" && row.when.kind === "approval" && row.expiresAt > Date.now()).length;
export const promiseAccessDenied = (error: unknown) => !!error && typeof error === "object" && "status" in error && [401, 403].includes(Number(error.status));
export const listPromises = (request: PromiseRequest, signal?: AbortSignal) => request<{ promises: PromiseReview[] }>("/promises", undefined, signal);
export const decidePromise = (request: PromiseRequest, row: Pick<PromiseReview, "id" | "hash">, decision: PromiseDecision, signal?: AbortSignal) =>
  request<{ promise: PromiseReview }>("/promises/decision", { id: row.id, hash: row.hash, decision }, signal);
