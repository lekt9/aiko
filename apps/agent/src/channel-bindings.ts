import { createHash } from "node:crypto";
import type { Event } from "tardie/core/event";

/** These events are host receipts, never an ingress or generated-adapter input format. */
export const CHANNEL_PROVENANCE = "aiko.channel.host.v1";
export const channelDigest = (value: unknown): string => {
  const canonical = (v: any): any => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(canonical);
    if (
      v &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype
    )
      return Object.fromEntries(
        Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort()
          .map((k) => [k, canonical(v[k])]),
      );
    throw new Error("channel_non_json");
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
};
/** Native host tracing is transport metadata, not part of the immutable receipt payload. */
export const channelEventDigest = (event: Event) => {
  const { traceparent: _trace, ...receipt } = event;
  return channelDigest(receipt);
};
/** Matching concurrent retries share the first committed receipt despite local timestamps. */
export const channelSameReceipt = (a: Event, b: Event): boolean => {
  if (!channelEventKey(a) || channelEventKey(a) !== channelEventKey(b))
    return false;
  if (a.privateRef || b.privateRef)
    return (
      channelDigest(a.privateRef ?? null) ===
        channelDigest(b.privateRef ?? null) &&
      (["AikoChannelReceived", "AikoChannelOutputPrepared"].includes(a.type) ||
        channelEventDigest(a) === channelEventDigest(b))
    );
  if (a.type === "AikoChannelBindingIntent")
    return channelDigest(a.binding) === channelDigest(b.binding);
  if (["AikoChannelReceived", "AikoChannelOutputPrepared"].includes(a.type))
    return typeof a.digest === "string" && a.digest === b.digest;
  if (a.type === "AikoChannelLifecycle")
    return a.status === b.status && a.authorization === b.authorization;
  return channelEventDigest(a) === channelEventDigest(b);
};
export const channelId = (owner: string, name: string) =>
  channelDigest([owner, name]);
export type ChannelArtifact = {
  digest: string;
  contractDigest: string;
  directions: ("inbox" | "outbox")[];
  operations: (
    "decode" | "poll" | "send" | "reconcile" | "subscribe" | "remove" | "renew"
  )[];
};
export type ChannelBinding = {
  id: string;
  owner: string;
  name: string;
  generation: number;
  lifecycle?: number;
  artifact: ChannelArtifact;
  account: string;
  source: string;
  destination?: string;
  route: string;
  credentialRefs: string[];
  authorization: string;
  status: "pending" | "active" | "paused" | "retiring" | "retired";
  backlog: number;
  maxBytes: number;
  maxHops: number;
  retentionMs: number;
  /** Upgrades cancel unprocessed input/prepared output. Dispatched output still reconciles. */
  queuedWork: "cancel";
  /** Trusted generated-provider binding: subscribe waits for retained ingress arm. */
  ingressBeforeSubscribe?: boolean;
  provisioningScope?: { id: string; limit: number };
  providerPolicyDigest?: string;
  /** Immutable bridge intent retained before any subscription can be dispatched. */
  providerBridge?: import("./channel-ingress.ts").ChannelBridgeSpec;
};
export type ChannelFact = Event & {
  id: string;
  owner: string;
  channel: string;
  generation: number;
  provenance: string;
};
export function channelFact(
  type: string,
  b: ChannelBinding,
  id: string,
  fields: Record<string, unknown> = {},
): ChannelFact {
  return {
    ...fields,
    type: `AikoChannel${type}`,
    id,
    owner: b.owner,
    channel: b.id,
    generation: b.generation,
    provenance: CHANNEL_PROVENANCE,
  };
}
const types = new Set([
  "BindingIntent",
  "BindingReady",
  "IngressArmed",
  "Lifecycle",
  "SubscriptionStarted",
  "SubscriptionSettled",
  "Received",
  "InputAccepted",
  "InputRejected",
  "InputHandled",
  "ControlPlan",
  "ControlTick",
  "ControlStopped",
  "PollFetched",
  "PollAdmissionDeferred",
  "PollRequested",
  "PollSettled",
  "CursorAdvanced",
  "OutputPrepared",
  "OutputStarted",
  "OutputSettled",
  "ReconcileRequested",
  "ReconcileSettled",
  "RenewRequested",
  "RenewSettled",
]);
export const channelEventKey = (e: Event) =>
  e.provenance === CHANNEL_PROVENANCE &&
  types.has(e.type.replace(/^AikoChannel/, "")) &&
  e.type.startsWith("AikoChannel") &&
  typeof e.owner === "string" &&
  typeof e.channel === "string" &&
  Number.isSafeInteger(e.generation) &&
  typeof e.id === "string"
    ? `aiko-channel:${channelDigest([e.owner, e.channel, e.generation, e.type, e.id])}`
    : undefined;
