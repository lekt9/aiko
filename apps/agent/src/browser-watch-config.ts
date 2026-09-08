import { browserEventOrigin, validateBrowserEventFields } from "./browser-events.ts";
import { publicTarget } from "./browser-proxy.ts";
import { nativeBrowserWatchPolicy, type NativeBrowserWatchPolicyOptions } from "./browser-watch-policy.ts";
import { HarnessLibrary, harnessDigest, harnessLibraryState } from "./harness-library.ts";
import type { BrowserWatchHostPolicy, HostedChannels } from "./channel-host.ts";
import type { BrowserWatchConfig, BrowserWatchDiscovery, BrowserWatchAction } from "./browser-watches.ts";
import type { ConnectorEngine } from "./connectors.ts";
import { safeUserId } from "./security.ts";
import { channelBindings, channelDigest, channelId } from "./channel-bindings.ts";
import { createWebhookAdapterHost, webhookTarget, type WebhookDestinationPolicy } from "./webhook-adapter.ts";
import { createSandboxWebhookTransport } from "./webhook-sandbox.ts";
import type { RegistrySandboxTransport } from "./registry-defaults.ts";
import type { HarnessJournal, HarnessBlobStore } from "./harness-library.ts";
import type { WorkflowKV } from "./workflow-host.ts";
import type { BrowserWatchWebhookDestination } from "./browser-watch-webhook-actions.ts";

export interface BrowserWatchWebhookDestinationConfig {
  /** Immutable versioned identity. Changing policy or credentials requires a new ID. */
  id: string;
  url: string;
  signingKeyRef: string;
  expiresAt: number;
  maxBytes: number;
  retentionMs: number;
  idempotency?: "delivery-id";
  notAcceptedStatuses?: number[];
  reconcile?: { url: string; receiptKeyRef: string };
}

type Source = Omit<BrowserWatchDiscovery["sites"][number], "connectionRevision" | "expiresAt">;
type Action = BrowserWatchDiscovery["actions"][number];
export interface BrowserWatchDeployment {
  version: 1;
  ingressOrigin: string;
  owners: Record<string, {
    sources: Source[];
    actions: Action[];
    webhooks?: BrowserWatchWebhookDestinationConfig[];
    defaults: BrowserWatchDiscovery["defaults"];
  }>;
}
const fail = (): never => { throw Error("Invalid AIKO_BROWSER_WATCH_CONFIG"); };
const object = (value: unknown, keys: string[]): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
  return value as Record<string, any>;
};
const label = (value: unknown, limit = 160): value is string => typeof value === "string" && !!value.trim() && value.length <= limit;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const boundedInteger = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

/** Deployment data only. No URLs, credentials, executable predicates or new
 * verifier contracts can be installed by browser events or watch API callers. */
