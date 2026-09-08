import { HarnessExperimentTrials } from "./harness-experiment-trials.ts";
import type { HarnessExperimentBinding } from "./harness-experiment.ts";
import { Schema } from "effect";
import { component } from "tardie/core/component";
import { intent } from "tardie/core/intent";
import { actorMethod } from "tardie/core/method/method";
import { handles } from "tardie/core/actor/contract";
import type { Event } from "tardie/core/event";
import type { HarnessSourceBinding } from "./harness-sources.ts";
import type { HarnessLibraryBinding } from "./harness-library.ts";
import type { WorkflowKV } from "./workflow-host.ts";
import type { CodeSegmentTransport } from "./code-sandbox.ts";
import type { HarnessSandboxOptions } from "./harness-sandbox.ts";
import { mediaProcessingNextWake } from "./media-processing.ts";
import {
  channelWiringNextWake,
  type ChannelWiringBindings,
} from "./channel-wiring.ts";

export interface RegistryHostBinding {
  logSources?: import("./channel-log-source.ts").ChannelLogSourceBindings;
  providerAdapters?: import("./provider-adapter.ts").ProviderAdapterHost;
  optimizationPolicy?: ReturnType<typeof import("./registry-optimization.ts").registryOptimizationPolicy>;
  optimizationTrigger?: ReturnType<typeof import("./registry-optimization.ts").registryOptimizationTrigger>;
  optimizationUnavailableReason?: string;
  optimizationAvailability?: () => string | undefined;
  management?: () => import("./registry-management.ts").RegistryManagementPolicy | undefined;
  continuations?: ReturnType<typeof import("./channel-registry.ts").channelRegistryContinuations>;
  experiments?: import("./harness-experiment.ts").HarnessExperimentBinding;
  media?: import("./media-host.ts").MediaHost;
  bootstrap?: import("tardie/core/component").Component<
    undefined,
    import("tardie/core/runtime").Self | import("tardie/core/log").EventLog
  >;
  unavailableReason?: string;
  availability?: () => string | undefined;
  defaultAuthorityRef?: string;
  sources?: HarnessSourceBinding;
  library?: HarnessLibraryBinding;
  codeTransport?: CodeSegmentTransport;
  authorizeReceiving?: ChannelWiringBindings["authorize"];
  /** Additional live result-read policy for configured tool/receiving grants. */
  authorizeCodeResult?: import("./code-harness.ts").CodeResultCustody["authorize"];
}
/** Trusted application configuration, never HTTP input. Blob custody can reuse kv;
 * source transport can use sandboxSourceTransport with the supplied native sandbox
 * and an independently resolved current authority. No implicit verifier or grants. */
export type RegistryHostFactory = (context: {
  owner: string;
  thread: string;
  kv: WorkflowKV;
  read: () => Promise<readonly Event[]>;
  sandbox?: HarnessSandboxOptions["sandbox"];
}) => RegistryHostBinding | undefined;
export function checkedRegistryBinding(
  owner: string,
  binding: RegistryHostBinding | undefined,
) {
  const library = binding?.sources?.library ?? binding?.library;
  if (
    library &&
    (library.owner !== owner || library.thread !== `user-${owner}`)
  )
    throw Error("Registry owner binding mismatch");
  if(binding?.experiments&&(binding.experiments.library!==library||binding.experiments.library.owner!==owner||binding.experiments.library.thread!==`user-${owner}`||typeof binding.experiments.prepare!=="function"||typeof binding.experiments.propose!=="function"||typeof binding.experiments.authorize!=="function"))throw Error("Experiment binding scope or policy mismatch");
  return binding;
}
export function nativeRegistryExperiments(binding: HarnessExperimentBinding | undefined) {
  return binding?.trials instanceof HarnessExperimentTrials && binding.trials.options.binding === binding.library ? binding : undefined;
}
export function registryReadiness(
  binding: RegistryHostBinding | undefined,
  codeMode: boolean,
) {
  const library = binding?.sources?.library ?? binding?.library;
  const unavailable = binding?.availability?.() ?? binding?.unavailableReason;
  const optimizationUnavailable = unavailable ?? binding?.optimizationAvailability?.();
  return {
    ...(binding?.providerAdapters?.readiness() ?? {providerAdapters:false}),
    logSources: !!library?.verifiers.size && !!binding?.authorizeReceiving && codeMode && !unavailable && !!binding?.logSources?.current() && !!binding.logSources.grants().some(g => g.owner === library.owner && g.active && g.expiresAt > Date.now()),
    logSourceReason: binding?.logSources ? "explicit_source_and_receiving_grants_required" : "source_grants_not_configured",
    channelManagement: !!binding?.management?.()?.parents.length && !unavailable,
    experiments: !!nativeRegistryExperiments(binding?.experiments) && codeMode && !optimizationUnavailable,
    ...(binding?.optimizationPolicy ? { optimizationPolicy: binding.optimizationPolicy } : {}),
    optimizationReason: optimizationUnavailable ?? (!codeMode ? "code_mode_disabled" : nativeRegistryExperiments(binding?.experiments) ? "trusted_optimizer_configured" : binding?.experiments ? "native_trial_host_not_configured" : binding?.optimizationUnavailableReason ?? "trusted_optimizer_not_configured"),
    registry: !!library && !unavailable,
    nativeMedia: !!binding?.media && !unavailable,
    mediaReason: binding?.media&&!unavailable?"lazy_owned_compute_media":"isolated_media_not_configured",
    sources: !!binding?.sources && !unavailable,
    trustedVerifiers: !!library?.verifiers.size,
    internalChannels:
      !!library?.verifiers.size &&
      !!binding?.authorizeReceiving &&
      !unavailable,
    codeMode,
    ...(binding?.defaultAuthorityRef
      ? {
          internalAuthorityRef: binding.defaultAuthorityRef,
          runtimeChecked: false,
        }
      : {}),
    reason:
      unavailable ??
      (!library
        ? "trusted_registry_not_configured"
        : !library.verifiers.size
          ? "trusted_verifiers_not_configured"
          : !codeMode
            ? "code_transport_not_configured"
            : "ready"),
  };
}
export const hostedChannelDeadlineKey = (e: Event) =>
  e.type === "AikoHostedChannelDeadline"
    ? `aiko-hosted-channel-deadline:${e.id}`
    : undefined;
