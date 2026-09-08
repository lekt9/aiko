import { browserEventOrigin, validateBrowserEventFields } from "./browser-events.ts";
import { publicTarget } from "./browser-proxy.ts";
import { nativeBrowserWatchPolicy, type NativeBrowserWatchPolicyOptions } from "./browser-watch-policy.ts";
import { HarnessLibrary, harnessDigest, harnessLibraryState } from "./harness-library.ts";
import type { BrowserWatchHostPolicy } from "./channel-host.ts";
import type { BrowserWatchConfig, BrowserWatchDiscovery, BrowserWatchAction } from "./browser-watches.ts";
import type { ConnectorEngine } from "./connectors.ts";
import { safeUserId } from "./security.ts";

type Source = Omit<BrowserWatchDiscovery["sites"][number], "connectionRevision" | "expiresAt">;
type Action = BrowserWatchDiscovery["actions"][number];
export interface BrowserWatchDeployment {
  version: 1;
  ingressOrigin: string;
  owners: Record<string, {
    sources: Source[];
    actions: Action[];
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
      const entry = object(value, ["sources", "actions", "defaults"]);
      if (!Array.isArray(entry.sources) || entry.sources.length > 128 || !Array.isArray(entry.actions) || entry.actions.length > 128) fail();
      const defaults = object(entry.defaults, ["expiresInMs", "backlog", "maxOccurrences"]);
      if (!boundedInteger(defaults.expiresInMs, 1000, 86400000) || !boundedInteger(defaults.backlog, 1, 128) || !boundedInteger(defaults.maxOccurrences, 1, 1000000)) fail();
      const connections = new Set<string>(), actions = new Set<string>();
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
        } else {
          // The remote webhook transport cannot yet enforce current watch
          // authority at its physical network boundary. Do not advertise it.
          fail();
        }
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
  const actionMatches = (action: BrowserWatchAction) => selected.actions.some(choice => harnessDigest(choice.action) === harnessDigest(action) ||
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
      nativeActions: selected.actions.some(choice => choice.action.kind === "actor") ? { actor: {
        commitCurrent: intent => {
          if (!current() || intent.event.owner !== options.owner) return false;
          return actionMatches(intent.action) && sourceMatches({ ...intent.event.fields, connectionId: intent.event.connectionId,
            connectionRevision: intent.event.connectionRevision, sourceGeneration: intent.event.generation, kind: intent.event.kind });
        },
      } } : undefined,
    })(context);
    return { ...native, configCurrent: value => current() && actionMatches(value.action) && sourceMatches(value) };
  };
}
