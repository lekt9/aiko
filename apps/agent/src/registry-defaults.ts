import { observedNetworkHarnessBinding, type ObservedNetworkHarnessOptions } from "./harness-observed-network.ts";
import { browserWatchHarnessDefinitions } from "./browser-watches.ts";
import { channelLogSourceHarnessDefinitions } from "./channel-log-source.ts";
import { createProviderAdapterHost } from "./provider-adapter.ts";
import { createRegistryOptimization, registryOptimizationPolicy, type RegistryOptimizationOptions } from "./registry-optimization.ts";
import { createMediaHost } from "./media-host.ts";
import { Effect } from "effect";
import { component, type Component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import { builtinHarnessDefinitions } from "./harness-builtins.ts";
import {
  HarnessLibrary,
  harnessBlobStore,
  harnessDigest,
  harnessLibraryEventKey,
  harnessLibraryState,
  type HarnessLibraryBinding,
} from "./harness-library.ts";
import {
  createHarnessSandboxBinding,
  type HarnessSandboxClient,
  type HarnessSandboxOptions,
  type HarnessSandboxAuthority,
} from "./harness-sandbox.ts";
import { sandboxSourceTransport } from "./harness-source-sandbox.ts";
import type { WorkflowKV } from "./workflow-host.ts";
import type { CodeSegmentTransport } from "./code-sandbox.ts";
import type { RegistryHostBinding } from "./registry-host.ts";
export interface RegistrySandboxTransport {
  assets?: HarnessSandboxOptions["assets"];
  sandbox: HarnessSandboxClient;
  codeTransport: CodeSegmentTransport;
  placement: "local" | "codegraff";
}
export interface RegistryDefaultPolicy {
  owner: string;
  active: boolean;
  revision: string;
}
export const DEFAULT_REGISTRY_ORIGINS = Object.freeze([
  "https://api.github.com",
  "https://raw.githubusercontent.com",
  "https://skills.sh",
  "https://www.skills.sh",
]);
export const defaultReceivingAuthority = (owner: string) =>
  `registry-internal:${owner}`;
export interface DefaultRegistryOptions {
  /** Explicit current session/read grants and independently trusted contracts. Off when absent. */
  observedReads?: ObservedNetworkHarnessOptions & { definitions: readonly import("./harness-builtins.ts").BuiltinHarnessDefinition[] };
  optimization?: Pick<RegistryOptimizationOptions, "instance" | "routing" | "readThread" | "currentOwner">;
  logSources?: import("./channel-log-source.ts").ChannelLogSourcePolicy;
  /** Register fixed watch mappers only for an explicitly configured host bridge. */
  browserWatches?: boolean;
  providerAdapters?: import("./provider-adapter.ts").ProviderAdapterPolicies;
  management?: () => import("./registry-management.ts").RegistryManagementPolicy | undefined;
  owner: string;
  thread: string;
  kv: WorkflowKV;
  read?: () => Promise<readonly Event[]>;
  append?: (events:Event[]) => Promise<void>;
  serialize?: <T>(fn:()=>Promise<T>)=>Promise<T>;
  transport?: RegistrySandboxTransport;
  policy: () => RegistryDefaultPolicy;
  guard: (value: unknown) => void;
  missingReason?: string;
  disabledReason?: string;
}
/** Pure assembly: no KV writes, log appends, sandbox allocation or provider calls.
 * Defaults expose no session credentials. Network reads require the explicit observedReads binding. */
export function defaultRegistryBinding(
  options: DefaultRegistryOptions,
): RegistryHostBinding {
  const { owner, thread, transport } = options;
  if (thread !== `user-${owner}`)
    throw Error("Default registry thread mismatch");
  if (!transport)
    return {
      unavailableReason:
        options.missingReason ?? "sandbox_transport_not_configured",
    };
  const initial = options.policy();
  if (initial.owner !== owner || !initial.active || !initial.revision)
    return {
      unavailableReason:
        options.disabledReason ?? "default_registry_grant_unavailable",
    };
  const definitions = [...builtinHarnessDefinitions(), ...(options.observedReads?.definitions ?? []), ...(options.logSources || options.browserWatches ? channelLogSourceHarnessDefinitions() : []), ...(options.browserWatches ? browserWatchHarnessDefinitions() : []),...(options.providerAdapters?.(owner).map(p=>p.definition)??[]),...(options.management?.()?.parents.map(p=>p.definition)??[])],
    verifiers = new Map(
      definitions.map((d) => [d.verifier.digest, d.verifier]),
    );
  const policy = () => {
    const current = options.policy();
    if (current.owner !== owner || !current.active || !current.revision)
      throw Error("Default registry authority unavailable");
    return current;
  };
  const current = async (
    signal: AbortSignal,
    source = false,
  ): Promise<HarnessSandboxAuthority> => {
    const grant = policy(),
      runtimeDigest = await transport.sandbox.harnessEnvironment(signal);
    if (harnessDigest(policy()) !== harnessDigest(grant))
      throw Error("Default registry authority changed");
    return {
      owner,
      active: true,
      runtimeDigest,
      ...(!source && transport.sandbox.pythonRuntimeLockDigest ? {pythonRuntimeLockDigest:transport.sandbox.pythonRuntimeLockDigest} : {}),
      contextRef: harnessDigest({
        version: 1,
        grant,
        origins: DEFAULT_REGISTRY_ORIGINS,
      }),
      authorityRef: harnessDigest({
        owner,
        revision: grant.revision,
        scope: source ? "public-registry-read" : "pure-js",
      }),
      sessionRevision: null,
      effects: ["read"],
      origins: source ? [...DEFAULT_REGISTRY_ORIGINS] : [],
      methods: source ? ["GET"] : [],
      budget: { requests: source ? 8 : 0, wallMs: !source && transport.sandbox.pythonRuntimeLockDigest ? 300000 : 30000, outputBytes: !source && transport.sandbox.pythonRuntimeLockDigest ? 2 * 1024 * 1024 : 262144 },
    };
  };
  const sandboxOptions = {
    owner,
    thread,
    placement: transport.placement,
    sandbox: transport.sandbox,
    assets: transport.assets,
    current: (signal: AbortSignal) => current(signal),
  };
  const execution = createHarnessSandboxBinding(sandboxOptions);
  let library: HarnessLibraryBinding = {
    owner,
    thread,
    blobs: harnessBlobStore(options.kv),
    verifiers,
    guard: options.guard,
    context: execution.context,
    reconcile: execution.reconcile,
    authorize: async (artifact, contract, context, input, signal) => {
      if (artifact.runtime !== "javascript" || contract.effect !== "read")
        throw Error("Default registry permits pure JavaScript only");
      return execution.authorize(artifact, contract, context, input, signal);
    },
    // Evaluation is a separate standing grant: only host-owned stateless
    // contracts and their exact fixed cases. A candidate may change source, not
    // the checker, fixture, effect declaration or dependency authority.
    authorizeEvaluation: async (artifact, contract, context, fixture, signal) => {
      signal.throwIfAborted();
      policy();
      const trusted = [...builtinHarnessDefinitions(), ...(options.logSources || options.browserWatches ? channelLogSourceHarnessDefinitions() : []), ...(options.browserWatches ? browserWatchHarnessDefinitions() : [])].find(
        d => harnessDigest(d.contract) === harnessDigest(contract),
      ) ?? options.providerAdapters?.(owner).find(p => p.active && p.expiresAt > Date.now() && harnessDigest(p.definition.contract) === harnessDigest(contract))?.definition ?? options.management?.()?.parents.find(p => harnessDigest(p.definition.artifact) === harnessDigest(artifact) &&
        harnessDigest(p.definition.contract) === harnessDigest(contract))?.definition;
      if (!trusted || artifact.runtime !== "javascript" || contract.effect !== "read" ||
          artifact.dependencies.length !== 0 || artifact.contractDigest !== harnessDigest(contract) ||
          !trusted.verifier.cases.some(c => harnessDigest(c) === harnessDigest(fixture))) return false;
      return execution.authorize(artifact, contract, context, fixture.input, signal);
    },
    execute: async (job, signal) => {
      if (
        job.artifact.runtime !== "javascript" ||
        job.contract.effect !== "read"
      )
        throw Error("Default registry permits pure JavaScript only");
      return execution.execute(job, signal);
    },
  };
  if (options.observedReads) library = observedNetworkHarnessBinding(library, options.observedReads);
  const bootstrap: Component<undefined, Self | EventLog> = component({
    name: "aiko.registry-defaults",
    initial: () => [] as Event[],
    step: (events: Event[], e: Event) => [...events, e],
    output: (events) => {
      if (
        !events.some(
          (e) => e.type === "MessageReceived" || e.type === "AikoAccountOpened",
        )
      )
        return { view: undefined, transitions: [] };
      const state = harnessLibraryState(events, owner);
      return {
        view: undefined,
        transitions: definitions
          .filter((d) => !state.candidates.has(harnessDigest(d.artifact)))
          .map((definition) =>
            effect({
              key: harnessLibraryEventKey({
                type: "AikoHarnessCandidateRecorded",
                owner,
                id: harnessDigest(definition.artifact),
              })!,
              input: definition,
              act: (definition) =>
                Effect.gen(function* () {
                  const self = yield* Self,
                    log = yield* EventLog;
                  if (self.actor !== "aiko" || self.thread !== thread)
                    throw Error("Default registry bootstrap scope mismatch");
                  policy();
                  const native = new HarnessLibrary(library, {
                    read: () => Effect.runPromise(log.read),
                    append: (events) =>
                      Effect.runPromise(log.append(events)).then(
                        () => undefined,
                      ),
                  });
                  yield* Effect.promise(async () => {
                    await native.registerContract(definition.contract);
                    await native.record(definition.artifact);
                  });
                  return [];
                }),
            }),
          ),
      };
    },
  });
  const optimization = options.optimization && options.read && options.append
    ? createRegistryOptimization({ ...options.optimization, library, journal: { read: options.read, append: options.append },
      current: () => { try { return policy(); } catch { return { active: false, revision: "revoked" }; } },
      sandbox: sandboxOptions }) : undefined;
  return {
    ...(optimization ? { experiments: optimization.binding, optimizationTrigger: optimization.trigger, optimizationPolicy: registryOptimizationPolicy(), optimizationAvailability: optimization.availability } : { optimizationUnavailableReason: "shared_model_budget_or_trial_host_not_configured" }),
    ...(options.read&&options.append&&options.serialize&&"pythonRuntimeLockDigest" in transport.sandbox ? {media:createMediaHost({owner,library,sandbox:transport.sandbox,placement:transport.placement,kv:options.kv,journal:{read:options.read,append:options.append},serialize:options.serialize,current:()=>{try{const p=policy();return {active:true,revision:harnessDigest([p,"owned-media-read/v1"])};}catch{return {active:false,revision:"revoked"};}}})}:{}),
    availability: () => {
      try {
        policy();
        return undefined;
      } catch {
        return "default_registry_grant_unavailable";
      }
    },
    library,
    management:()=>{try{policy();return options.management?.();}catch{return undefined;}},
    sources: {
      library,
      transport: sandboxSourceTransport({
        ...sandboxOptions,
        current: (signal) => current(signal, true),
      }),
      authorize: async (repository, action, signal) => {
        signal.throwIfAborted();
        policy();
        return action === "discover"
          ? repository === "github.com"
          : /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository);
      },
    },
    logSources: options.logSources || options.browserWatches ? { grants: () => (options.logSources?.(owner) ?? []).filter(grant => grant.owner === owner && grant.receivingAuthority === defaultReceivingAuthority(owner) && grant.active && grant.expiresAt > Date.now() && Number.isInteger(grant.maxBindings) && grant.maxBindings > 0 && grant.maxBindings <= 32), current: () => { try { policy(); return true; } catch { return false; } } } : undefined,
    providerAdapters: options.providerAdapters && options.read && options.append ? createProviderAdapterHost({owner,library,
      journal:{read:options.read,append:options.append},kv:options.kv,transport,policies:options.providerAdapters,
      currentOwner:()=>{try{policy();return true;}catch{return false;}}}) : undefined,
    codeTransport: transport.codeTransport,
    bootstrap,
    defaultAuthorityRef: defaultReceivingAuthority(owner),
    authorizeReceiving: async (bound, authority) => {
      try {
        policy();
        return (
          bound === owner && authority === defaultReceivingAuthority(owner)
        );
      } catch {
        return false;
      }
    },
  };
}
