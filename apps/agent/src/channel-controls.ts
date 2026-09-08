import type { Event } from "tardie/core/event";
import {
  channelBindings,
  channelEventKey,
  channelDigest,
} from "./channel-bindings.ts";
export interface ChannelControlPlan {
  id: string;
  action: "poll" | "renew";
  partition: string;
  maxRuns: number;
  intervalMs: number;
  backoffMs: number;
  expiresAt: number;
  firstAt: number;
  leaseLeadMs: number;
}
export const controlOperationId = (plan: Event, ordinal: number) =>
  channelDigest([
    "channel-control-v1",
    plan.owner,
    plan.channel,
    plan.generation,
    plan.id,
    ordinal,
  ]);
/** Pure projection only. A due date is not permission and never executes an effect. */
export function channelControlState(events: readonly Event[], owner: string) {
  const rows = events.filter((e) => e.owner === owner && channelEventKey(e));
  const bindings = channelBindings(rows, owner);
  return rows
    .filter((e) => e.type === "AikoChannelControlPlan")
    .map((plan) => {
      const b = bindings.get(String(plan.channel)),
        p = plan.plan as ChannelControlPlan;
      const local = rows.filter(
        (e) => e.channel === plan.channel && e.generation === plan.generation,
      );
      let reason: string | undefined,
        due: number | undefined,
        ordinal = 0;
      if (
        local.some(
          (e) => e.type === "AikoChannelControlStopped" && e.id === plan.id,
        )
      )
        reason = "stopped";
      else if (
        !b ||
        b.generation !== plan.generation ||
        b.status === "retired" ||
        b.status === "retiring"
      )
        reason = "retired";
      else if (b.status !== "active") reason = "paused";
      else {
        due = p.firstAt;
        for (; ordinal < p.maxRuns; ordinal++) {
          const id = controlOperationId(plan, ordinal);
          const request = local.find(
            (e) =>
              e.id === id &&
              e.type ===
                (p.action === "poll"
                  ? "AikoChannelPollRequested"
                  : "AikoChannelRenewRequested"),
          );
          if (!request) break;
          const settled = local.find(
            (e) =>
              e.id === id &&
              e.type ===
                (p.action === "poll"
                  ? "AikoChannelPollSettled"
                  : "AikoChannelRenewSettled"),
          );
          if (!settled) {
            reason = "pending";
            due = undefined;
            break;
          }
          if (
            (p.action === "renew" && settled.status !== "ready") ||
            (p.action === "poll" && settled.status !== "accepted")
          ) {
            reason = String(settled.status ?? "unavailable");
            due = undefined;
            break;
          }
          due = Number(settled.at) + Math.max(p.intervalMs, p.backoffMs);
        }
        if (ordinal === p.maxRuns) {
          reason = "exhausted";
          due = undefined;
        }
        if (due !== undefined) {
          const resumed = local.findLast(
            (e) => e.type === "AikoChannelLifecycle" && e.status === "active",
          );
          if (resumed)
            due = Math.max(
              due,
              Number(resumed.at) + Math.max(p.intervalMs, p.backoffMs),
            );
        }
        if (due !== undefined && p.action === "renew") {
          const lease = local.findLast(
            (e) =>
              [
                "AikoChannelSubscriptionSettled",
                "AikoChannelRenewSettled",
              ].includes(e.type) && e.status === "ready",
          )?.receipt as any;
          if (!Number.isSafeInteger(lease?.leaseExpiresAt)) {
            reason = "signed_lease_unavailable";
            due = undefined;
          } else due = Math.max(due, lease.leaseExpiresAt - p.leaseLeadMs);
        }
      }
      const used = Array.from({ length: p.maxRuns }, (_, i) =>
        controlOperationId(plan, i),
      ).filter((id) =>
        local.some(
          (e) =>
            e.id === id &&
            e.type ===
              (p.action === "poll"
                ? "AikoChannelPollRequested"
                : "AikoChannelRenewRequested"),
        ),
      ).length;
      return { plan, p, b, ordinal, used, reason, due };
    });
}
export function channelRuntimeNextWake(
  events: readonly Event[],
  owner: string,
): number | undefined {
  const dates = channelControlState(events, owner)
    .filter((s) => !s.reason || s.reason === "pending")
    .map((s) =>
      s.reason === "pending" ? s.p.expiresAt : Math.min(s.due!, s.p.expiresAt),
    );
  // Retained admission waits share the existing host alarm, including manual polls.
  // The request timestamp is immutable: pause/reopen never renews custody lifetime.
  const bindings = channelBindings(events, owner);
  for (const request of events) {
    if (
      request.owner !== owner ||
      request.type !== "AikoChannelPollRequested" ||
      !channelEventKey(request)
    )
      continue;
    const b = bindings.get(String(request.channel));
    if (!b || b.status !== "active" || b.generation !== request.generation)
      continue;
    const local = events.filter(
      (e) =>
        e.owner === owner &&
        e.channel === b.id &&
        e.generation === b.generation &&
        channelEventKey(e),
    );
    if (
      local.some(
        (e) =>
          e.type === "AikoChannelPollAdmissionDeferred" &&
          e.poll === request.id,
      ) &&
      !local.some(
        (e) => e.type === "AikoChannelPollSettled" && e.id === request.id,
      )
    )
      dates.push(Number(request.at) + b.retentionMs);
  }
  return dates.length ? Math.min(...dates) : undefined;
}
