import { createHmac, timingSafeEqual } from "node:crypto";
import { channelBindings, channelDigest, type ChannelBinding } from "./channel-bindings.ts";
import type { ChannelAdapterBindings } from "./channel-host.ts";
import { channelOperationKey, type ChannelDelivery } from "./channel-runtime.ts";
import { channelSendRetryPlan, type ChannelControlPlan } from "./channel-controls.ts";
import type { HarnessBlobStore, HarnessDigest, HarnessJournal, HarnessJson } from "./harness-library.ts";
import type { WorkflowKV } from "./workflow-host.ts";
import type { SandboxDispatchChallenge } from "./sandbox-dispatch.ts";

/** Host configuration, never model arguments or observation content. Changing any
 * destination/credential/authority requires a new policy revision and binding. */
export interface WebhookDestinationPolicy {
  id: string;
  revision: string;
  owner: string;
  active: boolean;
  expiresAt: number;
  url: string;
  signingKey: string;
  authorityRef: string;
  sendAuthorityRef: string;
  maxBytes: number;
  retentionMs: number;
  /** Explicit receiver contract: these responses guarantee no acceptance/effect.
   * Other non-2xx responses stay unknown, including redirects. */
  notAcceptedStatuses?: number[];
  /** Optional receiver guarantee, advertised to callers; this adapter still never
   * resends unknown POSTs. Native reconciliation performs GET only. */
  idempotency?: "delivery-id";
  reconcile?: { url: string; receiptKey: string };
  /** Maximum additional attempts after a verified non-acceptance. The owner must
   * retain a native retry-send plan; absent policy denies automatic retries. */
  retries?: { maxRuns: number; minBackoffMs: number; maxDurationMs: number };
}
export type WebhookRequest = {
  owner: string;
  operationId: string;
  policyDigest: string;
  authorityRef: string;
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
  redirect: "manual";
  maxResponseBytes: number;
  /** Receiver-declared, no-effect response codes that must remain observable. */
  notAcceptedStatuses: readonly number[];
  signal: AbortSignal;
  /** Invoke immediately before physical dispatch, after DNS/other awaited work. */
  beforeDispatch(): void | Promise<void>;
  /** A remote runner requests this only after preparing the exact HTTP request.
   * The host's durable permit is the point this one request becomes in flight. */
  authorizeDispatch?(challenge: SandboxDispatchChallenge): Promise<boolean>;
};
/** Trusted network port. Must resolve and pin a public address, forbid redirects,
 * preserve TLS hostname verification and enforce signal/byte limits. Worker hosts
 * use the existing owner-scoped sandbox; Node hosts may use webhook-node.ts.
 * Omitting this port makes the adapter unavailable, never an ambient fetch. */
export interface WebhookTransport {
  /** Only a transport which runs the fence at the outgoing request can accept
   * an additional watch guard. Remote job admission is a different boundary. */
  dispatchBoundary?: "request" | "host-permit" | "sandbox-admission";
  request(input: WebhookRequest): Promise<{ status: number; body?: string }>;
}
const mac = (key: string, text: string) => createHmac("sha256", key).update(text).digest("hex");
const equal = (a: unknown, b: string) => typeof a === "string" && /^[a-f0-9]{64}$/.test(a) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Syntactic admission shared by Worker and Node. The transport MUST additionally
 * reject private DNS answers and pin the checked address at physical dispatch. */
