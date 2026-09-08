import { browserWatchHarnessActions } from "./browser-watch-actions.ts";
import { browserWatchActorActions } from "./browser-watch-actor-actions.ts";
import { browserWatchWebhookActions, browserWatchWebhookPermitRequired, type BrowserWatchWebhookBinding } from "./browser-watch-webhook-actions.ts";
import { channelControlState, controlOperationId } from "./channel-controls.ts";
import { browserEventKey, browserEventAppendAllowed, createBrowserEventAdmission, type BrowserProducerGrant } from "./browser-events.ts";
import { browserWatchEventKey, browserWatchAppendAllowed, createBrowserWatches, type BrowserWatchBindings, type BrowserWatchDispatch } from "./browser-watches.ts";
import {
  createChannelLogSources,
  channelLogSourceEventKey,
  channelLogSourceAppendAllowed,
  type ChannelLogSourceBindings,
} from "./channel-log-source.ts";
import { channelSealEvent, channelOpenEvent } from "./channel-custody.ts";
import type { HarnessBlobStore } from "./harness-library.ts";
import { Effect } from "effect";
import { EventLog, withWatermark } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import type { Event } from "tardie/core/event";
import { methodCallKeys } from "tardie/core/method";
import {
  channelAppendAllowed,
  channelBindings,
  channelDigest,
  channelEventKey,
  channelSameReceipt,
} from "./channel-bindings.ts";
import {
  createChannelRuntime,
  channelRuntimeView,
  channelOperationKey,
  type ChannelRuntimePorts,
} from "./channel-runtime.ts";
import {
  createChannelWiring,
  channelWiringEventKey,
  channelWiringAppendAllowed,
  type ChannelWiringBindings,
  type WiringJournal,
} from "./channel-wiring.ts";
import {
  createChannelBridge,
  channelBridgeEventKey,
  channelBridgeSendScope,
  channelBridgeAppendAllowed,
  type ChannelBridgeBindings,
  type ChannelSourceGrant,
} from "./channel-ingress.ts";
import { boundedText } from "./security.ts";
import {
  HarnessLibrary,
  harnessLibraryState,
  harnessDigest,
  type HarnessDigest,
  type HarnessJson,
  type HarnessLibraryBinding,
  type HarnessJournal,
} from "./harness-library.ts";

export type ChannelAdapterBindings = Omit<
  ChannelRuntimePorts,
  "handle" | "journal" | "replyAllowed"
>;
export interface ChannelHost {
  self(thread: string): string;
  read(thread: string): Promise<readonly Event[]>;
  seed(thread: string, events: readonly Event[]): Promise<void>;
  commitRoot(address: string, event: Event): Promise<void>;
  /** Actual guarded native metadata commit. History seed is not this capability. */
  appendControl?(thread: string, events: readonly Event[]): Promise<unknown>;
}

/** Host-owned capabilities only. Owner, custody journal and native channel
 * components always come from this account's assembly. */
export interface BrowserWatchNativeActions {
  actor?: { timeoutMs?: number; commitCurrent(intent: BrowserWatchDispatch): boolean };
  webhook?: { resolve: BrowserWatchWebhookBinding["resolve"]; commitCurrent?: BrowserWatchWebhookBinding["commitCurrent"] };
}
/** Used even when a capability is absent: queued native watch admission cannot
 * silently lose its application authority fence after host reconstruction. */
export const browserWatchActorAdmissionRequired = (events: readonly Event[]) => events.some(e => e.type === "MessageReceived" &&
  (!!(e.input as {browserWatch?:unknown}|undefined)?.browserWatch || String(e.id).startsWith("watch:")));
export const browserWatchDispatchAdmissionRequired = (events: readonly Event[]) => browserWatchActorAdmissionRequired(events) || browserWatchWebhookPermitRequired(events);
export type BrowserWatchHostPolicy = (context: {
  owner: string;
  thread: string;
  journal: WiringJournal;
  wiring: ReturnType<typeof createChannelWiring>;
  sources: ReturnType<typeof createChannelLogSources>;
}) => Omit<BrowserWatchBindings, "owner" | "journal" | "wiring" | "sources" | "execute" | "reconcile"> & Partial<Pick<BrowserWatchBindings, "execute" | "reconcile">> & {
  /** Explicit trusted host capabilities. Discovery alone cannot enable actions. */
  nativeActions?: BrowserWatchNativeActions;
};

/** One instance per owner per physical host. All channel writers (native effects and
 * HTTP admission) use this same serialized gate. Native seed commits each batch in
 * one SQLite transaction. No schema forks or independent queues. Other host ingress
 * must reject reserved channel events; privileged history import requires a resting host.
 * CF also installs channelAppendAllowed in its underlying transaction guard.
 */
