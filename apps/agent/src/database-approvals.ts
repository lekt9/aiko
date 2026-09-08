import { createHash } from "node:crypto";
import type { Event } from "tardie/core/event";
import { canonical, type DomainCollection, type RowData, type RecordRevision } from "../../../packages/structured-data/src/index.ts";
import { projectActionApprovals } from "./action-approval.ts";

/** A projection of the existing action service. It owns no decisions or dispatch. */
export function databaseApprovals(owner: string, thread: string, now: () => number = Date.now) {
  let rows: RecordRevision<RowData>[] = [];
  const collection: DomainCollection = {
    definition: { id: "system.approvals", databaseId: "system", name: "Action approvals", mode: "domain", columns: [
      { id: "operation", name: "Operation", type: "text", authority: "domain" },
      { id: "connection", name: "Connection", type: "text", authority: "domain" },
      { id: "state", name: "Approval state", type: "enum", options: ["pending", "approved", "rejected", "expired", "dispatched", "settled", "unknown"], authority: "domain" },
      { id: "outcome", name: "Execution outcome", type: "enum", options: ["succeeded", "failed"], nullable: true, authority: "domain" },
      { id: "expiresAt", name: "Expires", type: "timestamp", authority: "domain" },
      { id: "canDecide", name: "Awaiting human decision", type: "boolean", authority: "domain" },
      { id: "version", name: "Version", type: "integer", authority: "domain" },
    ] },
    rows: () => ({ rows: rows.map(row => ({ ...row, value: { values: { ...row.value.values, canDecide: row.value.values.state === "pending" && Date.parse(String(row.value.values.expiresAt)) > now() } } })), revision: 1, complete: true }),
    revision: () => createHash("sha256").update(canonical(collection.rows().rows.map(row => [row.id, row.revision, row.value.values.canDecide]))).digest("hex"),
    coverage: "Action approvals on the owner foreground thread. Browser prompts and secretary policy approvals retain their existing queues until their domain adapters are added.",
  };
  return { collection, update: (events: readonly Event[]) => {
    const times = new Map(events.filter(e => e.type === "AikoActionApprovalTransition" && e.owner === owner && e.thread === thread).map(e => [String((e.snapshot as { token?: string })?.token), Number(e.at ?? 0)]));
    rows = [...projectActionApprovals(events, owner, thread)].sort(([a], [b]) => a.localeCompare(b)).map(([id, state]) => ({ id, revision: state.version, producer: "domain:action-approval", deleted: false, at: times.get(state.token) ?? 0,
      value: { values: { operation: state.prepared.operation, connection: state.prepared.connectionId, state: state.state, outcome: state.outcome ?? null, expiresAt: new Date(state.prepared.expiresAt).toISOString(), canDecide: false, version: state.version } },
    }));
  } };
}