export function channelBindings(
  log: readonly Event[],
  owner: string,
): Map<string, ChannelBinding> {
  const bindings = new Map<string, ChannelBinding>();
  for (const e of log) {
    if (!channelEventKey(e) || e.owner !== owner) continue;
    const previous = bindings.get(String(e.channel));
    if (
      e.type === "AikoChannelBindingIntent" &&
      (!previous || e.generation === previous.generation + 1)
    )
      bindings.set(
        String(e.channel),
        structuredClone(e.binding as ChannelBinding),
      );
    else if (previous && previous.generation === e.generation) {
      if (e.type === "AikoChannelBindingReady")
        bindings.set(previous.id, {
          ...previous,
          status: "active",
          lifecycle: (previous.lifecycle ?? 0) + 1,
        });
      if (e.type === "AikoChannelLifecycle")
        bindings.set(previous.id, {
          ...previous,
          status: e.status as ChannelBinding["status"],
          lifecycle: (previous.lifecycle ?? 0) + 1,
        });
    }
  }
  return bindings;
}
export function validateChannelBinding(b: ChannelBinding): void {
  const strings = [
    b.owner,
    b.name,
    b.account,
    b.source,
    b.route,
    b.authorization,
    b.artifact.digest,
    b.artifact.contractDigest,
  ];
  if (
    strings.some(
      (s) => typeof s !== "string" || !s.trim() || s.length > 1024,
    ) ||
    b.id !== channelId(b.owner, b.name) ||
    b.route !== `user-${b.owner}` ||
    !Number.isSafeInteger(b.generation) ||
    b.generation < 1 ||
    b.queuedWork !== "cancel" ||
    !Array.isArray(b.credentialRefs) ||
    b.credentialRefs.some(
      (s) => typeof s !== "string" || !s.startsWith("credential:"),
    ) ||
    !b.artifact.directions.length ||
    b.artifact.directions.some((d) => !["inbox", "outbox"].includes(d)) ||
    b.artifact.operations.some(
      (op) =>
        ![
          "decode",
          "poll",
          "send",
          "reconcile",
          "subscribe",
          "remove",
          "renew",
        ].includes(op),
    ) ||
    (b.artifact.directions.includes("inbox") &&
      !b.artifact.operations.includes("decode")) ||
    (b.artifact.directions.includes("outbox") &&
      (!b.destination || !b.artifact.operations.includes("send"))) ||
    (b.artifact.operations.includes("subscribe") &&
      !b.artifact.operations.includes("remove")) ||
    (!b.artifact.directions.includes("outbox") &&
      (b.destination !== undefined ||
        b.artifact.operations.includes("send"))) ||
    !Number.isSafeInteger(b.backlog) ||
    b.backlog < 1 ||
    b.backlog > 10000 ||
    !Number.isSafeInteger(b.maxBytes) ||
    b.maxBytes < 1 ||
    b.maxBytes > 1048576 ||
    !Number.isSafeInteger(b.maxHops) ||
    b.maxHops < 1 ||
    b.maxHops > 16 ||
    !Number.isSafeInteger(b.retentionMs) ||
    b.retentionMs < 1
  )
    throw new Error("invalid_channel_binding");
}

/** Install in the host's synchronous commit guard alongside automationAppendAllowed.
 * A host must reject untrusted direct append/seed access to this namespace entirely.
 * Re-check after awaited I/O; a returned durable receipt is the only acknowledgement.
 */