export function createHostedChannels(
  owner: string,
  host: () => ChannelHost,
  adapters: ChannelAdapterBindings | undefined,
  policy: {
    requireThinkFeel?: boolean;
    beforeCommit?: () => Promise<void>;
    custody?: HarnessBlobStore;
    wiring?: ChannelWiringBindings;
    bridge?: ChannelBridgeBindings;
    logSources?: ChannelLogSourceBindings;
    browserProducers?: { grant(producer: string): BrowserProducerGrant | undefined; current(): boolean };
    browserWatches?: BrowserWatchHostPolicy;
  } = {},
) {
  const thread = `user-${owner}`;
  const blobs = policy.custody ?? policy.wiring?.blobs;
  let bridge: ReturnType<typeof createChannelBridge> | undefined;
  const publicRequests = new WeakMap<Request, ChannelSourceGrant>();
  const publicContexts = new WeakMap<object, ChannelSourceGrant>();
  const now = policy.bridge?.now ?? Date.now;
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>) => {
    const next = tail.then(fn);
    tail = next.catch(() => undefined);
    return next;
  };
  const commit = async (
    unsealed: readonly Event[],
    before: readonly Event[],
    validate?: () => Promise<void>,
  ) => {
    const events = await Promise.all(
      unsealed.map((e) => channelSealEvent(blobs, owner, e)),
    );
    await validate?.();
    for (const e of unsealed)
      if (e.type === "AikoChannelControlPlan") {
        const b = channelBindings(before, owner).get(String(e.channel));
        if (
          !b ||
          (await adapters?.controlPolicy?.(
            b,
            e.plan as import("./channel-controls.ts").ChannelControlPlan,
          )) !== e.policyDigest
        )
          throw Error("channel_control_revoked");
      }
    await wiring?.authorizeBatch(unsealed);
    // Poll admission can happen well after the fetch. Sealing/receiving checks
    // must not extend its original deadline or an automatically recorded grant.
    for (const e of unsealed) {
      if (e.type !== "AikoChannelPollSettled" || e.status !== "accepted")
        continue;
      const b = channelBindings(before, owner).get(String(e.channel));
      const request = before.find(
        (r) =>
          r.owner === owner &&
          r.channel === e.channel &&
          r.generation === e.generation &&
          r.type === "AikoChannelPollRequested" &&
          r.id === e.id,
      );
      const control = channelControlState(before, owner).find(
        (s) =>
          s.plan.channel === e.channel &&
          s.plan.generation === e.generation &&
          s.p.action === "poll" &&
          Array.from({ length: s.p.maxRuns }, (_, i) =>
            controlOperationId(s.plan, i),
          ).includes(String(e.id)),
      );
      if (
        !adapters ||
        !b ||
        !request ||
        !(await adapters?.artifactAllowed(b)) ||
        !(await adapters.authorize(owner, b.authorization, "change", {
          id: b.id,
          generation: b.generation,
          operation: "poll",
          partition: request.partition,
        })) ||
        (control &&
          (control.reason !== "pending" ||
            (await adapters.controlPolicy?.(b, control.p)) !==
              control.plan.policyDigest)) ||
        now() >=
          Math.min(
            Number(request.at) + b.retentionMs,
            control?.p.expiresAt ?? Infinity,
          )
      )
        throw Error("channel_poll_admission_revoked");
    }
    // Sealing is asynchronous: source capability expiry is checked again at custody commit.
    for (const e of unsealed) {
      if (
        e.type !== "AikoChannelReceived" ||
        !e.context ||
        typeof e.context !== "object"
      )
        continue;
      const grant = publicContexts.get(e.context);
      if (
        grant &&
        (grant.expiresAt <= now() || !bridge?.grantAllowed(before, grant))
      )
        throw new Error("channel_source_capability_expired");
    }
    const nativeWatchPlan = (e: Event) => !!policy.browserWatches && e.type === "CallPlanned" && (e.owner === undefined || e.owner === owner) &&
      (e.input as {input?:{browserWatch?:{owner?:unknown}}}|undefined)?.input?.browserWatch?.owner === owner;
    const keyOf = (e: Event) =>
      channelEventKey(e) ??
      channelWiringEventKey(e) ??
      channelBridgeEventKey(e) ??
      channelLogSourceEventKey(e) ?? browserEventKey(e) ?? browserWatchEventKey(e) ??
      (nativeWatchPlan(e) ? methodCallKeys.keyOf(e) : undefined);
    for (const event of events) {
      const previous = before.find((e) => keyOf(e) === keyOf(event));
      if (previous && nativeWatchPlan(event) && harnessDigest(previous) !== harnessDigest(event))
        throw Error("watch_actor_plan_conflict");
      if (
        previous &&
        channelEventKey(event) &&
        !channelSameReceipt(previous, event)
      )
        throw new Error(
          event.type === "AikoChannelReceived"
            ? "channel_occurrence_conflict"
            : "channel_operation_conflict",
        );
    }
    if (
      !events.every((e) => keyOf(e) && (e.owner === owner || nativeWatchPlan(e))) ||
      !channelAppendAllowed(
        events.filter((e) => !!channelEventKey(e)),
        () => before,
      ) ||
      !channelWiringAppendAllowed(events, () => before) ||
      !channelBridgeAppendAllowed(events, () => before) ||
      !channelLogSourceAppendAllowed(events, () => before) ||
      !browserEventAppendAllowed(events, () => before) ||
      !browserWatchAppendAllowed(events, () => before)
    )
      throw new Error("channel_commit_conflict");
    if (!events.length) return;
    if (browserWatchWebhookPermitRequired(events)) {
      if (events.some(e => e.type !== "AikoBrowserWatchWebhookPermitted") || !host().appendControl)
        throw Error("watch_webhook_guarded_commit_required");
      await host().appendControl!(thread, events);
      return;
    }
    if (!before.length) {
      if (
        events.length !== 1 ||
        !["AikoChannelBindingIntent", "AikoChannelWiringBound", ...(policy.browserWatches ? ["AikoBrowserWatchPrepared"] : [])].includes(
          events[0]!.type,
        )
      )
        throw new Error("channel_initial_binding_required");
      await host().commitRoot(host().self(thread), events[0]!);
    } else await host().seed(thread, events);
  };
  const journal: HarnessJournal = {
    read: () => host().read(thread),
    append: (events) =>
      serialized(async () => {
        await policy.beforeCommit?.();
        const before = await host().read(thread);
        for (const e of events) {
          const prepared =
            e.type === "AikoChannelOutputPrepared"
              ? e
              : e.type === "AikoChannelOutputStarted"
                ? before.find(
                    (p) =>
                      p.type === "AikoChannelOutputPrepared" &&
                      p.owner === owner &&
                      p.channel === e.channel &&
                      p.generation === e.generation &&
                      p.id === e.id,
                  )
                : undefined;
          if (prepared) {
            const hydrated = await channelOpenEvent(blobs, owner, prepared);
            const scope = await channelBridgeSendScope(
              before,
              owner,
              {
                ...(hydrated.input as object),
                destination: prepared.destination,
              },
              now(),
              blobs,
            );
            if (scope.managed && (!bridge || !scope.allowed))
              throw new Error("channel_bridge_send_capability");
          }
          if (
            e.type !== "AikoChannelReceived" ||
            !e.context ||
            typeof e.context !== "object"
          )
            continue;
          const grant = publicContexts.get(e.context);
          if (
            grant &&
            (grant.expiresAt <= now() || !bridge?.grantAllowed(before, grant))
          )
            throw new Error("channel_source_capability_expired");
        }
        const scopedEvents = events.map((e) => {
          const grant =
            e.type === "AikoChannelReceived" &&
            e.context &&
            typeof e.context === "object"
              ? publicContexts.get(e.context)
              : undefined;
          return grant
            ? {
                ...e,
                sourceCapability: grant.capabilityRef,
                sourceBridge: grant.bridge,
              }
            : e;
        });
        const admitted = bridge
          ? await bridge.admit(scopedEvents, before)
          : scopedEvents;
        for (const e of scopedEvents)
          if (
            e.type === "AikoChannelReceived" &&
            e.sourceRequiresBridge &&
            ![...before, ...admitted].some(
              (r) =>
                r.type === "AikoChannelBridgeSelected" &&
                r.owner === owner &&
                r.input === e.id &&
                (r.bridge as any)?.external?.channel === e.channel &&
                (r.bridge as any)?.external?.generation === e.generation,
            )
          )
            throw Error("channel_poll_receiving_unavailable");
        await commit(admitted, before);
      }),
  };
  const wiringJournal: WiringJournal = {
    blobs,
    read: journal.read,
    transact: (fn, validate) =>
      serialized(async () => {
        await policy.beforeCommit?.();
        const before = await journal.read(),
          next = fn(before);
        await commit(next.events, before, validate);
        return next.result;
      }),
  };
  const wiring = policy.wiring
    ? createChannelWiring(owner, wiringJournal, { ...policy.wiring, blobs })
    : undefined;
  if (policy.browserWatches && !wiring)
    throw new Error("browser_watch_wiring_required");
  let watchWebhook: ReturnType<typeof browserWatchWebhookActions> | undefined;
  let watchActor: ReturnType<typeof browserWatchActorActions> | undefined;
  const runtime = createChannelRuntime(owner, {
    ...(adapters ?? {
      artifactAllowed: async () => false,
      authorize: async () => false,
      authenticate: async () => undefined,
      execute: async () => {
        throw new Error("channel_provider_unconfigured");
      },
      validateReceipt: async () => false,
    }),
    execute: async (binding, operation, input, key, signal) => {
      if (!adapters) throw Error("channel_provider_unconfigured");
      if (!watchWebhook && (operation === "send" || operation === "reconcile")) {
        const value = input as {operationId?:unknown;task?:unknown}|undefined;
        const retainedWatch = (await journal.read()).some(e => e.type === "AikoChannelOutputPrepared" && e.owner === owner &&
          e.channel === binding.id && e.generation === binding.generation && String(e.id).startsWith("watch:") &&
          (operation === "send" ? e.id === value?.operationId : channelOperationKey(binding,"send",String(e.id)) === value?.operationId));
        if (retainedWatch || String(value?.operationId).startsWith("watch:") || String(value?.task).startsWith("watch:"))
          throw Error("watch_webhook_capability_unavailable");
      }
      const managed = await watchWebhook?.authorizeDispatch(binding, operation, input, key, signal);
      if (managed === false || managed === true && !adapters.dispatchGuardSupported?.(binding))
        throw Error("watch_webhook_dispatch_authority_unavailable");
      return adapters.execute(binding, operation, input, key, signal,
        managed === undefined ? undefined : { beforeDispatch: async () => {
          if (await watchWebhook!.authorizeDispatch(binding, operation, input, key, signal) !== true)
            throw Error("watch_webhook_authority_unavailable");
        }, permit: (identity, permitSignal, policyCurrent) => watchWebhook!.permit(binding, operation, input, key, identity,
          permitSignal ? AbortSignal.any([signal, permitSignal]) : signal, policyCurrent) });
    },
    activateIngress: async (b) => {
      if (
        !bridge ||
        !b.providerBridge ||
        b.providerBridge.external.channel !== b.id ||
        b.providerBridge.external.generation !== b.generation
      )
        throw Error("channel_activation_unavailable");
      const receipt = await run(bridge.api.bind(b.providerBridge));
      return { bridge: receipt.id };
    },
    openEvent: async (e) => {
      const opened = await channelOpenEvent(blobs, owner, e);
      if (e.type === "AikoChannelOutputPrepared")
        await channelBridgeSendScope(
          await journal.read(),
          owner,
          { ...(opened.input as object), destination: opened.destination },
          now(),
          blobs,
        );
      return opened;
    },
    journal,
    authorize: async (account, authority, operation, input) => {
      if (!(await adapters?.authorize(account, authority, operation, input)))
        return false;
      if (operation !== "send") return true;
      const value = input as { operationId?: string; destination?: string } | undefined;
      if (watchWebhook && value?.operationId && value.destination) {
        const events = await journal.read();
        const b = [...channelBindings(events, owner).values()].find(b => b.destination === value.destination);
        // Initial prepare has no outbox row yet; the watch adapter checks that
        // admission. Existing queued sends recheck their retained scope here.
        if (b && events.some(e => e.type === "AikoChannelOutputPrepared" && e.owner === owner && e.channel === b.id && e.id === value.operationId) &&
          await watchWebhook.authorizeDispatch(b, "send", input, channelOperationKey(b, "send", value.operationId), AbortSignal.timeout(15_000)) === false)
          return false;
      }
      const scope = await channelBridgeSendScope(
        await journal.read(),
        owner,
        input,
        now(),
        blobs,
      );
      return !scope.managed || (!!bridge && scope.allowed);
    },
    authenticate: async (binding, request, body) => {
      const grant = publicRequests.get(request);
      if (!grant) return adapters?.authenticate(binding, request, body);
      if (
        grant.owner !== owner ||
        grant.scope !== "receive" ||
        grant.channel !== binding.id ||
        grant.generation !== binding.generation ||
        grant.expiresAt <= now() ||
        !bridge?.grantAllowed(await journal.read(), grant)
      )
        return undefined;
      const verified = await grant.verify(binding, request, body);
      if (!verified || grant.expiresAt <= now()) return undefined;
      const context = structuredClone(verified);
      publicContexts.set(context, grant);
      return context;
    },
    replyAllowed: (reply) =>
      !policy.requireThinkFeel ||
      ["thinkfeel", "service"].includes(String(reply.source)),
    handle: (binding, observation, context, key) =>
      serialized(async () => {
        const events = await host().read(thread);
        const current = channelBindings(events, owner).get(binding.id);
        if (
          current?.status !== "active" ||
          current.generation !== binding.generation ||
          (current.lifecycle ?? 0) !== (binding.lifecycle ?? 0)
        )
          throw new Error("channel_generation");
        // Retained typed routing never falls back to inference if its adapter is disabled.
        const selectedId = channelDigest([
          owner,
          binding.id,
          binding.generation,
          channelDigest([context.partition, context.occurrence]),
        ]);
        const selected = events.find(
          (e) =>
            e.type === "AikoChannelBridgeSelected" &&
            e.owner === owner &&
            e.id === selectedId,
        );
        if (selected) {
          if (
            !events.some(
              (e) =>
                e.type === "AikoChannelBridgeInputLinked" &&
                e.owner === owner &&
                e.id === selectedId,
            )
          )
            throw new Error("channel_bridge_unavailable");
          return { receipt: `bridge:${selected.id}` };
        }
        const message: Event = {
          type: "MessageReceived",
          id: key,
          at: Date.now(),
          source: "channel",
          text: observation.text,
          // Only this fixed host constructor can produce this trusted routing metadata.
          channelBinding: binding.id,
          channelGeneration: binding.generation,
          channelInput: channelDigest([context.partition, context.occurrence]),
        };
        const prior = events.find(
          (e) => e.type === "MessageReceived" && e.id === key,
        );
        if (
          prior &&
          [
            "source",
            "text",
            "channelBinding",
            "channelGeneration",
            "channelInput",
          ].some((field) => prior[field] !== message[field])
        )
          throw new Error("channel_handoff_conflict");
        if (!prior) await host().commitRoot(host().self(thread), message);
        return { receipt: key };
      }),
  });
  const log = withWatermark({
    read: Effect.promise(journal.read),
    append: (events) => Effect.promise(() => journal.append([...events])),
  });
  const run = <T>(work: Effect.Effect<T, never, EventLog | Self>) =>
    Effect.runPromise(
      work.pipe(
        Effect.provideService(EventLog, log),
        Effect.provideService(Self, parseThreadAddress(host().self(thread))),
      ),
    );
  bridge = policy.bridge
    ? createChannelBridge(owner, wiringJournal, policy.bridge, runtime.prepare)
    : undefined;
  const receiveScoped = async (
    rawGrant: ChannelSourceGrant,
    request: Request,
  ) => {
    const grant = { ...rawGrant };
    if (
      !adapters ||
      !bridge ||
      grant.owner !== owner ||
      grant.scope !== "receive" ||
      !Number.isFinite(grant.expiresAt) ||
      typeof grant.verify !== "function" ||
      grant.expiresAt <= now() ||
      !bridge.grantAllowed(await journal.read(), grant)
    )
      throw new Error("channel_bridge_unavailable");
    publicRequests.set(request, grant);
    try {
      return await run(
        runtime.ingest(grant.channel, grant.generation, request),
      );
    } finally {
      publicRequests.delete(request);
    }
  };
  let watches: ReturnType<typeof createBrowserWatches> | undefined;
  let watchBinding: ReturnType<BrowserWatchHostPolicy> | undefined;
  const logSources = wiring && (policy.logSources || policy.browserWatches)
    ? createChannelLogSources(owner, wiringJournal, wiring, {
        current: () => !!policy.logSources?.current() || !!watchBinding?.current(),
        grants: () => [
          ...(policy.logSources?.grants() ?? []).map(grant => ({
            ...grant, active: grant.active && !!policy.logSources?.current(),
          })),
          ...(watches?.sourceGrants() ?? []),
        ].filter((grant, _index, all) => all.filter(other => other.id === grant.id).length === 1),
      }, (thread) => host().read(thread))
    : undefined;
  if (policy.browserWatches) {
    watchBinding = policy.browserWatches({ owner, thread, journal: wiringJournal, wiring: wiring!, sources: logSources! });
    if (watchBinding.library.binding.owner !== owner || watchBinding.library.binding.thread !== thread)
      throw new Error("browser_watch_library_owner_mismatch");
    const selected = watchBinding;
    const current = (intent: import("./browser-watches.ts").BrowserWatchDispatch, signal: AbortSignal, operation: "execute" | "reconcile") =>
      watches?.authorizeAction(intent, operation, signal) ?? Promise.resolve(false);
    if (selected.nativeActions?.actor) watchActor = browserWatchActorActions({ owner, thread, journal: wiringJournal,
      self: () => parseThreadAddress(host().self(thread)), current,
      timeoutMs: selected.nativeActions.actor.timeoutMs, commitCurrent: intent =>
        !!watches?.dispatchCurrent(intent) && selected.nativeActions!.actor!.commitCurrent(intent) });
    if (selected.nativeActions?.webhook) {
      if (!adapters) throw Error("browser_watch_webhook_adapter_required");
      watchWebhook = browserWatchWebhookActions({ owner, journal: wiringJournal, runtime, run, current,
        resolve: selected.nativeActions.webhook.resolve,
        commitCurrent: selected.nativeActions.webhook.commitCurrent && ((intent, operation) =>
          !!selected.current() && (operation === "reconcile" || !!watches?.dispatchCurrent(intent)) &&
          selected.nativeActions!.webhook!.commitCurrent!(intent, operation)) });
    }
    const harnessActions = browserWatchHarnessActions({ library: selected.library, current });
    const adapter = (kind: import("./browser-watches.ts").BrowserWatchAction["kind"]) =>
      kind === "harness" ? harnessActions : kind === "actor" ? watchActor : watchWebhook;
    const actions: Pick<BrowserWatchBindings,"execute"|"reconcile"> = selected.execute
      ? {execute:selected.execute,reconcile:selected.reconcile} : {
        execute: (intent,signal) => adapter(intent.action.kind)?.execute(intent,signal) ?? Promise.resolve({status:"failed",result:{reason:"watch_action_unsupported"}}),
        reconcile: (intent,signal) => adapter(intent.action.kind)?.reconcile?.(intent,signal) ?? Promise.resolve({status:"unknown"}),
      };
    watches = createBrowserWatches({ ...selected, ...actions, owner, journal: wiringJournal, wiring: wiring!, sources: logSources!,
      authorize: (config, operation, signal) => !selected.execute && !adapter(config.action.kind)
        ? Promise.resolve(false) : selected.authorize(config, operation, signal),
      discovery: selected.discovery && (selected.execute ? selected.discovery : async signal => {
        const choices = await selected.discovery!(signal);
        return {...choices,actions:choices.actions.filter(choice=>!!adapter(choice.action.kind))};
      }),
    });
  }
  const refresh = async () => { await watches?.refresh(); };
  const admitBrowser = policy.browserProducers || watches
    ? createBrowserEventAdmission({ owner, journal: wiringJournal,
        current: () => !!policy.browserProducers?.current() || !!watchBinding?.current(),
        grant: producer => {
          const configured = policy.browserProducers?.grant(producer);
          const watched = watches?.producerGrants().filter(grant => grant.producer === producer) ?? [];
          // An explicit host producer cannot silently replace a retained watch.
          if ((configured ? 1 : 0) + watched.length !== 1) return undefined;
          if (configured) return { ...configured, active: configured.active && !!policy.browserProducers?.current() };
          return watched[0];
        },
      })
    : undefined;
  return {
    owner,
    thread,
    runtime,
    wiring,
    wiringJournal,
    browserAdmission: admitBrowser ? async (...args: Parameters<typeof admitBrowser>) => {
      await refresh();
      return admitBrowser(...args);
    } : undefined,
    logSources,
    watches,
    watchActor,
    /** Called synchronously inside the owning host's actual append transaction. */
    actorAdmissionAllowed: (events: readonly Event[], read: () => readonly Event[]) => !browserWatchActorAdmissionRequired(events) ||
      !!watchBinding?.current() && !!watchActor?.admissionAllowed(events, read),
    dispatchAdmissionAllowed: (events: readonly Event[], read: () => readonly Event[]) =>
      (!browserWatchActorAdmissionRequired(events) || !!watchBinding?.current() && !!watchActor?.admissionAllowed(events, read)) &&
      (!browserWatchWebhookPermitRequired(events) || !!watchBinding?.current() && !!watchWebhook?.admissionAllowed(events, read)),
    /** Restore private watch grant projections before native recovery. */
    refresh,
    bridge,
    receiveScoped,
    journal,
    run,
    view: async () => channelRuntimeView(await journal.read(), owner),
  };
}
export type HostedChannels = ReturnType<typeof createHostedChannels>;

