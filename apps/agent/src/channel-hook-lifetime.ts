import type { Event } from "tardie/core/event";
import { channelDigest, CHANNEL_PROVENANCE } from "./channel-bindings.ts";

/** Metadata only; the private management grant remains the execution authority. */
export type HookLifetime = {
  execution: string;
  namespace: string;
  parentOperation: string;
  deadline: number;
};
export type HookAdoption = HookLifetime & {
  operationId: string;
  authorityRef: string;
  expiresAt: number;
};
const own = (rows: readonly Event[], owner: string) =>
  rows.filter((e) => e.owner === owner && e.provenance === CHANNEL_PROVENANCE);
export function hookLifetimes(
  rows: readonly Event[],
  owner: string,
): HookLifetime[] {
  return own(rows, owner)
    .filter(
      (e) =>
        e.type === "AikoChannelWiringManagementGranted" &&
        typeof e.namespace === "string" &&
        Number.isSafeInteger(e.deadline),
    )
    .map((e) => ({
      execution: String(e.id),
      namespace: String(e.namespace),
      parentOperation: String(e.parentOperation),
      deadline: Number(e.deadline),
    }));
}
export function hookForPort(rows: readonly Event[], owner: string, port: any) {
  const bound = own(rows, owner).find(
    (e) =>
      e.type === "AikoChannelWiringBound" &&
      (e.port as any)?.channel === port?.channel &&
      (e.port as any)?.generation === port?.generation,
  );
  if (!String(bound?.operationId).startsWith("child:")) return undefined;
  return (
    hookLifetimes(rows, owner).find((g) =>
      String(bound?.operationId).startsWith(g.namespace + ":"),
    ) ?? null
  );
}
export function hookAdoption(
  rows: readonly Event[],
  owner: string,
  g: HookLifetime,
) {
  return own(rows, owner).find(
    (e) => e.type === "AikoChannelWiringHookAdopted" && e.id === g.execution,
  );
}
export function hookClosure(
  rows: readonly Event[],
  owner: string,
  g: HookLifetime,
  now: number,
): string | undefined {
  const local = own(rows, owner);
  if (
    local.some(
      (e) => e.type === "AikoChannelWiringHookRetired" && e.id === g.execution,
    )
  )
    return "revoked";
  const adopted = hookAdoption(rows, owner, g);
  if (adopted) return Number(adopted.expiresAt) <= now ? "expired" : undefined;
  if (g.deadline <= now) return "expired";
  const claim = local.find(
    (e) => e.type === "AikoChannelWiringClaimed" && e.id === g.parentOperation,
  );
  const source = local.find(
    (e) => e.type === "AikoChannelWiringAccepted" && e.id === claim?.source,
  );
  const waiter = local.find(
    (e) =>
      e.type === "AikoChannelWiringWaitRegistered" &&
      e.id === source?.requestWaiter,
  );
  const call = rows.find(
    (e) => e.type === "PackageCalled" && e.callId === waiter?.callId,
  );
  if (
    rows.some(
      (e) =>
        (["TurnCancelled", "TurnFailed"].includes(e.type) &&
          [g.execution, g.parentOperation, call?.turn]
            .filter(Boolean)
            .includes(e.turn as string)) ||
        (e.type === "CodeCancelled" && e.execId === g.execution) ||
        (e.type === "AikoChannelWiringWaitCancelled" &&
          waiter &&
          e.id === waiter.id),
    )
  )
    return "cancelled";
  if (
    local.some(
      (e) =>
        e.type === "AikoChannelWiringHandlerChecked" && e.id === g.execution,
    )
  )
    return "parent_completed";
  return undefined;
}
export function hookPortOpen(
  rows: readonly Event[],
  owner: string,
  port: any,
  now: number,
) {
  const g = hookForPort(rows, owner, port);
  return g === undefined || (g !== null && !hookClosure(rows, owner, g, now));
}
/** No outcomes are invented: Started without a terminal receipt remains unknown. */
export function hookPendingDisposition(
  rows: readonly Event[],
  owner: string,
  g: HookLifetime,
) {
  const local = own(rows, owner);
  return local
    .filter(
      (e) =>
        e.type === "AikoChannelWiringAccepted" &&
        hookForPort(rows, owner, e.port)?.execution === g.execution,
    )
    .map((source) => {
      const claims = local.filter(
        (e) => e.type === "AikoChannelWiringClaimed" && e.source === source.id,
      );
      return {
        source: String(source.id),
        invocations: claims.map((c) => {
          const terminal = local.findLast(
            (e) =>
              e.type === "AikoChannelWiringSettled" &&
              (e.id === c.id || e.invocation === c.id),
          );
          return {
            id: String(c.id),
            disposition:
              terminal && terminal.status !== "pending"
                ? "terminal_retained"
                : local.some(
                      (e) =>
                        e.type === "AikoChannelWiringStarted" && e.id === c.id,
                    )
                  ? "unknown_retained"
                  : "cancelled_before_dispatch",
          };
        }),
        disposition: claims.length
          ? "claims_retained"
          : "cancelled_before_handoff",
      };
    })
    .filter(
      (s) =>
        !s.invocations.length ||
        s.invocations.some((i) => i.disposition !== "terminal_retained"),
    );
}
export const hookCleanupId = (g: HookLifetime) =>
  channelDigest(["task-hook-cleanup-v1", g.execution, g.namespace]);

/** Adoption starts a fresh source window; cancelled queued work is not resurrected. */
export function hookSourceAllowed(
  rows: readonly Event[],
  owner: string,
  port: any,
  sequence: number,
) {
  const g = hookForPort(rows, owner, port),
    adopted = g && hookAdoption(rows, owner, g);
  const cuts = adopted?.watermarks as Record<string, number> | undefined;
  return sequence > (cuts?.[`${port.channel}:${port.generation}`] ?? -1);
}
export function hookCurrentCleanupId(
  rows: readonly Event[],
  owner: string,
  g: HookLifetime,
) {
  const adopted = hookAdoption(rows, owner, g);
  return adopted
    ? channelDigest([hookCleanupId(g), adopted.operationId])
    : hookCleanupId(g);
}
