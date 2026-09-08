import { Effect } from "effect";
import { actor } from "tardie/core/actor";
import { component, deriveComponent } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import type { Event } from "tardie/core/event";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import { threadCreatedOf } from "tardie/core/thread";
import { builtinHarnessDefinitions } from "./harness-builtins.ts";
import { HarnessExperiment, type HarnessExperimentBinding, type HarnessExperimentBrief, type HarnessExperimentRequest } from "./harness-experiment.ts";
import { harnessExperimentState, harnessExperimentStatus } from "./harness-experiment-log.ts";
import { HarnessExperimentTrials, harnessExperimentTrialLifecycle, harnessExperimentTrialEventKey } from "./harness-experiment-trials.ts";
import { harnessDigest, harnessLibraryEventKey, harnessLibraryState, type HarnessDigest, type HarnessJournal, type HarnessLibraryBinding } from "./harness-library.ts";
import { createHarnessReflection, type HarnessReflectionOptions } from "./harness-reflection.ts";
import type { HarnessSandboxOptions } from "./harness-sandbox.ts";
import type { ModelRoutingBudget, ModelRoutingConfig, ModelRoutingEnv } from "./model-routing.ts";

/** Standing host policy, deliberately not a tool argument. One experiment per
 * retained stable generation; at most one proposal and four fixed case sweeps.
 * Fixture runs, acquisitions and experiment trials cannot trigger themselves. */
export function registryOptimizationEvidence(events: readonly Event[], owner: string) {
  const state = harnessLibraryState(events, owner);
  for (const head of state.heads.values()) {
    if (head.type !== "AikoHarnessPromoted") continue;
    const definition = builtinHarnessDefinitions().find(d => harnessDigest(d.contract) === head.contractDigest);
    if (!definition || definition.contract.effect !== "read") continue;
    const evidence = events.slice(events.indexOf(head) + 1).filter(e => e.type === "AikoHarnessRunStarted" && e.owner === owner &&
      e.harnessDigest === head.harnessDigest && e.contextDigest === head.contextDigest && e.caseId == null &&
      Number(e.at) >= Number(head.at) && (() => {
        const witness = state.witnesses.get(String(e.id));
        return !!witness && witness.operationId === e.id && witness.harnessDigest === e.harnessDigest && witness.contextDigest === e.contextDigest;
      })())
      .map(e => String(e.id));
    const distinct = [...new Set(evidence)];
    if (distinct.length < 3) continue;
    const id = `automatic:${harnessDigest([owner, head.id, head.generation]).slice(7)}`;
    if (events.some(e => e.owner === owner && (e.type === "AikoHarnessOptimizationTriggered" && e.id === id ||
      e.type === "AikoHarnessExperimentRegistered" && e.experimentId === id))) continue;
    return { id, head, definition, evidence: distinct.slice(0, 3) };
  }
  return undefined;
}

/** Uses the existing experiment controller and keyed native effect. Assembly and
 * projection perform no writes, inference or sandbox work. */