/** Optional real registry bridge. Security checks are independent trusted capabilities;
 * a satisfied harness witness alone never authenticates an HTTP caller or grants send.
 * The library binding executes through the root's sandbox bridge, never eval in this host.
 */
export function channelHarnessAdapters(
  binding: HarnessLibraryBinding,
  journal: HarnessJournal,
  security: Omit<ChannelAdapterBindings, "execute" | "artifactAllowed">,
): ChannelAdapterBindings {
  const library = new HarnessLibrary(binding, journal);
  return {
    ...security,
    artifactAllowed: async (channel) => {
      if (channel.owner !== binding.owner || channel.route !== binding.thread)
        return false;
      try {
        const { artifact, contract } = await library.resolve(
          channel.artifact.digest as HarnessDigest,
        );
        const declared = contract.applicability.channel as
          { directions?: unknown; operations?: unknown } | undefined;
        if (
          !Array.isArray(declared?.directions) ||
          !Array.isArray(declared?.operations) ||
          channel.artifact.directions.some(
            (d) => !(declared.directions as unknown[]).includes(d),
          ) ||
          channel.artifact.operations.some(
            (op) => !(declared.operations as unknown[]).includes(op),
          )
        )
          return false;
        const contextDigest = harnessDigest(
          await binding.context(AbortSignal.timeout(5000)),
        );
        const state = harnessLibraryState(await journal.read(), binding.owner);
        return (
          artifact.contractDigest === channel.artifact.contractDigest &&
          [...state.evaluations.values()].some(
            (e) =>
              e.harnessDigest === channel.artifact.digest &&
              e.eligible === true &&
              e.contractDigest === channel.artifact.contractDigest &&
              e.contextDigest === contextDigest,
          )
        );
      } catch {
        return false;
      }
    },
    execute: async (channel, operation, input, key, signal) => {
      const witness = await library.run(
        channel.artifact.digest as HarnessDigest,
        {
          operation,
          input: input as HarnessJson,
          binding: {
            account: channel.account,
            source: channel.source,
            destination: channel.destination ?? null,
            credentialRefs: channel.credentialRefs,
          },
        },
        key,
        signal,
      );
      if (witness.status !== "satisfied" || !witness.outputRef)
        throw new Error("channel_harness_unconfirmed");
      return binding.blobs.get(binding.owner, witness.outputRef);
    },
  };
}

