export type WatchAction =
  | { kind: "actor"; instruction: string }
  | { kind: "webhook"; destination: string }
  | {
      kind: "harness";
      digest: string;
      contractDigest: string;
      input: unknown;
      eventInputs?: Record<string, string[]>;
    };
export type WatchEventChoice = {
  id: string;
  label: string;
  kind: "push" | "notification" | "network";
  outcome: string;
  method?: string;
  route?: string;
};
export type WatchSite = {
  connectionId: string;
  label: string;
  origin: string;
  connectionRevision: string;
  sourceGeneration: number;
  expiresAt?: number;
  events: WatchEventChoice[];
};
export type WatchActionChoice = {
  id: string;
  label: string;
  description?: string;
  action: WatchAction;
  supportsInstruction?: boolean;
};
export type WatchDiscovery = {
  sites: WatchSite[];
  actions: WatchActionChoice[];
  defaults: { expiresInMs: number; backlog: number; maxOccurrences: number };
};
export type WatchConfig = {
  id: string;
  label: string;
  connectionId: string;
  connectionRevision: string;
  sourceGeneration: number;
  origin: string;
  kind: WatchEventChoice["kind"];
  outcome: string;
  method?: string;
  route?: string;
  action: WatchAction;
  expiresAt: number;
  backlog: number;
  maxOccurrences: number;
};
export type WatchStatus = {
  id: string;
  label?: string;
  generation: number;
  controlRevision?: number;
  lifecycleRevision?: number;
  status: string;
  reason?: string;
  config?: WatchConfig;
  leaseRevision?: number;
  renewal?: WatchRenewal;
  reauthorization?: {
    requestId: string; challenge: string; status: "pending" | "confirmed" | "needs-attention";
    attempts: number; deadlineAt: number; nextAt?: number;
  };
  budget?: { used: number; limit: number; remaining: number };
  release?: {
    status: "pending" | "confirmed" | "needs-attention";
    attempts: number;
    deadlineAt: number;
    nextAt?: number;
    reason?: string;
  };
  collector?: {
    state: string;
    reason?: string;
    restore?: { challenge: string; at: number; queue?: {head:number;acknowledged:number;offered:number} };
    excludedBefore?: number;
    coverageGap?: {
      generation: number;
      missed: number;
      acknowledged: number;
      countUncertain: boolean;
      firstAt: number;
      lastAt: number;
    };
  };
  source?: { activated: boolean; reason?: string };
  lastEventAt?: number;
  lastTaskAt?: number;
  lastTaskStatus?: string;
  lastTaskOperationId?: string;
};
export type WatchSample = {
  status: string;
  event?: {
    kind: string;
    observedAt: number;
    fields?: Record<string, unknown>;
  };
  payload?: unknown;
};
export type WatchRequest = <T>(
  path: string,
  body?: object,
  signal?: AbortSignal,
) => Promise<T>;
export type WatchReply<T> = { available: true; result: T };
export const watchPath = "/channels/browser-watches";
/** Checks the retained result only, including after pause or expiry. Never applies a permit. */
export function watchRestoreCheckRequest(watch: WatchStatus) {
  const request = watch.reauthorization;
  if (!request || request.status === "confirmed" || !request.requestId) return;
  return { id: watch.id, requestId: request.requestId };
}
/** A browser can request the current held watch only; the host supplies all continuity proof and authority. */
export function watchReauthorizationRequest(watch: WatchStatus, now: number) {
  const pending = watch.reauthorization?.status !== "confirmed" ? watch.reauthorization : undefined;
  const hold = watch.collector?.restore, challenge = hold?.challenge ?? pending?.challenge;
  if (!watch.config || watch.config.expiresAt <= now || ["paused", "deleted"].includes(watch.status) ||
    !challenge || !Number.isSafeInteger(watch.lifecycleRevision) || Number(watch.lifecycleRevision) < 0 ||
    !Number.isSafeInteger(watch.leaseRevision) || Number(watch.leaseRevision) < 0 ||
    hold && !hold.queue || pending && hold && pending.challenge !== hold.challenge) return;
  return { id: watch.id, expectedGeneration: watch.generation, expectedLifecycleRevision: watch.lifecycleRevision!,
    expectedLeaseRevision: watch.leaseRevision!, challenge };
}
export const watchStateLabel = (status: string) =>
  ({
    watching: "Watching",
    "catching-up": "Catching up",
    "setting-up": "Setting up",
    paused: "Paused",
    deleted: "Deleted",
    "needs-attention": "Needs attention",
  })[status] ?? "Status unavailable";