export function channelAppendAllowed(
  events: readonly Event[],
  read: () => readonly Event[],
): boolean {
  const current = [...read()];
  for (const e of events) {
    if (!channelEventKey(e)) continue;
    const prior = current.find(
      (p) => channelEventKey(p) === channelEventKey(e),
    );
    if (prior) {
      if (!channelSameReceipt(prior, e)) return false;
      continue;
    }
    const b = channelBindings(current, String(e.owner)).get(String(e.channel));
    if (e.type === "AikoChannelBindingIntent") {
      if (Number(e.generation) !== (b?.generation ?? 0) + 1) return false;
      const next = e.binding as ChannelBinding;
      if (next.provisioningScope) {
        const scope = next.provisioningScope;
        if (
          !scope.id ||
          !Number.isSafeInteger(scope.limit) ||
          scope.limit < 1 ||
          scope.limit > 16 ||
          [...channelBindings(current, String(e.owner)).values()].filter(
            (other) =>
              other.id !== next.id &&
              other.status !== "retired" &&
              other.provisioningScope?.id === scope.id,
          ).length >= scope.limit
        )
          return false;
      }
    } else if (e.fence === true) {
      if (
        !b ||
        b.generation !== e.generation ||
        (e.expectedStatus !== undefined && b.status !== e.expectedStatus) ||
        (e.expectedLifecycle !== undefined &&
          (b.lifecycle ?? 0) !== e.expectedLifecycle)
      )
        return false;
      if (e.type === "AikoChannelControlPlan") {
        const p = e.plan as any;
        if (
          !p ||
          p.id !== e.id ||
          !["poll", "renew", "retry-send"].includes(p.action) ||
          !Number.isSafeInteger(p.maxRuns) ||
          p.maxRuns < 1 ||
          p.maxRuns > 16 ||
          p.expiresAt <= Date.now() ||
          typeof e.policyDigest !== "string"
        )
          return false;
        const local = current.filter(
          (r) =>
            r.owner === e.owner &&
            r.channel === e.channel &&
            r.generation === e.generation,
        );
        if (
          local.some(
            (r) =>
              r.type === "AikoChannelControlPlan" &&
              (r.plan as any)?.action === p.action &&
              (p.action !== "retry-send" || (r.plan as any)?.partition === p.partition) &&
              (p.action === "retry-send" ||
              !local.some(
                (s) => s.type === "AikoChannelControlStopped" && s.id === r.id,
              ) &&
              local.filter(
                (t) => t.type === "AikoChannelControlTick" && t.plan === r.id,
              ).length < Number((r.plan as any).maxRuns)),
          )
        )
          return false;
      }
      if (e.type === "AikoChannelReceived") {
        const pending = current.filter(
          (p) =>
            p.type === "AikoChannelReceived" &&
            p.channel === b.id &&
            p.generation === b.generation &&
            !current.some(
              (r) =>
                r.channel === b.id &&
                r.generation === b.generation &&
                r.id === p.id &&
                [
                  "AikoChannelInputHandled",
                  "AikoChannelInputRejected",
                ].includes(r.type),
            ),
        );
        if (pending.length >= b.backlog) return false;
      }
      if (e.type === "AikoChannelOutputPrepared") {
        const pending = current.filter(
          (p) =>
            p.type === "AikoChannelOutputPrepared" &&
            p.owner === b.owner &&
            p.channel === b.id &&
            p.generation === b.generation &&
            !current.some(
              (r) =>
                r.type === "AikoChannelOutputSettled" &&
                r.channel === b.id &&
                r.generation === b.generation &&
                r.id === p.id,
            ),
        );
        if (pending.length >= b.backlog) return false;
      }
      if (e.type === "AikoChannelCursorAdvanced") {
        const last = current
          .filter(
            (p) =>
              p.type === e.type &&
              p.channel === b.id &&
              p.generation === b.generation &&
              p.partition === e.partition,
          )
          .at(-1);
        if ((last?.cursor ?? null) !== e.previous) return false;
      }
    }
    current.push(e);
  }
  return true;
}