export function registryOptimizationTrigger(binding: HarnessExperimentBinding) {
  const { owner, thread } = binding.library;
  return component({
    name: "aiko.registry-optimization",
    initial: () => [] as Event[],
    step: (rows: Event[], e: Event) => [...rows, e],
    output: rows => {
      const eligible = registryOptimizationEvidence(rows, owner);
      if (!eligible) return { view: undefined, transitions: [] };
      return { view: undefined, transitions: [effect({
        key: `aiko-harness:${owner}:AikoHarnessOptimizationTriggered:${eligible.id}`,
        input: { id: eligible.id, evidenceDigest: harnessDigest(eligible.evidence) },
        act: (input, signal) => Effect.gen(function* () {
          const self = yield* Self, log = yield* EventLog;
          if (self.actor !== "aiko" || self.thread !== thread) throw Error("Optimizer scope mismatch");
          const current = registryOptimizationEvidence(yield* log.read, owner);
          if (!current || current.id !== input.id || harnessDigest(current.evidence) !== input.evidenceDigest) return [];
          const request: HarnessExperimentRequest = {
            id: input.id, baselineDigest: current.head.harnessDigest as HarnessDigest,
            mutableFiles: [current.definition.artifact.entrypoint], repeats: 2,
            policy: { version: 1, objectives: [{ metric: "latencyMs", direction: "min", tolerance: 1 }], qualityTolerance: 0 },
            limits: { candidates: 1, runs: current.definition.verifier.cases.length * 4,
              wallMs: 120000, proposalTokens: 1024, costUsd: 0.1 },
          };
          const experiment = new HarnessExperiment(binding, {
            read: () => Effect.runPromise(log.read),
            append: events => Effect.runPromise(log.append(events)).then(() => undefined),
          });
          const status = yield* Effect.tryPromise({ try: () => experiment.start(request, signal), catch: () => Error("Optimizer unavailable") })
            .pipe(Effect.map(() => "started"), Effect.catch(() => Effect.succeed("unavailable")));
          return [{ type: "AikoHarnessOptimizationTriggered", owner, id: input.id,
            evidenceDigest: input.evidenceDigest, status, at: Date.now() }];
        }),
      })] };
    },
  });
}


export interface RegistryOptimizationOptions {
  library: HarnessLibraryBinding;
  journal: HarnessJournal;
  instance: string;
  routing: HarnessReflectionOptions["routing"];
  current(): { active: boolean; revision: string };
  /** Current owner/caller authority, independent of permission to execute/spend. */
  currentOwner(): boolean;
  readThread(thread: string): Promise<readonly Event[]>;
  sandbox: Omit<HarnessSandboxOptions, "owner" | "thread">;
}
/** Trusted host assembly only. No preparation, reservation, inference or log
 * append occurs until the native controller drives an authorized operation. */