export function webhookTarget(value: string): URL {
  if (typeof value !== "string" || value.length > 2048) throw Error("webhook_destination_invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      url.hostname.endsWith(".") ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|arpa|home|lan|svc)$/.test(url.hostname))
    throw Error("webhook_destination_invalid");
  return url;
}
export const WEBHOOK_ARTIFACT = {
  digest: channelDigest("aiko.webhook-delivery/v1"),
  contractDigest: channelDigest("aiko.webhook-delivery.contract/v1:fixed-payload,hmac,public-https,no-resend,signed-get-reconcile"),
  directions: ["outbox"] as ChannelBinding["artifact"]["directions"],
  operations: ["send", "reconcile"] as ChannelBinding["artifact"]["operations"],
};

export function createWebhookAdapterHost(options: {
  owner: string;
  policies(owner: string): readonly WebhookDestinationPolicy[];
  currentOwner(): boolean;
  journal: HarnessJournal;
  blobs: HarnessBlobStore;
  kv: WorkflowKV;
  transport?: WebhookTransport;
  now?: () => number;
}) {
  const { owner, blobs, kv, journal } = options;
  const now = options.now ?? Date.now;
  const stamp = (p: WebhookDestinationPolicy) => channelDigest({
    ...p, signingKey: mac(p.signingKey, "aiko.webhook.credential-revision/v1"),
    reconcile: p.reconcile ? { url: p.reconcile.url, receiptKey: mac(p.reconcile.receiptKey, "aiko.webhook.receipt-revision/v1") } : null,
  });
  const valid = (p: WebhookDestinationPolicy) => {
    try {
      webhookTarget(p.url);
      if (p.reconcile) webhookTarget(p.reconcile.url);
      return options.currentOwner() && !!options.transport && p.owner === owner && p.active &&
        token(p.id) && token(p.revision) && token(p.authorityRef) && token(p.sendAuthorityRef) &&
        Number.isSafeInteger(p.expiresAt) && p.expiresAt > now() &&
        typeof p.signingKey === "string" && p.signingKey.length >= 32 &&
        Number.isSafeInteger(p.maxBytes) && p.maxBytes > 0 && p.maxBytes <= 65536 &&
        Number.isSafeInteger(p.retentionMs) && p.retentionMs > 0 && p.retentionMs <= 86400000 &&
        (!p.reconcile || typeof p.reconcile.receiptKey === "string" && p.reconcile.receiptKey.length >= 32) &&
        (p.idempotency === undefined || p.idempotency === "delivery-id") &&
        (!p.retries || Number.isSafeInteger(p.retries.maxRuns) && p.retries.maxRuns > 0 && p.retries.maxRuns <= 16 &&
          Number.isSafeInteger(p.retries.minBackoffMs) && p.retries.minBackoffMs >= 100 && p.retries.minBackoffMs <= 3600000 &&
          Number.isSafeInteger(p.retries.maxDurationMs) && p.retries.maxDurationMs > 0 && p.retries.maxDurationMs <= p.retentionMs) &&
        (p.notAcceptedStatuses === undefined || Array.isArray(p.notAcceptedStatuses) &&
          p.notAcceptedStatuses.length <= 16 && p.notAcceptedStatuses.every(n => Number.isInteger(n) && n >= 400 && n <= 599));
    } catch { return false; }
  };
  const policies = () => options.policies(owner).filter(valid).map(p => structuredClone(p));
  const policy = (id: string) => {
    const found = policies().filter(p => p.id === id);
    return found.length === 1 ? found[0] : undefined;
  };
  const destination = (p: WebhookDestinationPolicy) => `webhook:${p.id}:${p.revision}`;
  const selected = (b: ChannelBinding) => {
    const p = policy(b.account);
    return p && b.owner === owner && b.route === `user-${owner}` &&
      b.source === `webhook:${p.id}` && b.destination === destination(p) &&
      b.authorization === p.authorityRef && b.providerPolicyDigest === stamp(p) &&
      channelDigest(b.artifact) === channelDigest(WEBHOOK_ARTIFACT) &&
      b.maxBytes <= p.maxBytes && b.retentionMs <= p.retentionMs &&
      !b.credentialRefs.length && !b.ingressBeforeSubscribe ? p : undefined;
  };
  const current = (b: ChannelBinding, expected: string) => {
    const p = selected(b);
    if (!p || stamp(p) !== expected) throw Error("webhook_authority_changed");
  };
  const proofKey = (evidence: string) => `webhook-adapter-proof:${channelDigest(owner)}:${evidence}`;
  const retain = async (b: ChannelBinding, p: WebhookDestinationPolicy, operation: string, key: string,
    deliveryId: string, requestDigest: string, status: ChannelDelivery["status"], detail: Record<string, HarnessJson>) => {
    const evidence = `webhook-proof:${channelDigest([owner, b.id, b.generation, operation, key])}`;
    const result: ChannelDelivery = { status, evidence, providerId: deliveryId };
    const receipt = { owner, channel: b.id, generation: b.generation, policy: stamp(p), operation,
      key, deliveryId, requestDigest, result, detail, expiresAt: now() + b.retentionMs };
    const ref = await blobs.putPrivate(owner, receipt as unknown as HarnessJson);
    await kv.update(proofKey(evidence), old => {
      if (old) throw Error("webhook_receipt_already_retained");
      return { ref };
    });
    return result;
  };
  const adapters: ChannelAdapterBindings = {
    controlPolicy: async (b,plan) => {
      const p=selected(b),limit=p?.retries;
      if(!p || !limit || plan.action!=="retry-send" || plan.maxRuns>limit.maxRuns ||
        plan.backoffMs<limit.minBackoffMs || plan.intervalMs<limit.minBackoffMs ||
        plan.expiresAt>Math.min(p.expiresAt,now()+limit.maxDurationMs) || plan.leaseLeadMs!==0)return;
      return stamp(p);
    },
    authenticate: async () => undefined,
    artifactAllowed: async b => !!selected(b),
    authorize: async (account, authority, operation, input) => {
      if (account !== owner || !options.currentOwner()) return false;
      const v = input as Partial<ChannelBinding>;
      if (!v || typeof v !== "object") return false;
      const candidates = operation === "bind" && v.owner === owner && v.artifact
        ? [v as ChannelBinding] : [...channelBindings(await journal.read(), owner).values()];
      return candidates.some(b => {
        const p = selected(b);
        if (!p) return false;
        return operation === "send" ? authority === p.sendAuthorityRef && v.destination === b.destination && !!v.artifact &&
          channelDigest(v.artifact) === channelDigest(b.artifact) : authority === p.authorityRef &&
          v.id === b.id && v.generation === b.generation;
      });
    },
    validateReceipt: async (b, operation, result) => {
      try {
        const p = selected(b), r = result as ChannelDelivery;
        if (!p || typeof r?.evidence !== "string") return false;
        const pointer = await kv.get(proofKey(r.evidence)) as { ref: HarnessDigest } | undefined;
        if (!pointer) return false;
        const proof = await blobs.get(owner, pointer.ref) as any;
        current(b, stamp(p));
        return proof.owner === owner && proof.channel === b.id && proof.generation === b.generation &&
          proof.policy === stamp(p) && proof.operation === operation && proof.expiresAt > now() &&
          channelDigest(proof.result) === channelDigest(r);
      } catch { return false; }
    },
    dispatchGuardSupported: () => ["request", "host-permit"].includes(options.transport?.dispatchBoundary ?? ""),
    execute: async (b, operation, input, key, signal, dispatchGuard) => {
      const p = selected(b);
      if (!p || !options.transport || !["send", "reconcile"].includes(operation)) throw Error("webhook_adapter_unavailable");
      const expected = stamp(p), value = input as Record<string, unknown>;
      if (!value || typeof value !== "object" || !token(key)) throw Error("webhook_input_invalid");
      const deliveryId = operation === "send" ? value.deliveryId ?? key : value.operationId;
      if (!token(deliveryId)) throw Error("webhook_delivery_id_invalid");
      if(operation==="send" && value.deliveryId!==undefined) {
        const plan=channelSendRetryPlan(await journal.read(),b,String(value.operationId));
        if(!plan || channelOperationKey(b,"send",(plan.plan as ChannelControlPlan).partition)!==deliveryId ||
          key!==channelOperationKey(b,"send",String(value.operationId)))throw Error("webhook_retry_lineage_invalid");
        current(b,expected);
      }
      const requestDigest = mac(p.signingKey, channelDigest(value));
      // The runtime's OutputStarted claim owns dispatch uniqueness. A retained
      // proof is a receipt cache only and can never authorize another send.
      const evidence = `webhook-proof:${channelDigest([owner, b.id, b.generation, operation, key])}`;
      const prior = await kv.get(proofKey(evidence)) as { ref: HarnessDigest } | undefined;
      current(b, expected);
      if (prior) {
        const proof = await blobs.get(owner, prior.ref) as any;
        current(b, expected);
        if (proof.policy !== expected || proof.deliveryId !== deliveryId || proof.requestDigest !== requestDigest || proof.expiresAt <= now()) throw Error("webhook_receipt_unavailable");
        return proof.result;
      }
      if (operation === "reconcile" && !p.reconcile)
        return retain(b, p, operation, key, deliveryId, requestDigest, "unknown", { reason: "receiver_has_no_reconciliation" });
      if (operation === "send" && (value.destination !== b.destination || value.authorization !== p.sendAuthorityRef ||
          typeof value.payload !== "string" || bytes(value.payload) > Math.min(b.maxBytes, p.maxBytes)))
        throw Error("webhook_payload_or_authority_invalid");
      const url = webhookTarget(operation === "send" ? p.url : p.reconcile!.url);
      if (operation === "reconcile") url.searchParams.set("delivery_id", deliveryId);
      // Fixed wire envelope avoids accidental exposure of task text, grants,
      // browser content or arbitrary native receipt fields.
      const body = operation === "send" ? JSON.stringify({ version: 1, deliveryId, payload: value.payload }) : undefined;
      const signed = JSON.stringify([1, operation, deliveryId, url.href, body ?? ""]);
      let response: Awaited<ReturnType<WebhookTransport["request"]>>;
      let dispatched = false;
      try {
        signal.throwIfAborted();
        current(b, expected);
        if (dispatchGuard && options.transport.dispatchBoundary !== "request" &&
          !(options.transport.dispatchBoundary === "host-permit" && dispatchGuard.permit))
          throw Error("webhook_physical_authority_fence_unavailable");
        response = await options.transport.request({ owner, operationId: key, policyDigest: expected,
          authorityRef: operation === "send" ? p.sendAuthorityRef : p.authorityRef,
          url: url.href, method: operation === "send" ? "POST" : "GET",
          headers: { "content-type": "application/json", "x-aiko-delivery-id": deliveryId,
            "x-aiko-proof": `v1=${mac(p.signingKey, signed)}` },
          ...(body === undefined ? {} : { body }), redirect: "manual", maxResponseBytes: 16384,
          notAcceptedStatuses: p.notAcceptedStatuses ?? [],
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          beforeDispatch: async () => {
            await dispatchGuard?.beforeDispatch();
            signal.throwIfAborted(); current(b, expected); dispatched = true;
          },
          ...(dispatchGuard?.permit && options.transport.dispatchBoundary === "host-permit" ? {
            authorizeDispatch: async (challenge: SandboxDispatchChallenge) => {
              signal.throwIfAborted(); current(b, expected);
              if (challenge.owner !== owner || challenge.operationId !== `webhook:${key}`) throw Error("webhook_dispatch_identity_mismatch");
              try {
                const decision = await dispatchGuard.permit!({ owner, operationId: key, jobDigest: challenge.jobDigest,
                  requestDigest: challenge.requestDigest, nonce: challenge.nonce, expiresAt: challenge.expiresAt, policyDigest: expected }, signal,
                  () => { try { current(b, expected); return true; } catch { return false; } });
                if (decision.status === "denied") return false;
                // A permit (or lost permit acknowledgement) is in flight even if
                // cancellation prevents this client from sending its continuation.
                dispatched = true;
                return decision.status === "permitted";
              } catch { dispatched = true; throw Error("webhook_permit_outcome_unknown"); }
            },
          } : {}),
        });
        if (!dispatched) throw Error("webhook_transport_missing_dispatch_fence");
      } catch {
        return retain(b, p, operation, key, deliveryId, requestDigest, dispatched ? "unknown" : "failed",
          { reason: dispatched ? "transport_outcome_unknown" : "not_dispatched" });
      }
      // Keep physical evidence even if authorization changed during the request;
      // validateReceipt will refuse to apply it under revoked authority.
      let status: ChannelDelivery["status"] = "unknown";
      const detail: Record<string, HarnessJson> = { httpStatus: response.status };
      if (operation === "send") {
        if (response.status >= 200 && response.status < 300) status = "accepted_by_provider";
        else if (p.notAcceptedStatuses?.includes(response.status)) status = "failed";
      } else if (response.status === 200 && typeof response.body === "string" && bytes(response.body) <= 16384) {
        try {
          const envelope = JSON.parse(response.body), receipt = envelope.receipt;
          if (receipt && Object.keys(receipt).sort().join(",") === "deliveryId,status,version" && receipt.version === 1 &&
              receipt.deliveryId === deliveryId && ["accepted_by_provider", "delivered", "failed", "unknown"].includes(receipt.status) &&
              equal(envelope.signature, mac(p.reconcile!.receiptKey, channelDigest(receipt)))) {
            status = receipt.status;
            detail.receiverReceipt = receipt;
            detail.receiverSignature = envelope.signature;
          }
        } catch { /* Invalid receiver data never establishes an outcome. */ }
      }
      return retain(b, p, operation, key, deliveryId, requestDigest, status, detail);
    },
  };
  return {
    adapters,
    accepts: (b: ChannelBinding) => b.artifact.digest === WEBHOOK_ARTIFACT.digest,
    catalog: () => policies().map(p => ({ id: p.id, revision: p.revision, hostname: webhookTarget(p.url).hostname,
      maxBytes: p.maxBytes, reconciliation: !!p.reconcile, idempotency: p.idempotency ?? null, retries:p.retries??null })),
    bindingInput(id: string, name: string, generation: number): Omit<ChannelBinding, "id" | "owner" | "status"> {
      const p = policy(id);
      if (!p) throw Error("webhook_destination_unavailable");
      return { name, generation, artifact: structuredClone(WEBHOOK_ARTIFACT), account: p.id,
        source: `webhook:${p.id}`, destination: destination(p), route: `user-${owner}`, credentialRefs: [],
        authorization: p.authorityRef, backlog: 64, maxBytes: p.maxBytes, maxHops: 8,
        retentionMs: p.retentionMs, queuedWork: "cancel", providerPolicyDigest: stamp(p) };
    },
  };
}

/** Compose through the existing runtime security ports. No destination policy
 * or webhook artifact can accidentally fall through to a provider planner. */
export function composeWebhookAdapters(base: ChannelAdapterBindings,
  webhook: ReturnType<typeof createWebhookAdapterHost>, journal: HarnessJournal): ChannelAdapterBindings {
  const selected=(b:ChannelBinding)=>webhook.accepts(b)?webhook.adapters:base;
  return {...base,
    dispatchGuardSupported:b=>selected(b).dispatchGuardSupported?.(b)===true,
    artifactAllowed:b=>selected(b).artifactAllowed(b),
    authenticate:(b,...args)=>selected(b).authenticate(b,...args),
    execute:(b,...args)=>selected(b).execute(b,...args),
    validateReceipt:(b,...args)=>selected(b).validateReceipt(b,...args),
    controlPolicy:async(b,p)=>selected(b).controlPolicy?.(b,p),
    authorize:async(owner,authority,operation,input)=>{
      const v=input as Partial<ChannelBinding>;
      if(!v || typeof v!=="object")return false;
      const b=v.artifact?.digest===WEBHOOK_ARTIFACT.digest ? v as ChannelBinding :
        [...channelBindings(await journal.read(),owner).values()].find(b=>webhook.accepts(b)&&(b.id===v.id||b.destination===v.destination));
      return (b?webhook.adapters:base).authorize(owner,authority,operation,input);
    },
  };
}
