import type { Effect } from "effect";
import { browserWatchRenewedConfig } from "./browser-watches.ts";
import type { EventLog } from "tardie/core/log";
import type { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import {
  channelBindings,
  channelDigest,
  channelEventDigest,
  channelEventKey,
  type ChannelBinding,
} from "./channel-bindings.ts";
import { channelHydrate, channelOpenEvent } from "./channel-custody.ts";
import {
  browserEventKey,
  type BrowserObservedEvent,
} from "./browser-events.ts";
import type {
  BrowserWatchActionResult,
  BrowserWatchConfig,
  BrowserWatchDispatch,
} from "./browser-watches.ts";
import {
  channelOperationKey,
  type ChannelAdapterOperation,
  type ChannelDelivery,
  type ChannelDispatchPermitIdentity,
  type ChannelDispatchPermitResult,
  type createChannelRuntime,
} from "./channel-runtime.ts";
import type { WiringJournal } from "./channel-wiring.ts";

export interface BrowserWatchWebhookDestination {
  channel: string;
  generation: number;
  authorization: string;
  conversation: string;
  /** Absolute trusted authority deadline; receipt checks may have a fresh grant. */
  deadlineAt: number;
}
export interface BrowserWatchWebhookBinding {
  owner: string;
  journal: WiringJournal;
  runtime: Pick<
    ReturnType<typeof createChannelRuntime>,
    "prepare" | "requestReconcile"
  >;
  run<T>(work: Effect.Effect<T, never, EventLog | Self>): Promise<T>;
  current(
    intent: BrowserWatchDispatch,
    signal: AbortSignal,
    operation: "execute" | "reconcile",
  ): Promise<boolean>;
  resolve(
    destination: string,
    intent: BrowserWatchDispatch,
    signal: AbortSignal,
  ): Promise<BrowserWatchWebhookDestination | undefined>;
  now?: () => number;
  /** Current account/connection authority at the actual native commit. This is
   * required for remote permits; an asynchronous cached check is insufficient. */
  commitCurrent?(intent: BrowserWatchDispatch, operation: "execute" | "reconcile"): boolean;
}
const limitMs = 300_000;
const failed = (reason: string): BrowserWatchActionResult => ({
  status: "failed",
  result: { reason },
});
const unknown = (reason: string): BrowserWatchActionResult => ({
  status: "unknown",
  result: { reason },
});
const exact = (a: unknown, b: unknown) => channelDigest(a) === channelDigest(b);
export const browserWatchWebhookPermitRequired = (batch: readonly Event[]) => batch.some(e => e.type === "AikoBrowserWatchWebhookPermitted");
const permitId = (owner: string, operationId: string) => channelDigest([owner, operationId, "webhook-request"]);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
/** Structural half of the native commit fence. No private request bytes or
 * credential values are accepted into this fact. */
export function browserWatchWebhookPermitAppendAllowed(batch: readonly Event[], read: () => readonly Event[]) {
  const rows = [...read()];
  for (const e of batch) {
    if (e.type !== "AikoBrowserWatchWebhookPermitted") { rows.push(e); continue; }
    if (Object.keys(e).some(key => !["type", "owner", "id", "at", "operationId", "jobDigest", "requestDigest", "nonce", "expiresAt", "policyDigest",
      "watchOperationId", "watchId", "generation", "source", "channel", "channelGeneration", "bindingDigest", "destinationDigest", "operation", "nativeRequestId"].includes(key)) ||
      typeof e.owner !== "string" || !e.owner || typeof e.operationId !== "string" || !/^[a-f0-9]{64}$/.test(e.operationId) ||
      e.id !== permitId(e.owner, e.operationId) || !digestPattern.test(String(e.jobDigest)) || !digestPattern.test(String(e.requestDigest)) ||
      !/^[a-f0-9]{64}$/.test(String(e.policyDigest)) || !/^[a-f0-9-]{36}$/.test(String(e.nonce)) ||
      !Number.isSafeInteger(e.at) || !Number.isSafeInteger(e.expiresAt) || Number(e.expiresAt) <= Number(e.at) || Number(e.expiresAt) > Number(e.at) + 30_000 ||
      !["send", "reconcile"].includes(String(e.operation))) return false;
    const own = rows.filter(p => p.owner === e.owner), prior = own.find(p => p.type === e.type && p.id === e.id);
    if (prior) { if (!exact(prior, e)) return false; continue; }
    const claim = own.find(p => p.type === "AikoBrowserWatchStarted" && p.id === e.watchOperationId);
    const prepared = own.find(p => p.type === "AikoChannelOutputPrepared" && p.id === e.watchOperationId);
    const channel = channelBindings(own, e.owner).get(String(e.channel));
    if (!claim || !prepared || !channel || e.watchId !== claim.watchId || e.generation !== claim.generation || e.source !== claim.source ||
      channel.generation !== e.channelGeneration || prepared.channel !== channel.id || prepared.generation !== channel.generation ||
      e.bindingDigest !== channelDigest(channel) || e.destinationDigest !== channelDigest(channel.destination) ||
      !exact(prepared.binding, channel)) return false;
    if (e.operation === "send") {
      const control = own.findLast(p => p.type === "AikoBrowserWatchControlled" && p.watchId === e.watchId);
      const event = own.find(p => p.id === claim.eventId && browserEventKey(p));
      if (channel.status !== "active" || control && control.status !== "active" || !event ||
        own.some(p => p.type === "AikoBrowserWatchControlled" && p.watchId === e.watchId && p.status !== "active" && Number(p.cut) >= Number(event.sequence)) ||
        e.nativeRequestId !== prepared.id || e.operationId !== channelOperationKey(channel, "send", String(prepared.id)) ||
        !own.some(p => p.type === "AikoChannelOutputStarted" && p.id === prepared.id && p.channel === channel.id && p.generation === channel.generation) ||
        own.some(p => p.type === "AikoChannelOutputSettled" && p.id === prepared.id && p.channel === channel.id && p.generation === channel.generation)) return false;
    } else {
      const request = own.find(p => p.type === "AikoChannelReconcileRequested" && p.id === e.nativeRequestId && p.outputId === prepared.id && p.channel === channel.id && p.generation === channel.generation);
      if (!request || e.operationId !== channelOperationKey(channel, "reconcile", String(request.id)) ||
        own.some(p => p.type === "AikoChannelReconcileSettled" && p.id === request.id && p.channel === channel.id && p.generation === channel.generation)) return false;
    }
    rows.push(e);
  }
  return true;
}

/** Admit one structural webhook into the existing native outbox. The host MUST
 * compose authorizeDispatch into the transport's final request boundary. Admission
 * alone is pending; only an independently validated native receipt is terminal. */
export function browserWatchWebhookActions(
  binding: BrowserWatchWebhookBinding,
) {
  const { owner, journal } = binding,
    now = binding.now ?? Date.now;
  const owned = (events: readonly Event[]) =>
    events.filter((e) => e.owner === owner);
  const pending = (id: string, deadlineAt: number): BrowserWatchActionResult =>
    deadlineAt > now()
      ? { status: "pending", receipt: { kind: "channel", id }, deadlineAt }
      : unknown("watch_webhook_deadline_elapsed");
  const nativeRows = (events: readonly Event[]) =>
    owned(events).filter((e) => channelEventKey(e));
  const output = (events: readonly Event[], id: string) =>
    nativeRows(events).find(
      (e) => e.type === "AikoChannelOutputPrepared" && e.id === id,
    );
  async function reconstruct(
    operationId: string,
    events: readonly Event[],
  ): Promise<{ intent: BrowserWatchDispatch; config: BrowserWatchConfig }> {
    const rows = owned(events),
      claim = rows.find(
        (e) => e.type === "AikoBrowserWatchStarted" && e.id === operationId,
      );
    const version =
      claim &&
      rows.find(
        (e) =>
          e.type === "AikoBrowserWatchPrepared" &&
          e.watchId === claim.watchId &&
          e.generation === claim.generation,
      );
    const event =
      claim &&
      (rows.find((e) => e.id === claim.eventId && browserEventKey(e)) as
        BrowserObservedEvent | undefined);
    if (!claim || !version || !event)
      throw Error("watch_native_dispatch_required");
    const saved = (await channelHydrate(
      journal.blobs,
      owner,
      version.configRef,
    )) as { config: BrowserWatchConfig };
    const config = browserWatchRenewedConfig(rows, owner, saved.config);
    if (
      config.id !== claim.watchId ||
      config.action.kind !== "webhook" ||
      operationId !==
        `watch:${config.id}:${claim.generation}:${channelDigest([owner, event.id, config.action])}`
    )
      throw Error("watch_webhook_identity_mismatch");
    return {
      config,
      intent: {
        operationId,
        watchId: config.id,
        generation: Number(claim.generation),
        event,
        action: config.action,
      },
    };
  }
  async function authorize(
    raw: BrowserWatchDispatch,
    operation: "execute" | "reconcile",
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (raw.event.owner !== owner || raw.action.kind !== "webhook")
      throw Error("watch_webhook_owner_mismatch");
    const events = await journal.read(),
      { intent, config } = await reconstruct(raw.operationId, events);
    if (
      raw.watchId !== intent.watchId ||
      raw.generation !== intent.generation ||
      !exact(raw.action, intent.action) ||
      channelEventDigest(raw.event) !== channelEventDigest(intent.event)
    )
      throw Error("watch_webhook_intent_mismatch");
    if (raw.reconciliationRequestId)
      intent.reconciliationRequestId = raw.reconciliationRequestId;
    const destination = await binding.resolve(
      (intent.action as { destination: string }).destination,
      structuredClone(intent),
      signal,
    );
    const channel =
      destination && channelBindings(events, owner).get(destination.channel);
    if (
      !destination ||
      !channel ||
      channel.owner !== owner ||
      channel.generation !== destination.generation ||
      !channel.destination ||
      !channel.artifact.directions.includes("outbox") ||
      !channel.artifact.operations.includes("send") ||
      !destination.authorization ||
      !destination.conversation ||
      !Number.isSafeInteger(destination.deadlineAt) ||
      destination.deadlineAt <= now() ||
      (operation === "execute" &&
        (channel.status !== "active" || config.expiresAt <= now()))
    )
      throw Error("watch_webhook_destination_unavailable");
    if (!(await binding.current(structuredClone(intent), signal, operation)))
      throw Error("watch_webhook_authority_unavailable");
    signal.throwIfAborted();
    return { intent, config, destination, channel, events };
  }
  function inputFor(
    intent: BrowserWatchDispatch,
    destination: BrowserWatchWebhookDestination,
    deadlineAt: number,
  ) {
    const payload = JSON.stringify({
      schema: "aiko.browser-watch.webhook.v1",
      operationId: intent.operationId,
      watchId: intent.watchId,
      generation: intent.generation,
      expiresAt: deadlineAt,
      event: {
        id: intent.event.id,
        kind: intent.event.kind,
        observedAt: intent.event.observedAt,
        fields: intent.event.fields,
      },
    });
    if (Buffer.byteLength(payload) > 32_768)
      throw Error("watch_webhook_payload_limit");
    return {
      operationId: intent.operationId,
      task: intent.operationId,
      authorization: destination.authorization,
      conversation: destination.conversation,
      ancestry: [intent.operationId],
      payload,
    };
  }
  async function retained(
    raw: Event,
    ready: Awaited<ReturnType<typeof authorize>>,
  ) {
    const opened = await channelOpenEvent(journal.blobs, owner, raw),
      saved = opened.input as ReturnType<typeof inputFor>;
    const deadlineAt = JSON.parse(saved.payload).expiresAt;
    if (
      !Number.isSafeInteger(deadlineAt) ||
      deadlineAt > ready.config.expiresAt ||
      raw.channel !== ready.channel.id ||
      raw.generation !== ready.channel.generation ||
      !exact(raw.binding, ready.channel) ||
      raw.destination !== ready.channel.destination ||
      !exact(raw.artifact, ready.channel.artifact) ||
      !exact(saved, inputFor(ready.intent, ready.destination, deadlineAt)) ||
      opened.digest !== channelDigest(saved)
    )
      throw Error("watch_webhook_destination_drift");
    return { saved, deadlineAt };
  }
  function terminal(
    events: readonly Event[],
    prepared: Event,
    reconcileId?: string,
  ): BrowserWatchActionResult | undefined {
    const receipt = nativeRows(events).findLast(
      (e) =>
        e.channel === prepared.channel &&
        e.generation === prepared.generation &&
        (reconcileId
          ? e.type === "AikoChannelReconcileSettled" &&
            e.id === reconcileId &&
            e.outputId === prepared.id
          : (e.type === "AikoChannelOutputSettled" && e.id === prepared.id) ||
            (e.type === "AikoChannelReconcileSettled" &&
              e.outputId === prepared.id)),
    );
    if (!receipt) return;
    const delivery = receipt.result as ChannelDelivery;
    if (
      !delivery ||
      !["accepted_by_provider", "delivered", "failed", "unknown"].includes(
        delivery.status,
      )
    )
      return unknown("watch_webhook_invalid_receipt");
    return {
      status:
        delivery.status === "delivered" ||
        delivery.status === "accepted_by_provider"
          ? "completed"
          : delivery.status,
      result: { operationId: prepared.id, delivery: structuredClone(delivery) },
    };
  }
  async function execute(
    raw: BrowserWatchDispatch,
    signal: AbortSignal,
  ): Promise<BrowserWatchActionResult> {
    const intent = structuredClone(raw);
    try {
      const ready = await authorize(intent, "execute", signal),
        prior = output(ready.events, intent.operationId);
      if (prior) {
        const saved = await retained(prior, ready);
        return (
          terminal(ready.events, prior) ??
          pending(intent.operationId, saved.deadlineAt)
        );
      }
      const deadlineAt = Math.min(
        ready.config.expiresAt,
        ready.destination.deadlineAt,
        now() + limitMs,
      );
      const input = inputFor(intent, ready.destination, deadlineAt);
      await binding.run(
        binding.runtime.prepare(
          ready.channel.id,
          ready.channel.generation,
          input,
        ),
      );
      // Acknowledgement can race owner revocation. No network call occurs here;
      // authorizeDispatch closes that gap at the real provider boundary.
      return pending(intent.operationId, deadlineAt);
    } catch {
      try {
        return output(await journal.read(), intent.operationId)
          ? unknown("watch_webhook_admission_unconfirmed")
          : failed("watch_webhook_admission_rejected");
      } catch {
        return unknown("watch_webhook_journal_unavailable");
      }
    }
  }
  async function reconcile(
    raw: BrowserWatchDispatch,
    signal: AbortSignal,
  ): Promise<BrowserWatchActionResult> {
    const intent = structuredClone(raw);
    try {
      const ready = await authorize(intent, "reconcile", signal),
        prepared = output(ready.events, intent.operationId);
      if (!prepared) return unknown("watch_webhook_receipt_unavailable");
      const saved = await retained(prepared, ready),
        current = terminal(ready.events, prepared);
      if (!intent.reconciliationRequestId)
        return current ?? pending(intent.operationId, saved.deadlineAt);
      const request = intent.reconciliationRequestId;
      if (
        !/^[a-zA-Z0-9_.-]{1,64}$/.test(request) ||
        !owned(ready.events).some(
          (e) =>
            e.type === "AikoBrowserWatchReconcileRequested" &&
            e.operationId === intent.operationId &&
            e.requestId === request,
        )
      )
        return unknown("watch_webhook_receipt_request_required");
      const prefix = `watch-receipt:${channelDigest([owner, intent.operationId, request])}:`;
      const registered = nativeRows(ready.events).find(
        (e) =>
          e.type === "AikoChannelReconcileRequested" &&
          String(e.id).startsWith(prefix) &&
          e.outputId === intent.operationId,
      );
      const deadlineAt = registered
        ? Number(String(registered.id).slice(prefix.length))
        : Math.min(now() + limitMs, ready.destination.deadlineAt);
      const id = registered ? String(registered.id) : `${prefix}${deadlineAt}`;
      if (
        !Number.isSafeInteger(deadlineAt) ||
        deadlineAt > ready.destination.deadlineAt
      )
        return unknown("watch_webhook_receipt_authority_changed");
      const checked = terminal(ready.events, prepared, id);
      if (checked) return checked;
      if (registered) return pending(id, deadlineAt);
      const delivery = (
        current && "result" in current
          ? (current.result as { delivery?: ChannelDelivery })
          : undefined
      )?.delivery;
      if (
        !delivery ||
        !["accepted_by_provider", "unknown"].includes(delivery.status)
      )
        return current ?? pending(intent.operationId, saved.deadlineAt);
      await binding.run(
        binding.runtime.requestReconcile(
          ready.channel.id,
          ready.channel.generation,
          intent.operationId,
          id,
        ),
      );
      const row = nativeRows(await journal.read()).find(
        (e) => e.type === "AikoChannelReconcileRequested" && e.id === id,
      );
      return row
        ? pending(id, deadlineAt)
        : unknown("watch_webhook_receipt_admission_unconfirmed");
    } catch {
      return unknown("watch_webhook_reconciliation_unavailable");
    }
  }
  /** Invoke immediately before the physical adapter execute, after its native
   * OutputStarted commit. Undefined leaves unrelated channel operations alone. */
  async function authorizeDispatch(
    channel: ChannelBinding,
    operation: ChannelAdapterOperation,
    raw: unknown,
    key: string,
    signal: AbortSignal,
    capture?: (value: { intent: BrowserWatchDispatch; prepared: Event; deadlineAt: number; nativeRequestId: string }) => void,
  ): Promise<boolean | undefined> {
    if (operation !== "send" && operation !== "reconcile") return;
    const input = raw as Record<string, unknown>;
    try {
      const events = await journal.read();
      const prepared =
        operation === "send"
          ? output(events, String(input?.operationId))
          : nativeRows(events).find(
              (e) =>
                e.type === "AikoChannelOutputPrepared" &&
                e.channel === channel.id &&
                e.generation === channel.generation &&
                channelOperationKey(channel, "send", String(e.id)) ===
                  input?.operationId,
            );
      const marked =
        String(input?.operationId).startsWith("watch:") ||
        String(input?.task).startsWith("watch:") ||
        String(prepared?.id).startsWith("watch:");
      if (!marked) return;
      if (!prepared || channel.owner !== owner) return false;
      const { intent } = await reconstruct(String(prepared.id), events),
        ready = await authorize(
          intent,
          operation === "send" ? "execute" : "reconcile",
          signal,
        );
      const saved = await retained(prepared, ready);
      if (!exact(channel, ready.channel)) return false;
      let requestDeadline = saved.deadlineAt, nativeRequestId = String(prepared.id);
      if (operation === "send") {
        const envelope = { ...input };
        // Native send authorization also carries the pinned artifact. The
        // physical adapter input omits it; neither path may change that pin.
        if ("artifact" in envelope) {
          if (!exact(envelope.artifact, channel.artifact)) return false;
          delete envelope.artifact;
        }
        if (
          saved.deadlineAt <= now() ||
          saved.deadlineAt > ready.destination.deadlineAt ||
          key !== channelOperationKey(channel, "send", intent.operationId) ||
          !exact(envelope, { ...saved.saved, destination: channel.destination })
        )
          return false;
      } else {
        const request = nativeRows(events).find(
          (e) =>
            e.type === "AikoChannelReconcileRequested" &&
            e.outputId === intent.operationId &&
            e.channel === channel.id &&
            e.generation === channel.generation &&
            channelOperationKey(channel, "reconcile", String(e.id)) === key,
        );
        if (
          !request ||
          !/^watch-receipt:[a-f0-9]{64}:[0-9]+$/.test(String(request.id))
        )
          return false;
        const deadlineAt = Number(String(request.id).split(":").at(-1));
        requestDeadline = deadlineAt; nativeRequestId = String(request.id);
        if (
          !Number.isSafeInteger(deadlineAt) ||
          deadlineAt <= now() ||
          deadlineAt > ready.destination.deadlineAt ||
          deadlineAt > Number(request.at) + limitMs
        )
          return false;
      }
      const allowed = await binding.current(
        structuredClone(intent),
        signal,
        operation === "send" ? "execute" : "reconcile",
      );
      signal.throwIfAborted();
      if (allowed) capture?.({ intent, prepared, deadlineAt: Math.min(requestDeadline, ready.destination.deadlineAt), nativeRequestId });
      return allowed;
    } catch {
      return false;
    }
  }
  const admissions = new Map<string, { intent: BrowserWatchDispatch; operation: "execute" | "reconcile";
    policyCurrent: () => boolean; signal: AbortSignal; admitted: boolean }>();
  /** Invoked by the owning host inside its physical append transaction. A
   * cached intent supplies identity only; current authority is read right here. */
  function admissionAllowed(batch: readonly Event[], read: () => readonly Event[]) {
    try {
      if (!browserWatchWebhookPermitAppendAllowed(batch, read)) return false;
      for (const event of batch) {
        if (event.type !== "AikoBrowserWatchWebhookPermitted") continue;
        const prior = read().find(e => e.type === event.type && e.owner === owner && e.id === event.id);
        if (prior) { if (!exact(prior, event)) return false; continue; }
        const cached = admissions.get(channelDigest(event));
        if (event.owner !== owner || !cached || cached.signal.aborted || Number(event.expiresAt) <= now() ||
          binding.commitCurrent?.(structuredClone(cached.intent), cached.operation) !== true || cached.policyCurrent() !== true) return false;
        cached.admitted = true;
      }
      return true;
    } catch { return false; }
  }
  async function permit(channel: ChannelBinding, operation: ChannelAdapterOperation, input: unknown, key: string,
    raw: ChannelDispatchPermitIdentity, signal: AbortSignal, policyCurrent?: () => boolean): Promise<ChannelDispatchPermitResult> {
    const denied: ChannelDispatchPermitResult = { status: "denied" };
    if ((operation !== "send" && operation !== "reconcile") || !binding.commitCurrent || !policyCurrent) return denied;
    let event: Event | undefined, commitAttempted = false;
    try {
      signal.throwIfAborted();
      if (!raw || Object.keys(raw).some(k => !["owner", "operationId", "jobDigest", "requestDigest", "nonce", "expiresAt", "policyDigest"].includes(k)) ||
        raw.owner !== owner || raw.operationId !== key || !digestPattern.test(raw.jobDigest) || !digestPattern.test(raw.requestDigest) ||
        !/^[a-f0-9]{64}$/.test(raw.policyDigest) || !/^[a-f0-9-]{36}$/.test(raw.nonce) ||
        !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= now() || raw.expiresAt > now() + 30_000) return denied;
      const identity = structuredClone(raw);
      let ready: { intent: BrowserWatchDispatch; prepared: Event; deadlineAt: number; nativeRequestId: string } | undefined;
      if (await authorizeDispatch(channel, operation, input, key, signal, value => { ready = value; }) !== true ||
        !ready || identity.expiresAt > ready.deadlineAt) return denied;
      const intent = ready.intent, mode = operation === "send" ? "execute" : "reconcile";
      event = { type: "AikoBrowserWatchWebhookPermitted", ...identity, id: permitId(owner, key), at: now(),
        watchOperationId: intent.operationId, watchId: intent.watchId, generation: intent.generation,
        source: (await journal.read()).find(e => e.type === "AikoBrowserWatchStarted" && e.owner === owner && e.id === intent.operationId)?.source,
        channel: channel.id, channelGeneration: channel.generation, bindingDigest: channelDigest(channel), destinationDigest: channelDigest(channel.destination),
        operation, nativeRequestId: ready.nativeRequestId };
      const fact = event;
      const cached = { intent: structuredClone(intent), operation: mode as "execute" | "reconcile", policyCurrent, signal, admitted: false };
      admissions.set(channelDigest(fact), cached);
      if (binding.commitCurrent(structuredClone(intent), mode) !== true || !policyCurrent()) return denied;
      commitAttempted = true;
      const committed = await journal.transact(rows => {
        const prior = rows.find(e => e.type === fact.type && e.owner === owner && e.id === fact.id);
        if (prior) {
          // Retry the exact permission identity, never mint a different nonce for
          // an operation which may already be in flight at the receiver.
          if (!exact({ ...prior, at: fact.at }, fact)) return { events: [], result: "conflict" as const };
          return { events: [], result: "retained" as const };
        }
        if (!browserWatchWebhookPermitAppendAllowed([fact], () => rows)) return { events: [], result: "denied" as const };
        return { events: [fact], result: "appended" as const };
      });
      if (committed === "conflict" || committed === "denied") return denied;
      const retained = (await journal.read()).find(e => e.type === fact.type && e.owner === owner && e.id === fact.id);
      if (!retained || !exact({ ...retained, at: fact.at }, fact) || committed === "appended" && !cached.admitted)
        return { status: "unknown" };
      return { status: "permitted" };
    } catch { return { status: commitAttempted ? "unknown" : "denied" }; }
    finally { if (event) admissions.delete(channelDigest(event)); }
  }
  return { execute, reconcile, authorizeDispatch, permit, admissionAllowed };
}