export function createRegistryOptimization(options: RegistryOptimizationOptions) {
  const { library, journal } = options;
  const initial = options.current();
  const regime: Record<string, string> = {
    hostPolicy: harnessDigest(initial), fixture: "trusted-stateless-js/v1", cache: "fresh-native-child",
  };
  const active = () => initial.active && options.current().active && harnessDigest(options.current()) === regime.hostPolicy;
  const authorize: HarnessExperimentBinding["authorize"] = async (action, brief, signal) => {
    signal.throwIfAborted();
    if (action === "cancel") {
      if (!options.currentOwner() || library.thread !== `user-${library.owner}`) return false;
      const registered = harnessExperimentState(await journal.read(), library.owner, brief.id).registered;
      if (!registered || registered.briefDigest !== harnessDigest(brief)) return false;
      const retained = await library.blobs.get(library.owner, registered.briefRef as HarnessDigest);
      signal.throwIfAborted();
      return harnessDigest(retained) === registered.briefDigest && options.currentOwner();
    }
    if (!active() || brief.regimeDigest !== harnessDigest(regime) || brief.repeats !== 2 ||
      brief.limits.candidates !== 1 || brief.limits.runs > 48 || brief.limits.wallMs > 120000 ||
      brief.limits.proposalTokens > 1024 || brief.limits.costUsd > 0.1 || brief.deadlineAt <= Date.now()) return false;
    const trusted = builtinHarnessDefinitions().find(d => harnessDigest(d.contract) === brief.contractDigest);
    if (!trusted || trusted.contract.effect !== "read" || brief.datasetDigest !== harnessDigest(trusted.verifier.cases) ||
      brief.mutableFiles.length !== 1 || brief.mutableFiles[0] !== trusted.artifact.entrypoint) return false;
    const rows = await journal.read(), state = harnessExperimentState(rows, library.owner, brief.id);
    if (state.cancelled || state.settled || state.noHypothesis || state.tokenExceeded || state.budgetDenied) return false;
    const head = [...harnessLibraryState(rows, library.owner).heads.values()].find(e => e.type === "AikoHarnessPromoted" &&
      e.contractDigest === brief.contractDigest && e.contextDigest === brief.contextDigest);
    return !!head && head.harnessDigest === brief.baselineDigest && head.generation === brief.initialGeneration &&
      harnessDigest(await library.context(signal)) === brief.contextDigest && active();
  };
  const reflection = createHarnessReflection({ library, journal, instance: options.instance, routing: options.routing, regime,
    authorize: async (input, signal) => {
      signal.throwIfAborted();
      const state = harnessExperimentState(await journal.read(), library.owner, input.experimentId);
      if (!state.registered || !active()) return false;
      const brief = await library.blobs.get(library.owner, state.registered.briefRef as HarnessDigest);
      if (harnessDigest(brief) !== state.registered.briefDigest) return false;
      return authorize("propose", brief as HarnessExperimentBrief, signal);
    },
  });
  regime.model = harnessDigest(reflection.policy());
  const binding: HarnessExperimentBinding = {
    library, regime, authorize, propose: reflection.propose, recoverProposal: reflection.recoverProposal,
    prepare: async (input, signal) => {
      signal.throwIfAborted();
      if (!active() || input.regimeDigest !== harnessDigest(regime) || !builtinHarnessDefinitions().some(d =>
        d.verifier.cases.some(c => harnessDigest(c) === harnessDigest(input.fixture)))) throw Error("Controlled fixture unavailable");
      return { regimeDigest: input.regimeDigest, evidence: ["trusted-stateless-js:no-external-reset"], costUsd: 0 };
    },
  };
  binding.trials = new HarnessExperimentTrials({ binding: library, journal, readThread: options.readThread,
    sandbox: async (_scope, signal) => { signal.throwIfAborted(); if (!active()) throw Error("Trial policy unavailable"); return options.sandbox; },
    authorize: async (scope, signal) => {
      const state = harnessExperimentState(await journal.read(), library.owner, scope.experimentId);
      const reservation = state.reservations.get(scope.operationId);
      if (!state.registered || scope.owner !== library.owner || scope.parentThread !== library.thread ||
        reservation?.kind !== "trial" || reservation.harnessDigest !== scope.harnessDigest ||
        reservation.phase !== scope.phase || reservation.caseRef !== harnessDigest(scope.caseId) || reservation.repeat !== scope.repeat) return false;
      const brief = await library.blobs.get(library.owner, state.registered.briefRef as HarnessDigest);
      if (harnessDigest(brief) !== state.registered.briefDigest) return false;
      return authorize("advance", brief as HarnessExperimentBrief, signal);
    },
  });
  return { binding, trigger: registryOptimizationTrigger(binding), availability: () => active() ? undefined : "optimizer_policy_changed" };
}

/** Select only from native parent lineage, never payload owner or child hash.
 * Full workers check private execution authority before jobs; lifecycle workers
 * require only the trusted parent read and cannot execute or hydrate fixtures. */
export function registryTrialActor(
  resolve: (owner: string) => HarnessExperimentBinding | undefined,
  recovery?: (owner: string) => ReturnType<typeof harnessExperimentTrialLifecycle> | undefined,
) {
  return actor({ name: "aiko", methods: {}, components: [component({
    name: "aiko.registry-trial-host",
    keys: { prefixes: ["aiko-harness-trial:", "aiko-harness:"], keyOf: e => harnessExperimentTrialEventKey(e) ?? harnessLibraryEventKey(e) },
    initial: () => [] as Event[], step: (rows: Event[], e: Event) => [...rows, e],
    output: rows => {
      const parent = threadCreatedOf(rows)?.parent;
      if (parent?.actor !== "aiko" || !parent.thread.startsWith("user-")) return { view: undefined, transitions: [] };
      const owner = parent.thread.slice(5), binding = resolve(owner);
      if (binding && (binding.library.owner !== owner || binding.library.thread !== parent.thread)) return { view: undefined, transitions: [] };
      // worker() filters Work/Cancelled against the exact native parent link and
      // derived child identity. A foreign first event cannot select its binding.
      const worker = binding?.trials?.worker() ?? recovery?.(owner)?.worker();
      return worker ? deriveComponent(worker, rows) : { view: undefined, transitions: [] };
    },
  })] });
}