/** One native method alarm covers retained registry work, including an internal
 * media acquisition waiter without any external channel binding. */
export function hostedRegistryNextWake(events: readonly Event[], owner: string) {
  const times = [channelWiringNextWake(events, owner), mediaProcessingNextWake(events, owner)]
    .filter((at): at is number => at !== undefined);
  return times.length ? Math.min(...times) : undefined;
}
export const hostedChannelWaitMethod = actorMethod({
  input: Schema.String,
  output: Schema.String,
  event: (call) => ({
    type: "AikoHostedChannelDeadline",
    id: call.invocation.id,
    owner: call.input,
    at: call.at,
    call: { invocation: call.invocation, deadlineAt: call.deadlineAt },
  }),
  projection: {
    initial: () => [] as Event[],
    step: (s: Event[], e: Event) => [...s, e],
    output: (events) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => {
        const record = events.find(
          (e) =>
            e.type === "AikoHostedChannelDeadline" && e.id === invocation.id,
        );
        if (!record) return undefined;
        const at = hostedRegistryNextWake(events, String(record.owner));
        return at === undefined ||
          // The aggregate cannot still need this earlier alarm once every
          // eligible waiter has moved past it (for example after cancellation).
          at > Number((record.call as any).deadlineAt) ||
          events.some(
            (e) =>
              e.type === "AlarmFired" &&
              Number(e.at) >= Number((record.call as any).deadlineAt),
          )
          ? { status: "completed" as const, output: "settled" }
          : { status: "pending" as const };
      },
    }),
  },
});
/** Projects retained channel and media deadlines onto the native host method
 * alarm. Each component remains its own waiter/continuation authority. */
export function hostedChannelDeadlines(owner: string) {
  return handles(
    hostedChannelWaitMethod,
    component({
      name: "aiko.hosted-channel-deadlines",
      keys: {
        prefixes: ["aiko-hosted-channel-deadline:"],
        keyOf: hostedChannelDeadlineKey,
      },
      initial: () => [] as Event[],
      step: (s: Event[], e: Event) => [...s, e],
      output: (events) => {
        const at = hostedRegistryNextWake(events, owner),
          id = `${owner}:${at}`;
        return {
          view: undefined,
          transitions:
            at === undefined ||
            events.some(
              (e) => e.type === "AikoHostedChannelDeadline" && e.id === id,
            )
              ? []
              : [
                  intent({
                    key: hostedChannelDeadlineKey({
                      type: "AikoHostedChannelDeadline",
                      id,
                    })!,
                    input: at,
                    events: (deadlineAt, now) => [
                      hostedChannelWaitMethod.event({
                        invocation: { method: "channelWait", id, epoch: 0 },
                        deadlineAt,
                        input: owner,
                        at: now,
                      }),
                    ],
                  }),
                ],
        };
      },
    }),
  );
}
export const registryExternalEventAllowed = (e: Event) =>
  !e.type.startsWith("AikoLearning") &&
  !e.type.startsWith("AikoMedia") &&
  !e.type.startsWith("AikoHarness") &&
  !e.type.startsWith("AikoChannel") &&
  !["BlockedOn", "AikoHostedChannelDeadline", "BrowserToolResultObserved", "AikoKnowledgeChanged", "AikoKnowledgeUnchanged", "AikoPrivateLoginObserved"].includes(e.type) &&
  e.source !== "channel-waiter" &&
  (e.call as any)?.invocation?.method !== "channelWait";

/** Existing Codegraff lifecycle metadata; these records confer no registry authority. */
export function registrySandboxEventKey(e: Event) {
  return [
    "AikoBrowserSetupProgress",
    "AikoSandboxProvisioning",
    "AikoSandboxStarting",
    "AikoSandboxReady",
    "AikoSandboxStopped",
    "AikoSandboxUnavailable",
  ].includes(e.type) &&
    typeof e.owner === "string" &&
    typeof e.at === "number" &&
    Number.isFinite(e.at)
    ? `aiko-registry-sandbox:${e.owner}:${e.type}:${e.at}:${String(e.stage ?? "")}`
    : undefined;
}