/** Registry-backed hook execution. Contract applicability.hook declares accepts/emits,
 * inputSchema (the typed value), and effects. The contract itself validates the complete
 * {value,schema,correlation} invocation and output. Only current-context evaluated pins
 * become active. Receiving grants remain a separately injected owner capability check.
 */
export function channelHarnessHandlers(
  binding: HarnessLibraryBinding,
  journal: HarnessJournal,
  authorize: ChannelWiringBindings["authorize"],
  management?: Pick<
    ReturnType<
      typeof import("./channel-registry.ts").channelRegistryContinuations
    >,
    "accepts" | "execute" | "reconcile"
  >,
): ChannelWiringBindings {
  const library = new HarnessLibrary(binding, journal);
  const isManaged = async (pin: import("./channel-wiring.ts").HandlerPin) => {
    const { contract } = await library.resolve(pin.harness as HarnessDigest);
    return (
      ((contract.applicability.hook as any)?.effects as unknown[])?.includes(
        "channel.manage",
      ) === true
    );
  };
  const result = async (
    witness: import("./harness-library.ts").HarnessWitness | undefined,
    pin: import("./channel-wiring.ts").HandlerPin,
  ): Promise<import("./channel-wiring.ts").HandlerResult> => {
    if (
      !witness ||
      witness.harnessDigest !== pin.harness ||
      witness.contractDigest !== pin.contract
    )
      return { status: "pending", evidence: "no_matching_checked_outcome" };
    if (witness.status === "satisfied" && witness.outputRef)
      return {
        status: "satisfied",
        output: await binding.blobs.get(binding.owner, witness.outputRef),
        evidence: `harness:${witness.operationId}`,
      };
    return {
      status: ["blocked", "violated"].includes(witness.status)
        ? "rejected"
        : "pending",
      evidence: `harness:${witness.operationId}:${witness.status}`,
    };
  };
  return {
    blobs: binding.blobs,
    authorize: (owner, authority, operation, value) =>
      owner === binding.owner && binding.thread === `user-${owner}`
        ? authorize(owner, authority, operation, value)
        : Promise.resolve(false),
    resolve: async (pin, signal) => {
      const { artifact, contract } = await library.resolve(
        pin.harness as HarnessDigest,
      );
      const declaration = contract.applicability.hook as
        Record<string, HarnessJson> | undefined;
      if (
        artifact.contractDigest !== pin.contract ||
        !declaration ||
        typeof declaration.accepts !== "string" ||
        typeof declaration.emits !== "string" ||
        !declaration.inputSchema ||
        typeof declaration.inputSchema !== "object" ||
        Array.isArray(declaration.inputSchema) ||
        !Array.isArray(declaration.effects) ||
        declaration.effects.some((e) => typeof e !== "string")
      )
        throw new Error("channel_hook_contract_invalid");
      const context = harnessDigest(await binding.context(signal));
      const state = harnessLibraryState(await journal.read(), binding.owner);
      return {
        accepts: declaration.accepts,
        emits: declaration.emits,
        inputSchema: declaration.inputSchema as Record<string, unknown>,
        outputSchema: contract.outputSchema,
        effects: declaration.effects as string[],
        management: management ? await management.accepts(pin, signal) : false,
        eligible:
          (contract.effect === "read" ||
            (!!management && (await management.accepts(pin, signal)))) &&
          [...state.evaluations.values()].some(
            (e) =>
              e.eligible === true &&
              e.harnessDigest === pin.harness &&
              e.contractDigest === pin.contract &&
              e.contextDigest === context,
          ),
      };
    },
    execute: async (pin, input, key, signal) =>
      (await isManaged(pin))
        ? management && (await management.accepts(pin, signal))
          ? management.execute(pin, input, key, signal)
          : { status: "rejected", evidence: "channel_management_denied" }
        : result(
            await library.run(
              pin.harness as HarnessDigest,
              input as HarnessJson,
              key,
              signal,
            ),
            pin,
          ),
    // Read retained verifier output only; absence is unknown and never authorizes a retry.
    reconcile: async (pin, key, signal) =>
      (await isManaged(pin))
        ? management && (await management.accepts(pin, signal))
          ? management.reconcile(pin, key, signal)
          : { status: "rejected", evidence: "channel_management_denied" }
        : result(
            harnessLibraryState(
              await journal.read(),
              binding.owner,
            ).witnesses.get(key),
            pin,
          ),
  };
}

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
const operations = new Set([
  "bind",
  "lifecycle",
  "poll",
  "subscription",
  "reconcile",
]);
/** Activation API (both /v1/channels and /api/channels):
 * GET / lists durable bindings and receipts; available=false when adapters are absent.
 * POST /bind accepts {name,generation,artifact:{digest,contractDigest,directions,operations},
 * account,source,destination?,credentialRefs,authorization,backlog,maxBytes,maxHops,
 * retentionMs,queuedWork:"cancel"}. Owner/route/lifecycle are assigned by the host.
 * POST /ID/GENERATION/receive accepts bounded provider bytes, independently authenticated.
 * POST /lifecycle accepts {id,generation,status,authorization,operationId}.
 * POST /poll accepts {id,generation,partition,operationId}.
 * POST /subscription accepts {id,generation,operation,authorization,operationId}.
 * POST /reconcile accepts {id,generation,outputId,operationId}.
 * Status is paused|active|retiring; subscription operation is renew|reconcile.
 * Bind/lifecycle are durable intent receipts (202), not proof of readiness/delivery.
 * Inject createService's channels(owner) or the Worker's in-process
 * AIKO_CHANNEL_ADAPTERS.forOwner(owner); these are trusted code, not request JSON.
 * channelHarnessAdapters connects an existing independently authorized registry binding.
 *
 * Existing account principal is required even for receive. Providers need a scoped
 * account credential plus the adapter's independent source-signature verification.
 * No anonymous webhook routing, account allocation, provider grants or internal event API.
 */