/** These are standing host limits, not caller-selected grants. No fixture values
 * or held-out case identifiers are exposed through discovery. */
export const registryOptimizationPolicy = () => ({
  version: 1,
  scope: "trusted-stateless-javascript-builtins",
  candidates: 1, repeats: 2, maxRuns: 48, wallMs: 120000,
  proposalTokens: 1024, costUsd: 0.1,
  automaticAfterCheckedRuns: 3, automaticPerStableGeneration: 1,
  capabilities: builtinHarnessDefinitions().map(d => ({
    name: d.artifact.name, contractDigest: harnessDigest(d.contract),
    mutableFiles: [d.artifact.entrypoint], runs: d.verifier.cases.length * 4,
  })),
});

/** Shared readable host constructor. Returns unavailable instead of creating a
 * route without its selected secret or without the conversation's exact ledger. */
export function registryOptimizationHostOptions(options: {
  owner: string;
  instance: string;
  config?: ModelRoutingConfig;
  env: ModelRoutingEnv;
  budget?: ModelRoutingBudget;
  fetch?: HarnessReflectionOptions["routing"]["fetch"];
  readThread: RegistryOptimizationOptions["readThread"];
  currentOwner: RegistryOptimizationOptions["currentOwner"];
}): Pick<RegistryOptimizationOptions, "instance" | "routing" | "readThread" | "currentOwner"> | undefined {
  if (!options.budget || !options.config || !options.env[options.config.roles.conversation.secretEnv]) return undefined;
  return {
    instance: options.instance,
    routing: { owner: options.owner, config: options.config, env: options.env,
      budget: options.budget, fetch: options.fetch },
    readThread: options.readThread,
    currentOwner: options.currentOwner,
  };
}

/** Owner-authenticated host API for stopping retained work without spending or
 * executing a code segment. The public input is an ID, never a native event. */
export async function registryExperimentApi(request: Request, options: {
  owner: string;
  journal: HarnessJournal;
  currentOwner(): boolean;
  wake(): Promise<void>;
}): Promise<Response> {
  const match = /^\/api\/harness\/experiments\/([A-Za-z0-9._:%-]{1,480})\/(cancel|status)$/.exec(new URL(request.url).pathname);
  if (!match || request.method !== (match[2] === "cancel" ? "POST" : "GET")) return Response.json({ error: "invalid_experiment_operation" }, { status: 400 });
  if (!options.currentOwner()) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const id = decodeURIComponent(match[1]!);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) throw Error("Invalid ID");
    let rows = await options.journal.read();
    const state = harnessExperimentState(rows, options.owner, id);
    if (!state.registered || state.registered.id !== id) throw Error("Owned experiment unavailable");
    request.signal.throwIfAborted();
    if (!options.currentOwner()) return Response.json({ error: "forbidden" }, { status: 403 });
    // Stopping retained work requires current owner authority, never permission
    // to spend, a model route, or hydration of the private experiment brief.
    if (match[2] === "cancel" && !state.cancelled && !state.settled) {
      await options.journal.append([{ type: "AikoHarnessExperimentCancelled", owner: options.owner,
        id, experimentId: id, at: Date.now() }]);
      rows = await options.journal.read();
    }
    const result = harnessExperimentStatus(rows, options.owner, id);
    if (match[2] === "cancel") await options.wake();
    request.signal.throwIfAborted();
    if (!options.currentOwner()) return Response.json({ error: "forbidden" }, { status: 403 });
    return Response.json(result);
  } catch {
    return Response.json({ error: "owned_experiment_unavailable" }, { status: 409 });
  }
}