export function parseBrowserWatchDeployment(raw?: string): BrowserWatchDeployment | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 262144) fail();
  try {
    const root = object(JSON.parse(raw), ["version", "ingressOrigin", "owners"]);
    if (root.version !== 1) fail();
    publicTarget(browserEventOrigin(root.ingressOrigin));
    if (!root.owners || typeof root.owners !== "object" || Array.isArray(root.owners) || Object.keys(root.owners).length > 64) fail();
    for (const [owner, value] of Object.entries(root.owners)) {
      if (!safeUserId(owner)) fail();
      const entry = object(value, ["sources", "actions", "defaults", "webhooks"]);
      if (!Array.isArray(entry.sources) || entry.sources.length > 128 || !Array.isArray(entry.actions) || entry.actions.length > 128) fail();
      const defaults = object(entry.defaults, ["expiresInMs", "backlog", "maxOccurrences"]);
      if (!boundedInteger(defaults.expiresInMs, 1000, 86400000) || !boundedInteger(defaults.backlog, 1, 128) || !boundedInteger(defaults.maxOccurrences, 1, 1000000)) fail();
      const connections = new Set<string>(), actions = new Set<string>();
      const destinations = new Set<string>();
      if (entry.webhooks !== undefined) {
        if (!Array.isArray(entry.webhooks) || entry.webhooks.length > 32) fail();
        for (const raw of entry.webhooks) {
          const destination = object(raw, ["id", "url", "signingKeyRef", "expiresAt", "maxBytes", "retentionMs", "idempotency", "notAcceptedStatuses", "reconcile"]);
          if (!id(destination.id) || destinations.has(destination.id) || !id(destination.signingKeyRef) ||
            !boundedInteger(destination.expiresAt, 1, Number.MAX_SAFE_INTEGER) || !boundedInteger(destination.maxBytes, 1, 65536) ||
            !boundedInteger(destination.retentionMs, 1, 86400000) || destination.idempotency !== undefined && destination.idempotency !== "delivery-id") fail();
          webhookTarget(destination.url); destinations.add(destination.id);
          if (destination.notAcceptedStatuses !== undefined && (!Array.isArray(destination.notAcceptedStatuses) || destination.notAcceptedStatuses.length > 16 ||
            new Set(destination.notAcceptedStatuses).size !== destination.notAcceptedStatuses.length || destination.notAcceptedStatuses.some((n: unknown) => !boundedInteger(n,400,599)))) fail();
          if (destination.reconcile !== undefined) {
            const reconcile = object(destination.reconcile,["url","receiptKeyRef"]);
            webhookTarget(reconcile.url); if (!id(reconcile.receiptKeyRef)) fail();
          }
        }
      }
      for (const rawSource of entry.sources) {
        const source = object(rawSource, ["connectionId", "label", "origin", "sourceGeneration", "events"]);
        if (typeof source.connectionId !== "string" || !/^[a-f0-9-]{36}$/.test(source.connectionId) || connections.has(source.connectionId) || !label(source.label) || !boundedInteger(source.sourceGeneration, 1, Number.MAX_SAFE_INTEGER)) fail();
        connections.add(source.connectionId);
        publicTarget(browserEventOrigin(source.origin));
        if (!Array.isArray(source.events) || !source.events.length || source.events.length > 32) fail();
        const events = new Set<string>();
        for (const rawEvent of source.events) {
          const event = object(rawEvent, ["id", "label", "kind", "outcome", "method", "route"]);
          if (!id(event.id) || events.has(event.id) || !label(event.label) || !["push", "notification", "network"].includes(event.kind)) fail();
          events.add(event.id);
          validateBrowserEventFields({ origin: source.origin, outcome: event.outcome,
            ...(event.method === undefined ? {} : { method: event.method }), ...(event.route === undefined ? {} : { route: event.route }),
            ...(event.kind === "network" ? { status: 0 } : {}) }, event.kind);
        }
      }
      for (const rawChoice of entry.actions) {
        const choice = object(rawChoice, ["id", "label", "description", "action", "supportsInstruction"]);
        if (!id(choice.id) || actions.has(choice.id) || !label(choice.label) || choice.description !== undefined && !label(choice.description, 1000)) fail();
        actions.add(choice.id);
        if (choice.action?.kind === "actor") {
          const action = object(choice.action, ["kind", "instruction"]);
          if (!label(action.instruction, 8000) || choice.supportsInstruction !== undefined && typeof choice.supportsInstruction !== "boolean") fail();
        } else if (choice.action?.kind === "harness") {
          const action = object(choice.action, ["kind", "digest", "contractDigest", "input", "eventInputs"]);
          if (!digest(action.digest) || !digest(action.contractDigest) || !("input" in action) || Buffer.byteLength(JSON.stringify(action)) > 32768 || choice.supportsInstruction !== undefined) fail();
          if (action.eventInputs !== undefined) {
            if (!action.eventInputs || typeof action.eventInputs !== "object" || Array.isArray(action.eventInputs) || Object.keys(action.eventInputs).length > 32) fail();
            for (const [key, path] of Object.entries(action.eventInputs)) {
              if (!id(key) || ["__proto__", "constructor", "prototype"].includes(key) || !Array.isArray(path) || !path.length || path.length > 8 ||
                path.some(part => typeof part !== "string" || !part || ["__proto__", "constructor", "prototype"].includes(part))) fail();
            }
          }
        } else if (choice.action?.kind === "webhook") {
          const action = object(choice.action,["kind","destination"]);
          if (!id(action.destination) || !destinations.has(action.destination) || choice.supportsInstruction !== undefined) fail();
        } else fail();
      }
    }
    return structuredClone(root) as BrowserWatchDeployment;
  } catch { return fail(); }
}

/** Mount the same private runner used by native sign-in. The configuration is
 * immutable for this assembly; a changed deployment cuts authority immediately
 * and takes effect through a newly constructed host. */