export async function channelApi(
  request: Request,
  owner: string,
  channels: HostedChannels | undefined,
  principal: { owner: string; scopes: readonly string[] },
  wake: () => void,
  read?: () => Promise<readonly Event[]>,
): Promise<Response> {
  if (
    principal.owner !== owner ||
    !principal.scopes.includes(request.method === "GET" ? "read" : "write")
  )
    return json({ error: "forbidden" }, 403);
  const url = new URL(request.url),
    path = url.pathname.replace(/^\/(?:api|v1)\/channels\/?/, "");
  if (url.search) return json({ error: "invalid_query" }, 400);
  if (request.method === "GET" && path === "")
    return json({
      available: !!channels,
      ...(channels
        ? await channels.view()
        : read
          ? channelRuntimeView(await read(), owner)
          : { bindings: [], inbox: [], outbox: [], cursors: [] }),
      unsupported: [
        "anonymous_provider_routes",
        "provider_challenges",
        "automatic_retries",
        "physical_retention",
      ],
    });
  if (!channels) return json({ error: "channel_adapters_not_configured" }, 503);
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405);
  try {
    const receive = /^([a-f0-9]{64})\/([1-9]\d*)\/receive$/.exec(path);
    if (receive) {
      const receipt = await channels.run(
        channels.runtime.ingest(receive[1]!, Number(receive[2]), request),
      );
      wake();
      return json(receipt, 202);
    }
    if (!operations.has(path)) return json({ error: "not_found" }, 404);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return json({ error: "json_required" }, 415);
    const body = JSON.parse(
      await boundedText(new Response(request.body), 32_768),
    );
    if (!body || typeof body !== "object" || Array.isArray(body))
      return json({ error: "invalid_body" }, 400);
    if (path === "bind") {
      const allowed = [
        "name",
        "generation",
        "artifact",
        "account",
        "source",
        "destination",
        "credentialRefs",
        "authorization",
        "backlog",
        "maxBytes",
        "maxHops",
        "retentionMs",
        "queuedWork",
      ];
      if (Object.keys(body).some((k) => !allowed.includes(k)))
        return json({ error: "invalid_body" }, 400);
      const id = await channels.run(
        channels.runtime.configure({ ...body, route: channels.thread }),
      );
      wake();
      return json({ status: "recorded", id, generation: body.generation }, 202);
    }
    const keys: Record<string, string[]> = {
      lifecycle: ["id", "generation", "status", "authorization", "operationId"],
      poll: ["id", "generation", "partition", "operationId"],
      subscription: [
        "id",
        "generation",
        "operation",
        "operationId",
        "authorization",
        ...(body.originalRenewalId === undefined ? [] : ["originalRenewalId"]),
      ],
      reconcile: ["id", "generation", "outputId", "operationId"],
    };
    if (
      Object.keys(body).sort().join() !== keys[path]!.sort().join() ||
      typeof body.id !== "string" ||
      !Number.isSafeInteger(body.generation) ||
      body.generation < 1 ||
      typeof body.operationId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,160}$/.test(body.operationId)
    )
      return json({ error: "invalid_body" }, 400);
    if (
      ![
        body.id,
        body.operationId,
        ...["authorization", "partition", "outputId"]
          .filter((k) => k in body)
          .map((k) => body[k]),
      ].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 1024,
      ) ||
      !/^[a-f0-9]{64}$/.test(body.id)
    )
      return json({ error: "invalid_body" }, 400);
    if (path === "lifecycle") {
      if (!["paused", "active", "retiring"].includes(body.status))
        return json({ error: "invalid_body" }, 400);
      await channels.run(
        channels.runtime.change(
          body.id,
          body.generation,
          body.status,
          body.authorization,
          body.operationId,
        ),
      );
    } else if (path === "poll")
      await channels.run(
        channels.runtime.requestPoll(
          body.id,
          body.generation,
          body.partition,
          body.operationId,
        ),
      );
    else if (path === "subscription") {
      if (!["renew", "reconcile"].includes(body.operation))
        return json({ error: "invalid_body" }, 400);
      await channels.run(
        channels.runtime.requestSubscription(
          body.id,
          body.generation,
          body.operation,
          body.operationId,
          body.authorization,
          body.originalRenewalId,
        ),
      );
    } else
      await channels.run(
        channels.runtime.requestReconcile(
          body.id,
          body.generation,
          body.outputId,
          body.operationId,
        ),
      );
    wake();
    return json({ status: "recorded" }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /channel_[a-z_]+/.exec(message)?.[0];
    const status = reason?.includes("authentication")
      ? 401
      : reason?.includes("authorized") || reason?.includes("owner_scope")
        ? 403
        : reason?.includes("payload_limit")
          ? 413
          : reason?.includes("commit_conflict")
            ? 503
            : reason?.includes("conflict") ||
                reason?.includes("generation") ||
                reason?.includes("inactive")
              ? 409
              : reason ||
                  error instanceof SyntaxError ||
                  error instanceof TypeError
                ? 400
                : 503;
    return json({ error: reason ?? "invalid_channel_request" }, status);
  }
}