export function watchEventLabel(config: WatchConfig) {
  return config.kind === "push"
    ? "A push message arrives"
    : config.kind === "notification"
      ? "A notification appears"
      : `${config.method} ${config.route}`;
}
export function watchSampleText(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload.slice(0, 8000);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const value = payload as Record<string, unknown>;
  const parts = ["title", "body", "text", "message"]
    .map((key) => value[key])
    .filter((item): item is string => typeof item === "string" && !!item);
  if (parts.length) return [...new Set(parts)].join("\n").slice(0, 8000);
  if (Array.isArray(value.eventMetadata)) {
    const text = value.eventMetadata
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          /title|body|message|text/i.test(String(item.key)) &&
          typeof item.value === "string",
      )
      .map((item) => item.value)
      .join("\n");
    if (text) return text.slice(0, 8000);
  }
}
/** The browser chooses only values advertised by the current owner discovery. */
export function makeWatchConfig(input: {
  discovery: WatchDiscovery;
  connectionId: string;
  eventId: string;
  actionId: string;
  instruction: string;
  label: string;
  duration: number;
  maxOccurrences: number;
  id: string;
  now: number;
  prior?: WatchConfig;
}): WatchConfig {
  const site = input.discovery.sites.find(
      (site) => site.connectionId === input.connectionId,
    ),
    choice = input.discovery.actions.find(
      (action) => action.id === input.actionId,
    );
  if (!site || !choice)
    throw Error(
      "This site or action is no longer available. Refresh the choices.",
    );
  const event = site.events.find((event) => event.id === input.eventId);
  if (!input.prior && !event) throw Error("Choose when this watch should run.");
  if (!input.label.trim()) throw Error("Give this watch a name.");
  let action = structuredClone(choice.action);
  if (action.kind === "actor" && choice.supportsInstruction) {
    if (!input.instruction.trim()) throw Error("Describe what Aiko should do.");
    action = { kind: "actor", instruction: input.instruction.trim() };
  }
  if (input.prior) {
    if (
      input.prior.connectionId !== site.connectionId ||
      input.prior.connectionRevision !== site.connectionRevision ||
      input.prior.origin !== site.origin
    )
      throw Error(
        "This connection changed. Create a new watch with the current connection.",
      );
    return {
      ...structuredClone(input.prior),
      label: input.label.trim(),
      action,
    };
  }
  if (
    !Number.isSafeInteger(input.duration) ||
    input.duration < 1 ||
    input.duration > input.discovery.defaults.expiresInMs ||
    input.duration > 86_400_000 ||
    !Number.isSafeInteger(input.maxOccurrences) ||
    input.maxOccurrences < 1 ||
    input.maxOccurrences > input.discovery.defaults.maxOccurrences
  )
    throw Error("Check the duration and event limit.");
  if(site.expiresAt!==undefined&&(!Number.isSafeInteger(site.expiresAt)||site.expiresAt<=input.now))
    throw Error("This site connection expired. Refresh the connection before creating a watch.");
  return {
    id: input.id,
    label: input.label.trim(),
    connectionId: site.connectionId,
    connectionRevision: site.connectionRevision,
    sourceGeneration: site.sourceGeneration,
    origin: site.origin,
    kind: event!.kind,
    outcome: event!.outcome,
    ...(event!.method ? { method: event!.method, route: event!.route } : {}),
    action,
    expiresAt: Math.min(input.now + input.duration, site.expiresAt ?? Infinity),
    backlog: input.discovery.defaults.backlog,
    maxOccurrences: input.maxOccurrences,
  };
}

export type WatchRenewal = {
  leaseRevision: number;
  expiresAt: number;
  maxOccurrences: number;
  status: "pending" | "confirmed" | "needs-attention";
  deadlineAt: number;
  attempts: number;
  nextAt?: number;
  reason?: string;
  coverageLapse?: { from: number; to: number; leaseRevision: number };
};
export type WatchRenewalRequest = {
  id: string;
  expectedGeneration: number;
  expectedLeaseRevision: number;
  expiresAt: number;
  maxOccurrences: number;
};
export function retainedWatchRenewal(watch: WatchStatus): WatchRenewalRequest | undefined {
  const renewal = watch.renewal;
  if (!renewal || renewal.status === "confirmed") return;
  return { id: watch.id, expectedGeneration: watch.generation,
    expectedLeaseRevision: renewal.leaseRevision - 1,
    expiresAt: renewal.expiresAt, maxOccurrences: renewal.maxOccurrences };
}
export function makeWatchRenewal(watch: WatchStatus, site: WatchSite | undefined,
  expiresAt: number, maxOccurrences: number, now: number): WatchRenewalRequest {
  const config = watch.config;
  if (!config || !site || site.connectionId !== config.connectionId || site.origin !== config.origin ||
    site.connectionRevision !== config.connectionRevision || site.sourceGeneration !== config.sourceGeneration)
    throw Error("This connection changed. Refresh its status before extending limits.");
  if (watch.status === "deleted" || retainedWatchRenewal(watch))
    throw Error("Check the existing renewal before changing limits.");
  expiresAt = Math.min(expiresAt, site.expiresAt ?? Infinity, now + 86_400_000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt < config.expiresAt ||
    !Number.isSafeInteger(maxOccurrences) || maxOccurrences < config.maxOccurrences ||
    maxOccurrences <= (watch.budget?.used ?? 0) || maxOccurrences > 1_000_000 ||
    expiresAt === config.expiresAt && maxOccurrences === config.maxOccurrences)
    throw Error("Increase the end time or total observation limit within this connection’s limits.");
  return { id: watch.id, expectedGeneration: watch.generation,
    expectedLeaseRevision: watch.leaseRevision ?? 0, expiresAt, maxOccurrences };
}