export function configuredBrowserWatchPolicy(options: {
  owner: string;
  configuration(): BrowserWatchDeployment | undefined;
  connections: Pick<ConnectorEngine, "browserWatchAuthority" | "browserWatchAuthorities" | "browserWatchCommitAuthority">;
  runner: NativeBrowserWatchPolicyOptions["runner"];
  library: HarnessLibrary;
  receivingAuthority: string;
  current(): boolean;
  webhooks?: Pick<ReturnType<typeof configuredBrowserWatchWebhooks>, "current" | "resolve">;
}): BrowserWatchHostPolicy | undefined {
  const config = options.configuration(), selected = config?.owners[options.owner];
  if (!config || !selected) return undefined;
  const projection = (value: BrowserWatchDeployment | undefined) => value && value.owners[options.owner]
    ? { version: value.version, ingressOrigin: value.ingressOrigin, owner: value.owners[options.owner] } : null;
  const pinned = harnessDigest(projection(config));
  const current = () => {
    try { return options.current() && harnessDigest(projection(options.configuration())) === pinned; }
    catch { return false; }
  };
  const actionMatches = (action: BrowserWatchAction) => (action.kind !== "webhook" || options.webhooks?.current(action.destination) === true) && selected.actions.some(choice => harnessDigest(choice.action) === harnessDigest(action) ||
    choice.action.kind === "actor" && choice.supportsInstruction === true && action.kind === "actor" && label(action.instruction, 8000) &&
    Object.keys(action).every(key => ["kind", "instruction"].includes(key)));
  const sourceMatches = (value: Pick<BrowserWatchConfig, "connectionId" | "connectionRevision" | "sourceGeneration" | "origin" | "kind" | "outcome" | "method" | "route">) => {
    const authority = options.connections.browserWatchCommitAuthority(value.connectionId);
    return !!authority && authority.owner === options.owner && authority.native && authority.connectionId === value.connectionId &&
      String(authority.revision) === value.connectionRevision && `https://${authority.domain}` === value.origin &&
      selected.sources.some(source => source.connectionId === authority.connectionId && source.sourceGeneration === value.sourceGeneration &&
        source.origin === value.origin && source.events.some(event => event.kind === value.kind && event.outcome === value.outcome &&
          event.method === value.method && event.route === value.route));
  };
  return context => {
    const library = options.library;
    const native = nativeBrowserWatchPolicy({ owner: options.owner, ingressOrigin: config.ingressOrigin,
      connections: options.connections, runner: options.runner, library, receivingAuthority: options.receivingAuthority,
      current, defaults: selected.defaults,
      discoverSources: async authorities => selected.sources.flatMap(source => {
        const authority = authorities.find(a => a.connectionId === source.connectionId && source.origin === `https://${a.domain}`);
        return authority ? [{ ...structuredClone(source), connectionRevision: String(authority.revision) }] : [];
      }),
      discoverActions: async signal => {
        const actions: Action[] = [];
        for (const choice of selected.actions) {
          signal.throwIfAborted();
          if (choice.action.kind === "actor") { actions.push(structuredClone(choice)); continue; }
          if (choice.action.kind === "webhook") {
            if (await options.webhooks?.resolve(choice.action.destination,signal)) actions.push(structuredClone(choice));
            continue;
          }
          if (choice.action.kind !== "harness") continue;
          const action = choice.action;
          try {
            const { artifact } = await library.resolve(action.digest);
            if (artifact.contractDigest !== action.contractDigest) continue;
            const state = harnessLibraryState(await library.journal.read(), options.owner);
            if ([...state.evaluations.values()].some(e => e.eligible === true && e.harnessDigest === action.digest &&
              e.contractDigest === action.contractDigest)) actions.push(structuredClone(choice));
          } catch { signal.throwIfAborted(); }
        }
        return actions;
      },
      nativeActions: { ...(selected.actions.some(choice => choice.action.kind === "actor") ? { actor: {
        commitCurrent: intent => {
          if (!current() || intent.event.owner !== options.owner) return false;
          return actionMatches(intent.action) && sourceMatches({ ...intent.event.fields, connectionId: intent.event.connectionId,
            connectionRevision: intent.event.connectionRevision, sourceGeneration: intent.event.generation, kind: intent.event.kind });
        },
      } } : {}), ...(options.webhooks ? { webhook: {
        resolve: (destination, _intent, signal) => options.webhooks!.resolve(destination,signal),
        commitCurrent: intent => current() && intent.event.owner === options.owner && actionMatches(intent.action) &&
          sourceMatches({ ...intent.event.fields, connectionId:intent.event.connectionId, connectionRevision:intent.event.connectionRevision,
            sourceGeneration:intent.event.generation,kind:intent.event.kind }),
      } } : {}) },
    })(context);
    return { ...native, configCurrent: value => current() && actionMatches(value.action) && sourceMatches(value) };
  };
}

/** Separate secret binding: only this authenticated owner's reference map is
 * resolved. Neither deployment JSON nor discovery contains credential values. */
export function parseBrowserWatchWebhookKeys(raw?: string): Record<string, Record<string,string>> {
  if (raw === undefined || raw === "") return {};
  const invalid = (): never => { throw Error("Invalid AIKO_BROWSER_WATCH_WEBHOOK_KEYS"); };
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 262144) invalid();
    const value = object(JSON.parse(raw),["version","owners"]);
    if (value.version !== 1 || !value.owners || typeof value.owners !== "object" || Array.isArray(value.owners) || Object.keys(value.owners).length > 64) invalid();
    for (const [owner,keys] of Object.entries(value.owners)) {
      if (!safeUserId(owner) || !keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length > 64) invalid();
      for (const [ref,key] of Object.entries(keys as object)) if (!id(ref) || ["__proto__","constructor","prototype"].includes(ref) ||
        typeof key !== "string" || key.length < 32 || key.length > 4096 || /[\r\n\0]/.test(key)) invalid();
    }
    return structuredClone(value.owners);
  } catch { return invalid(); }
}

/** Installs immutable sink bindings through the existing native channel log.
 * An ID is never rebound, even after removal/reconstruction or key rotation. */
export function configuredBrowserWatchWebhooks(options: {
  owner: string;
  destinations(): readonly BrowserWatchWebhookDestinationConfig[];
  keys(): string | undefined;
  current(): boolean;
  transport: RegistrySandboxTransport;
  journal: HarnessJournal;
  blobs: HarnessBlobStore;
  kv: WorkflowKV;
}) {
  const policies = (): WebhookDestinationPolicy[] => {
    if (!options.current()) return [];
    const keys = parseBrowserWatchWebhookKeys(options.keys());
    const owned = Object.hasOwn(keys,options.owner) ? keys[options.owner]! : {};
    return options.destinations().flatMap(destination => {
      const signingKey = Object.hasOwn(owned,destination.signingKeyRef) ? owned[destination.signingKeyRef] : undefined;
      const receiptKey = destination.reconcile && Object.hasOwn(owned,destination.reconcile.receiptKeyRef) ? owned[destination.reconcile.receiptKeyRef] : undefined;
      if (!signingKey || destination.reconcile && !receiptKey || destination.expiresAt <= Date.now()) return [];
      const {signingKeyRef:_key,reconcile,...metadata}=destination;
      return [{...metadata,owner:options.owner,revision:"1",active:true,signingKey,
        authorityRef:`browser-watch-webhook-bind:${destination.id}`,sendAuthorityRef:`browser-watch-webhook-send:${destination.id}`,
        ...(reconcile ? {reconcile:{url:reconcile.url,receiptKey:receiptKey!}} : {})}];
    });
  };
  const initial = policies(), pinned = harnessDigest(initial);
  const current = (destination?: string): boolean => {
    try {
      return options.current() && !!options.transport.sandbox.harnessGuardedJob && harnessDigest(policies()) === pinned &&
        (destination === undefined || ready.has(destination));
    } catch { return false; }
  };
  const ready = new Set<string>();
  const webhook = createWebhookAdapterHost({owner:options.owner,policies:()=>current()?policies():[],currentOwner:()=>current(),
    journal:options.journal,blobs:options.blobs,kv:options.kv,transport:createSandboxWebhookTransport(options.owner,options.transport)});
  const name = (id:string) => `browser-watch-webhook:${id}`;
  const matches = (id:string,binding:unknown) => {
    try {
      if (!binding || typeof binding !== "object") return false;
      const expected=webhook.bindingInput(id,name(id),1), actual=binding as Record<string,unknown>;
      return actual.owner===options.owner && actual.id===channelId(options.owner,name(id)) &&
        Object.entries(expected).every(([key,value])=>channelDigest(actual[key])===channelDigest(value));
    } catch { return false; }
  };
  return {
    webhook, current,
    async initialize(channels: HostedChannels): Promise<boolean> {
      let needsRecovery = false;
      if (!current()) return false;
      const retained = channelBindings(await options.journal.read(),options.owner);
      // Verify all retained identities before native recovery can visit queued work.
      for (const policy of initial) {
        const binding = retained.get(channelId(options.owner,name(policy.id)));
        if (binding && matches(policy.id,binding) && binding.generation===1) {
          ready.add(policy.id);
          if (binding.status === "pending") needsRecovery = true;
        }
      }
      for (const policy of initial) {
        if (!current()) break;
        if (retained.has(channelId(options.owner,name(policy.id)))) continue;
        await channels.run(channels.runtime.configure(webhook.bindingInput(policy.id,name(policy.id),1)));
        const binding=channelBindings(await options.journal.read(),options.owner).get(channelId(options.owner,name(policy.id)));
        if (current() && matches(policy.id,binding)) { ready.add(policy.id); needsRecovery=true; }
      }
      return needsRecovery;
    },
    async resolve(id:string,signal:AbortSignal): Promise<BrowserWatchWebhookDestination|undefined> {
      signal.throwIfAborted(); if (!current(id)) return;
      const binding=channelBindings(await options.journal.read(),options.owner).get(channelId(options.owner,name(id)));
      signal.throwIfAborted(); if (!current(id) || !binding || binding.status!=="active" || !matches(id,binding)) return;
      const policy=policies().find(p=>p.id===id)!;
      return {channel:binding.id,generation:1,authorization:policy.sendAuthorityRef,conversation:id,deadlineAt:policy.expiresAt};
    },
  };
}
