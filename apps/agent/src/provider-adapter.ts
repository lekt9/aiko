import {channelControlState} from "./channel-controls.ts";
import { channelWiringView } from "./channel-wiring.ts";
import { HarnessAcquisition } from "./harness-acquisition.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import type { NativeTool } from "tardie/component/tool";
import { validateSiteHarnessArtifact } from "@unbrowse/browser-harness/harness-artifact";
import {
  harnessDigest,
  type HarnessArtifact,
  type HarnessContract,
  type HarnessVerifier,
  type HarnessLibraryBinding,
  type HarnessJournal,
  type HarnessDigest,
  type HarnessJson,
} from "./harness-library.ts";
import {
  channelHarnessAdapters,
  type HostedChannels,
  type ChannelAdapterBindings,
} from "./channel-host.ts";
import {
  channelBindings,
  channelId,
  channelDigest,
  type ChannelBinding,
} from "./channel-bindings.ts";
import {
  channelOperationKey,
  type ChannelAdapterOperation,
} from "./channel-runtime.ts";
import type {
  ChannelBridgeBindings,
  ChannelBridgeSpec,
  ChannelSourceGrant,
} from "./channel-ingress.ts";
import {
  sandboxDigest,
  verifySandboxReceipt,
  type SandboxJob,
} from "./sandbox-job.ts";
import type { RegistrySandboxTransport } from "./registry-defaults.ts";
import type { WorkflowKV } from "./workflow-host.ts";

/** Trusted application policy. Secrets never enter generated planner code or the
 * native log. Endpoint maps cannot be supplied by a tool or learned artifact.
 * Protocol v1 requires signed JSON receipts and keyed GET reconciliation. */
export interface ProviderAdapterPolicy {
  id: string;
  revision: string;
  owner: string;
  active: boolean;
  expiresAt: number;
  account: string;
  source: string;
  destination?: string;
  authorityRef: string;
  sendAuthorityRef?: string;
  ingressBaseUrl: string;
  origin: string;
  receiveKey: string;
  receiptKey: string;
  requestToken: string;
  endpoints: Partial<
    Record<Exclude<ChannelAdapterOperation, "decode">, string>
  >;
  definition: {
    artifact: HarnessArtifact;
    contract: HarnessContract;
    verifier: HarnessVerifier;
  };
  maxInstances: number;
  maxBytes: number;
  backlog: number;
  retentionMs: number;
  automaticControls?: {maxRuns:number;minIntervalMs:number;maxDurationMs:number};
  leaseReceiptVersion?: "signed-lease-v1";
}
export type ProviderAdapterPolicies = (
  owner: string,
) => readonly ProviderAdapterPolicy[];
const mac = (key: string, value: string) =>
  createHmac("sha256", key).update(value).digest("hex");
const equal = (a: string, b: string) =>
  /^[a-f0-9]{64}$/.test(a) &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const routeOf = (owner: string, channel: string) =>
  `pa_${Buffer.from(owner).toString("base64url")}_${channel}`;
export function providerAdapterRouteOwner(route: string): string | undefined {
  const match = /^pa_([A-Za-z0-9_-]+)_([a-f0-9]{64})$/.exec(route);
  if (!match) return;
  const owner = Buffer.from(match[1]!, "base64url").toString();
  return routeOf(owner, match[2]!) === route ? owner : undefined;
}
function supported(p: ProviderAdapterPolicy) {
  try {
    const origin = new URL(p.origin),
      ingress = new URL(p.ingressBaseUrl);
    return (
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(p.id) &&
      p.active &&
      p.expiresAt > Date.now() &&
      p.revision &&
      p.receiveKey.length >= 24 &&
      p.receiptKey.length >= 24 &&
      p.requestToken.length >= 24 &&
      origin.origin === p.origin &&
      !origin.username &&
      !origin.password &&
      ["https:", "http:"].includes(origin.protocol) &&
      (origin.protocol === "https:" ||
        ["127.0.0.1", "localhost"].includes(origin.hostname)) &&
      ["https:", "http:"].includes(ingress.protocol) &&
      !ingress.username &&
      !ingress.password &&
      (ingress.protocol === "https:" ||
        ["127.0.0.1", "localhost"].includes(ingress.hostname)) &&
      typeof p.endpoints.reconcile === "string" &&
      (typeof p.endpoints.poll === "string" ||
        (typeof p.endpoints.subscribe === "string" &&
          typeof p.endpoints.remove === "string")) &&
      Object.values(p.endpoints).every((path) =>
        /^\/[A-Za-z0-9/_-]+$/.test(path!),
      ) &&
      Number.isSafeInteger(p.maxInstances) &&
      p.maxInstances > 0 &&
      p.maxInstances <= 16 &&
      Number.isSafeInteger(p.maxBytes) &&
      p.maxBytes > 0 &&
      p.maxBytes <= 65536 &&
      Number.isSafeInteger(p.backlog) &&
      p.backlog > 0 &&
      p.backlog <= 64 &&
      p.retentionMs > 0 &&
      p.retentionMs <= 3600000 &&
      p.definition.contract.verifierDigest === p.definition.verifier.digest &&
      p.definition.contract.evaluatorDigest ===
        p.definition.verifier.evaluatorDigest &&
      p.definition.artifact.contractDigest ===
        harnessDigest(p.definition.contract) &&
      p.definition.contract.effect === "read" &&
      p.definition.artifact.runtime === "javascript"
    );
  } catch {
    return false;
  }
}
export function createProviderAdapterHost(options: {
  owner: string;
  library: HarnessLibraryBinding;
  journal: HarnessJournal;
  kv: WorkflowKV;
  transport: RegistrySandboxTransport;
  policies: ProviderAdapterPolicies;
  currentOwner(): boolean;
}) {
  const { owner, library: binding, journal, kv, transport } = options;
  if (binding.owner !== owner || binding.thread !== `user-${owner}`)
    throw Error("provider_owner_scope");
  const policy = (id: string) =>
    options
      .policies(owner)
      .find((p) => p.id === id && p.owner === owner && supported(p));
  const selected = (b: ChannelBinding) => {
    const p = policy(b.account);
    if (
      !p ||
      !options.currentOwner() ||
      b.owner !== owner ||
      b.route !== binding.thread ||
      b.source !== p.source ||
      b.destination !== p.destination ||
      b.authorization !== p.authorityRef ||
      b.credentialRefs.length ||
      b.artifact.contractDigest !== harnessDigest(p.definition.contract) ||
      b.maxBytes > p.maxBytes ||
      b.backlog > p.backlog ||
      b.retentionMs > p.retentionMs ||
      !b.ingressBeforeSubscribe ||
      b.provisioningScope?.id !== p.id ||
      b.provisioningScope.limit !== p.maxInstances ||
      b.providerPolicyDigest !== stamp(p) ||
      b.artifact.operations.some(
        (op) => !["decode", ...Object.keys(p.endpoints)].includes(op),
      ) ||
      (b.artifact.directions.includes("outbox") &&
        (!p.sendAuthorityRef || !p.endpoints.send || !p.destination))
    )
      return;
    return p;
  };
  const stamp = (p: ProviderAdapterPolicy) =>
    harnessDigest({
      owner,
      id: p.id,
      revision: p.revision,
      expiresAt: p.expiresAt,
      origin: p.origin,
      endpoints: p.endpoints,
      account: p.account,
      ingress: p.ingressBaseUrl,
      contract: harnessDigest(p.definition.contract),
      maxInstances: p.maxInstances,
      maxBytes: p.maxBytes,
      backlog: p.backlog,
      retentionMs: p.retentionMs,
      automaticControls:p.automaticControls??null,
      leaseReceiptVersion:p.leaseReceiptVersion??null,
      source: p.source,
      destination: p.destination ?? null,
      authority: p.authorityRef,
      send: p.sendAuthorityRef ?? null,
      credentialRevision: mac(p.receiptKey, p.receiveKey + p.requestToken),
    });
  const current = (b: ChannelBinding, p: ProviderAdapterPolicy) => {
    const next = selected(b);
    if (!next || stamp(next) !== stamp(p))
      throw Error("provider_authority_changed");
  };
  const receiptKey = (evidence: string) =>
    `provider-adapter-receipt:${owner}:${evidence}`;
  const authenticate: ChannelAdapterBindings["authenticate"] = async (
    b,
    req,
    body,
  ) => {
    const p = selected(b);
    if (!p) return;
    const occurrence = req.headers.get("x-provider-occurrence"),
      conversation = req.headers.get("x-provider-conversation"),
      signature = req.headers.get("x-provider-signature") ?? "";
    if (
      !occurrence ||
      !conversation ||
      occurrence.length > 256 ||
      conversation.length > 256 ||
      !equal(
        signature,
        mac(
          p.receiveKey,
          JSON.stringify([
            owner,
            p.account,
            b.id,
            b.generation,
            occurrence,
            conversation,
            body,
          ]),
        ),
      )
    )
      return;
    return {
      principal: b.source,
      occurrence,
      conversation,
      partition: p.account,
      ancestry: [],
      evidence: `provider-signature:${channelDigest([b.id, occurrence])}`,
    };
  };
  const receivingReady = async (b: ChannelBinding) => {
    const rows = await journal.read();
    const armed = rows.find(
      (e) =>
        e.type === "AikoChannelIngressArmed" &&
        e.owner === owner &&
        e.channel === b.id &&
        e.generation === b.generation,
    );
    const receipt = rows.find(
      (e) =>
        e.type === "AikoChannelBridgeBound" &&
        e.owner === owner &&
        e.id === armed?.bridge,
    );
    const spec = receipt?.bridge as ChannelBridgeSpec | undefined;
    if (
      !spec ||
      spec.external.channel !== b.id ||
      spec.external.generation !== b.generation ||
      spec.expiresAt <= Date.now() ||
      rows.some(
        (e) =>
          e.type === "AikoChannelBridgeRevoked" &&
          e.owner === owner &&
          e.id === armed?.bridge,
      )
    )
      return false;
    const wires = [...channelWiringView(rows, owner).wires.values()].filter(
        (w) => w.id === spec.wiring.id,
      ),
      wire = wires.at(-1);
    return (
      wire?.status === "active" && wire.generation === spec.wiring.generation
    );
  };
  const security: Omit<ChannelAdapterBindings, "artifactAllowed" | "execute"> =
    {
      // Generated instances admit only through the stable receive-only route;
      // account authentication alone is never a provider ingress capability.
      authenticate: async () => undefined,
      authorize: async (account, authority, operation, input) => {
        if (account !== owner || !options.currentOwner()) return false;
        const value = input as any;
        const b =
          value?.owner === owner &&
          typeof value.id === "string" &&
          value.artifact
            ? (value as ChannelBinding)
            : [...channelBindings(await journal.read(), owner).values()].find(
                (b) =>
                  b.id === value?.id ||
                  (b.destination === value?.destination &&
                    b.authorization === authority) ||
                  (operation === "send" &&
                    policy(b.account)?.sendAuthorityRef === authority),
              );
        const p = b && selected(b);
        if (!p) return false;
        return operation === "send"
          ? !!p.sendAuthorityRef &&
              authority === p.sendAuthorityRef &&
              b!.destination === p.destination
          : authority === p.authorityRef;
      },
      validateReceipt: async (b, operation, result) => {
        const p = selected(b),
          r = result as any;
        if (!p || typeof r?.evidence !== "string") return false;
        const retained = (await kv.get(receiptKey(r.evidence))) as
          { ref?: HarnessDigest } | undefined;
        if (!retained?.ref) return false;
        const proof = (await binding.blobs.get(owner, retained.ref)) as any;
        current(b, p);
        return (
          proof.channel === b.id &&
          proof.generation === b.generation &&
          proof.operation === operation &&
          proof.policy === stamp(p) &&
          equal(
            proof.signature,
            mac(p.receiptKey, harnessDigest(proof.receipt)),
          ) &&
          harnessDigest(proof.result) === harnessDigest(r)
        );
      },
    };
  const planner = channelHarnessAdapters(binding, journal, security);
  const adapters: ChannelAdapterBindings = {
    ...planner,
    controlPolicy:async(b,plan)=>{
      const p=selected(b),limits=p?.automaticControls;
      if(!p || !limits || !options.currentOwner() || !Number.isSafeInteger(limits.maxRuns) || limits.maxRuns<1 || limits.maxRuns>16 || !Number.isSafeInteger(limits.minIntervalMs) || limits.minIntervalMs<100 || !Number.isSafeInteger(limits.maxDurationMs) || limits.maxDurationMs<1 || limits.maxDurationMs>86400000 ||
        plan.partition!=="provider" || plan.maxRuns>limits.maxRuns || plan.intervalMs<limits.minIntervalMs || plan.expiresAt>p.expiresAt || plan.expiresAt>Date.now()+limits.maxDurationMs || plan.action==="renew" && p.leaseReceiptVersion!=="signed-lease-v1")return undefined;
      return await planner.authorize(owner,p.authorityRef,"change",{id:b.id,generation:b.generation,operation:"schedule"})?stamp(p):undefined;
    },
    execute: async (b, operation, input, key, signal) => {
      const p = selected(b);
      if (!p || !(await planner.artifactAllowed(b)))
        throw Error("provider_adapter_unavailable");
      const planned = (await planner.execute(
        b,
        operation,
        input,
        key + ":plan",
        signal,
      )) as any;
      current(b, p);
      if (operation === "decode") return planned;
      if (
        !["subscribe", "send", "remove", "reconcile", "renew", "poll"].includes(
          operation,
        ) ||
        !p.endpoints[operation as keyof typeof p.endpoints]
      )
        throw Error("provider_operation_unavailable");
      if (operation === "send" && (!p.sendAuthorityRef || !p.destination))
        throw Error("provider_send_unavailable");
      // Planner output is only payload data. It cannot select URL, verb, headers,
      // account, operation key, custody route, credentials or evidence.
      if (
        !planned ||
        Object.keys(planned).join() !== "payload" ||
        Buffer.byteLength(JSON.stringify(planned.payload)) > p.maxBytes
      )
        throw Error("provider_plan_contract");
      const route = routeOf(owner, b.id),
        token = mac(p.receiveKey, JSON.stringify([route, b.generation]));
      const subscriptionReceipt = (await journal.read())
        .filter(
          (e) =>
            [
              "AikoChannelSubscriptionSettled",
              "AikoChannelRenewSettled",
            ].includes(e.type) &&
            e.owner === owner &&
            e.channel === b.id &&
            e.generation === b.generation &&
            e.status === "ready",
        )
        .at(-1)?.receipt as any;
      let pollCursor: unknown = null;
      if (operation === "poll") {
        if (
          (input as any)?.partition !== "provider" ||
          !(await receivingReady(b))
        )
          throw Error("provider_poll_scope");
        const ref = (input as any).cursor;
        if (ref !== null) {
          const stored = (await kv.get(
            `provider-poll-cursor:${owner}:${b.id}:${b.generation}:${ref}`,
          )) as { ref?: HarnessDigest } | undefined;
          if (!stored?.ref) throw Error("provider_poll_cursor_unavailable");
          pollCursor = await binding.blobs.get(owner, stored.ref);
        }
      }
      const body = {
        owner,
        account: p.account,
        operation,
        key,
        channel: b.id,
        generation: b.generation,
        destination: p.destination ?? null,
        payload:
          operation === "poll"
            ? {
                partition: p.account,
                cursor: pollCursor,
                limit: Math.min(b.backlog, 64),
              }
            : planned.payload,
        subscriptionKey: channelOperationKey(
          b,
          "subscribe",
          `subscribe:${b.generation}`,
        ),
        subscriptionRef: subscriptionReceipt?.subscriptionRef ?? null,
        ...(operation === "subscribe"
          ? {
              webhook: new URL(`/v1/channel-ingress/${route}`, p.ingressBaseUrl)
                .href,
              receiveCapability: token,
            }
          : {}),
      };
      const requestEnvelope = {
        request: body,
        proof: mac(p.requestToken, harnessDigest(body)),
      };
      const method = ["reconcile", "poll"].includes(operation) ? "GET" : "POST",
        inputValues = {
          body: requestEnvelope,
          query: JSON.stringify(requestEnvelope),
        };
      const graph = validateSiteHarnessArtifact({
        schemaVersion: 2,
        executorAbi: "site-harness/1",
        siteId: "provider-adapter",
        version: "1",
        sourceCaptureDigest: b.artifact.digest,
        allowedOrigins: [p.origin],
        actions: [
          {
            id: operation,
            inputs: [
              { name: "body", type: "json", required: true },
              { name: "query", type: "string", required: true },
            ],
            steps: [
              {
                id: operation,
                method,
                origin: p.origin,
                path: p.endpoints[operation as keyof typeof p.endpoints],
                pathParameters: {},
                query:
                  method === "GET"
                    ? { request: { kind: "input", name: "query" } }
                    : {},
                headers: {},
                ...(method === "POST"
                  ? { body: { kind: "input", name: "body" } }
                  : {}),
                dependsOn: [],
                expectedStatuses: [200],
              },
            ],
          },
        ],
      });
      const artifact = { kind: "network" as const, graph, actionId: operation },
        environmentDigest = await transport.sandbox.harnessEnvironment(signal);
      const job: SandboxJob = {
        version: 1,
        owner,
        operationId: `provider:${key}`,
        contextRef: stamp(p),
        authorityRef: p.authorityRef,
        artifact,
        harnessDigest: await sandboxDigest(artifact),
        dependencyLock: {},
        dependencyLockDigest: await sandboxDigest({}),
        environmentDigest,
        input: inputValues,
        authority: { origins: [p.origin], methods: [method] },
        budget: { wallMs: 10000, requests: 1, outputBytes: 65536 },
      };
      current(b, p);
      if (
        ["subscribe", "poll"].includes(operation) &&
        !(await receivingReady(b))
      )
        throw Error("provider_ingress_not_armed");
      signal.throwIfAborted();
      const receipt = await verifySandboxReceipt(
        job,
        await transport.sandbox.harnessJob(job, signal),
      );
      current(b, p);
      if (
        ["subscribe", "poll"].includes(operation) &&
        !(await receivingReady(b))
      )
        throw Error("provider_ingress_revoked_after_dispatch");
      if (receipt.status !== "completed")
        throw Error("provider_operation_unknown");
      const envelope = (receipt.output as any)?.terminal,
        signed = envelope?.receipt;
      if (
        !signed ||
        !equal(
          envelope.signature ?? "",
          mac(p.receiptKey, harnessDigest(signed)),
        ) ||
        signed.owner !== owner ||
        signed.account !== p.account ||
        signed.channel !== b.id ||
        signed.generation !== b.generation ||
        signed.operation !== operation ||
        signed.key !== key ||
        signed.requestDigest !== harnessDigest(body)
      )
        throw Error("provider_receipt_provenance");
      const subscription =
        operation === "renew" ||
        operation === "subscribe" ||
        operation === "remove" ||
        (operation === "reconcile" && (input as any)?.kind === "subscription");
      const statuses = subscription
        ? [
            operation === "remove" || b.status === "retiring"
              ? "removed"
              : operation === "renew" ||
                  (input as any)?.originalOperation === "renew"
                ? "renewed"
                : "ready",
          ]
        : operation === "poll"
          ? ["polled", "gap"]
          : ["accepted_by_provider", "delivered", "failed", "unknown"];
      if (
        !statuses.includes(signed.status) ||
        (subscription
          ? typeof signed.subscriptionRef !== "string" ||
            !signed.subscriptionRef ||
            signed.subscriptionRef.length > 256
          : operation !== "poll" &&
            signed.status !== "unknown" &&
            (typeof signed.providerId !== "string" ||
              !signed.providerId ||
              signed.providerId.length > 256))
      )
        throw Error("provider_receipt_contract");
      const evidence = `provider-proof:${channelDigest([owner, b.id, b.generation, key])}`;
      let pollResult: object | undefined;
      if (operation === "poll") {
        if (
          signed.partition !== p.account ||
          signed.previous !== pollCursor ||
          typeof signed.cursor !== "string" ||
          signed.cursor.length > 2048 ||
          !Array.isArray(signed.items) ||
          signed.items.length > Math.min(b.backlog, 64) ||
          (signed.status === "gap" && signed.items.length) ||
          (signed.cursor === pollCursor && signed.items.length)
        )
          throw Error("provider_poll_contract");
        const cursor = mac(
          p.receiptKey,
          JSON.stringify([owner, b.id, b.generation, p.account, signed.cursor]),
        );
        const ref = await binding.blobs.putPrivate(owner, signed.cursor);
        await kv.update(
          `provider-poll-cursor:${owner}:${b.id}:${b.generation}:${cursor}`,
          (old) => old ?? { ref },
        );
        pollResult = {
          status: signed.status,
          evidence,
          cursor,
          previous: (input as any).cursor,
          partition: (input as any).partition,
          items: signed.items.map((item: any) => {
            if (
              !item ||
              typeof item.occurrence !== "string" ||
              !item.occurrence ||
              item.occurrence.length > 256 ||
              typeof item.conversation !== "string" ||
              !item.conversation ||
              item.conversation.length > 256
            )
              throw Error("provider_poll_item");
            return {
              observation: item.observation,
              context: {
                principal: b.source,
                occurrence: item.occurrence,
                conversation: item.conversation,
                partition: "provider",
                ancestry: [],
                evidence,
              },
            };
          }),
        };
      }
      if(subscription && p.leaseReceiptVersion==="signed-lease-v1" && operation!=="remove" && (signed.receiptVersion!=="signed-lease-v1" || !Number.isSafeInteger(signed.leaseExpiresAt) || signed.leaseExpiresAt<=Date.now()))throw Error("provider_signed_lease_invalid");
      const result = pollResult ?? {
        status: signed.status,
        evidence,
        ...(subscription
          ? { subscriptionRef: signed.subscriptionRef, ...(p.leaseReceiptVersion==="signed-lease-v1" && operation!=="remove" ? {leaseExpiresAt:signed.leaseExpiresAt}: {}) }
          : {
              ...(signed.providerId ? { providerId: signed.providerId } : {}),
            }),
      };
      const ref = await binding.blobs.putPrivate(owner, {
        channel: b.id,
        generation: b.generation,
        operation,
        policy: stamp(p),
        receipt: signed,
        signature: envelope.signature,
        result,
      });
      await kv.update(receiptKey(evidence), (prior) => prior ?? { ref });
      return result;
    },
  };
  const bridge: ChannelBridgeBindings = {
    authorize: async (account, operation, spec) => {
      if (account !== owner || !options.currentOwner()) return false;
      const b = channelBindings(await journal.read(), owner).get(
          spec.external.channel,
        ),
        p = b && selected(b);
      return (
        !!p &&
        b!.generation === spec.external.generation &&
        spec.authorityRef === p.authorityRef &&
        !!p.sendAuthorityRef &&
        spec.sendAuthorityRef === p.sendAuthorityRef &&
        spec.expiresAt <= p.expiresAt &&
        (operation === "revoke" || spec.expiresAt > Date.now())
      );
    },
  };
  return {
    adapters,
    bridge,
    readiness: () => ({
      providerAdapters:
        options.currentOwner() &&
        options
          .policies(owner)
          .some(
            (p) =>
              p.owner === owner &&
              supported(p) &&
              !!p.sendAuthorityRef &&
              !!p.endpoints.send &&
              !!p.destination,
          ),
      protocol: "signed-json-v1",
      providerAdapterReason: options.currentOwner()
        ? "requires_current_pinned_planner_and_separate_receive_send_grants"
        : "owner_authority_unavailable",
    }),
    lookup: async (
      route: string,
      token: string,
    ): Promise<ChannelSourceGrant | undefined> => {
      if (providerAdapterRouteOwner(route) !== owner) return;
      const rows = await journal.read(),
        b = [...channelBindings(rows, owner).values()].find(
          (b) => routeOf(owner, b.id) === route,
        ),
        p = b && selected(b);
      if (
        !b ||
        !p ||
        !equal(token, mac(p.receiveKey, JSON.stringify([route, b.generation])))
      )
        return;
      const armed = rows.find(
        (e) =>
          e.type === "AikoChannelIngressArmed" &&
          e.owner === owner &&
          e.channel === b.id &&
          e.generation === b.generation,
      );
      if (!armed) return;
      return {
        owner,
        channel: b.id,
        generation: b.generation,
        bridge: String(armed.bridge),
        capabilityRef: `provider-receive:${b.id}:${b.generation}`,
        scope: "receive",
        expiresAt: p.expiresAt,
        verify: authenticate,
      };
    },
    tools: (hosted: () => HostedChannels): NativeTool<Self>[] => [
      {
        spec: {
          name: "provider_adapter_control",
          description:
            "Owner-scoped native lifecycle for an existing generated provider: status, one bounded poll, pause, resume, retire, renew, or reconcile. Supply channel, generation, operation, operationId; renewal reconciliation additionally requires originalRenewalId. Finite schedule/cancel-schedule uses existing native alarms; plan requires action, maxRuns, intervalMs, backoffMs, expiresAt, firstAt and leaseLeadMs. Unknown mutations never retry. Automatic renewal requires signed-lease-v1 receipts. Upgrade through provider_adapter_bind with the next generation after retirement.",
          inputSchema: {
            type: "object",
            properties: {
              channel: { type: "string" },
              generation: { type: "integer", minimum: 1 },
              operation: {
                enum: [
                  "status",
                  "schedule",
                  "cancel-schedule",
                  "poll",
                  "pause",
                  "resume",
                  "retire",
                  "renew",
                  "reconcile",
                ],
              },
              operationId: { type: "string" },
              originalRenewalId: { type: "string" },
              plan:{type:"object"},
              planId:{type:"string"},
            },
            required: ["channel", "generation", "operation", "operationId"],
            additionalProperties: false,
          },
        },
        run: (raw) =>
          Effect.gen(function* () {
            const self = yield* Self,
              a = raw as any;
            if (
              self.actor !== "aiko" ||
              self.thread !== binding.thread ||
              !options.currentOwner() ||
              typeof a.operationId !== "string" ||
              !/^[A-Za-z0-9._:-]{1,160}$/.test(a.operationId)
            )
              throw Error("provider_owner_scope");
            const b = channelBindings(
                yield* Effect.promise(journal.read),
                owner,
              ).get(a.channel),
              p = b && selected(b);
            if (!b || !p || b.generation !== a.generation)
              throw Error("provider_binding_unavailable");
            const channels = hosted();
            if (a.operation === "status")
              return {
                channel: b.id,
                generation: b.generation,
                status: b.status,
                controls:channelControlState(yield* Effect.promise(journal.read),owner).filter(s=>s.plan.channel===b.id && s.plan.generation===b.generation).map(s=>({id:s.p.id,action:s.p.action,used:s.used,reason:s.reason??"scheduled",due:s.due??null,expiresAt:s.p.expiresAt})),
              };
            if (a.operation === "schedule") {
              yield* Effect.promise(()=>channels.run(channels.runtime.scheduleControl(b.id,b.generation,{...a.plan,id:a.operationId,partition:"provider"})));
            } else if(a.operation === "cancel-schedule") {
              yield* Effect.promise(()=>channels.run(channels.runtime.cancelControl(b.id,b.generation,a.planId)));
            } else if (a.operation === "poll")
              yield* Effect.promise(() =>
                channels.run(
                  channels.runtime.requestPoll(
                    b.id,
                    b.generation,
                    "provider",
                    a.operationId,
                  ),
                ),
              );
            else if (["pause", "resume", "retire"].includes(a.operation))
              yield* Effect.promise(() =>
                channels.run(
                  channels.runtime.change(
                    b.id,
                    b.generation,
                    a.operation === "pause"
                      ? "paused"
                      : a.operation === "resume"
                        ? "active"
                        : "retiring",
                    p.authorityRef,
                    a.operationId,
                  ),
                ),
              );
            else if (["renew", "reconcile"].includes(a.operation))
              yield* Effect.promise(() =>
                channels.run(
                  channels.runtime.requestSubscription(
                    b.id,
                    b.generation,
                    a.operation,
                    a.operationId,
                    p.authorityRef,
                    a.originalRenewalId,
                  ),
                ),
              );
            else throw Error("provider_operation_unavailable");
            return {
              status: "recorded",
              channel: b.id,
              generation: b.generation,
              operation: a.operation,
            };
          }),
      },
      {
        spec: {
          name: "provider_adapter_catalog",
          description:
            "Discover standing provider policies and fixed adapter contracts without exposing credentials. Only the listed operation surface is supported; acquiring a planner does not provision a subscription.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        run: () =>
          Effect.gen(function* () {
            const self = yield* Self;
            if (
              self.actor !== "aiko" ||
              self.thread !== binding.thread ||
              !options.currentOwner()
            )
              throw Error("provider_owner_scope");
            return {
              protocol: "signed-json-v1",
              policies: options
                .policies(owner)
                .filter((p) => p.owner === owner && supported(p))
                .map((p) => ({
                  id: p.id,
                automaticControls:p.automaticControls??null,
                signedLeaseRenewal:p.leaseReceiptVersion==="signed-lease-v1",
                  contractDigest: harnessDigest(p.definition.contract),
                  name: p.definition.artifact.name,
                  operations: ["decode", ...Object.keys(p.endpoints)],
                  sourceMode: p.endpoints.subscribe ? "webhook" : "poll",
                  pollPartition: p.endpoints.poll ? "provider" : null,
                  canSend: !!p.sendAuthorityRef && !!p.destination,
                  expiresAt: p.expiresAt,
                  maxBytes: p.maxBytes,
                  backlog: p.backlog,
                })),
            };
          }),
      },
      {
        spec: {
          name: "provider_adapter_acquire",
          description:
            "Acquire and independently evaluate generated code for a currently permitted fixed provider adapter contract. No subscription or send occurs during pure planner evaluation.",
          inputSchema: {
            type: "object",
            properties: {
              policy: { type: "string" },
              operationId: { type: "string" },
              candidate: { type: "object" },
            },
            required: ["policy", "operationId"],
            additionalProperties: false,
          },
        },
        run: (raw) =>
          Effect.gen(function* () {
            const self = yield* Self,
              input = raw as any,
              p = policy(input.policy);
            if (
              self.actor !== "aiko" ||
              self.thread !== binding.thread ||
              !options.currentOwner() ||
              !p
            )
              throw Error("provider_policy_unavailable");
            return yield* Effect.promise(() =>
              new HarnessAcquisition(binding, journal, [p.definition]).acquire(
                {
                  name: p.definition.artifact.name,
                  operationId: input.operationId,
                  ...(input.candidate ? { candidate: input.candidate } : {}),
                },
                AbortSignal.timeout(30000),
              ),
            );
          }),
      },
      {
        spec: {
          name: "provider_adapter_bind",
          description:
            "Instantiate a verified adapter under an existing signed-JSON provider policy. Supply existing typed ports/hook. Privately arms ingress before native subscription; returns pending, never fabricated activation.",
          inputSchema: {
            type: "object",
            properties: {
              policy: { type: "string" },
              name: { type: "string" },
              digest: { type: "string" },
              generation: { type: "integer", minimum: 1 },
              bridge: { type: "object" },
            },
            required: ["policy", "name", "digest", "generation", "bridge"],
            additionalProperties: false,
          },
        },
        run: (raw) =>
          Effect.gen(function* () {
            const self = yield* Self;
            if (self.actor !== "aiko" || self.thread !== binding.thread)
              throw Error("provider_owner_scope");
            const input = raw as any,
              p = policy(input.policy);
            if (
              !p ||
              !options.currentOwner() ||
              !p.sendAuthorityRef ||
              !p.endpoints.send
            )
              throw Error("provider_policy_unavailable");
            const hostedChannels = hosted();
            if (!hostedChannels.bridge)
              throw Error("provider_bridge_unavailable");
            if (
              !input.bridge ||
              Object.keys(input.bridge).sort().join() !==
                "decodeSchema,expiresAt,input,operationId,output,wiring"
            )
              throw Error("provider_bridge_shape");
            for (const key of ["input", "output"])
              if (
                !input.bridge[key] ||
                Object.keys(input.bridge[key]).sort().join() !==
                  "channel,generation" ||
                !/^[a-f0-9]{64}$/.test(input.bridge[key].channel)
              )
                throw Error("provider_bridge_shape");
            if (
              !input.bridge.wiring ||
              Object.keys(input.bridge.wiring).sort().join() !==
                "generation,id" ||
              !/^[a-f0-9]{64}$/.test(input.bridge.wiring.id)
            )
              throw Error("provider_bridge_shape");
            binding.guard(input.bridge);
            const spec: ChannelBridgeSpec = {
              ...input.bridge,
              external: {
                channel: channelId(owner, input.name),
                generation: input.generation,
              },
              authorityRef: p.authorityRef,
              sendAuthorityRef: p.sendAuthorityRef,
              expiresAt: Math.min(input.bridge.expiresAt, p.expiresAt),
            };
            const id = yield* Effect.promise(() =>
              hostedChannels.run(
                hostedChannels.runtime.configure({
                  name: input.name,
                  generation: input.generation,
                  artifact: {
                    digest: input.digest,
                    contractDigest: harnessDigest(p.definition.contract),
                    directions: ["inbox", "outbox"],
                    operations: [
                      "decode",
                      ...Object.keys(p.endpoints),
                    ] as ChannelAdapterOperation[],
                  },
                  account: p.id,
                  source: p.source,
                  destination: p.destination,
                  route: binding.thread,
                  credentialRefs: [],
                  authorization: p.authorityRef,
                  backlog: p.backlog,
                  maxBytes: p.maxBytes,
                  maxHops: 8,
                  retentionMs: p.retentionMs,
                  queuedWork: "cancel",
                  ingressBeforeSubscribe: true,
                  provisioningScope: { id: p.id, limit: p.maxInstances },
                  providerPolicyDigest: stamp(p),
                  providerBridge: spec,
                }),
              ),
            );
            const bound = yield* hostedChannels.bridge.api.bind(spec);
            yield* Effect.promise(() =>
              hostedChannels.run(
                hostedChannels.runtime.arm(
                  id,
                  input.generation,
                  bound.id,
                  p.authorityRef,
                ),
              ),
            );
            return {
              status: "pending",
              channel: id,
              generation: input.generation,
              bridge: bound.id,
            };
          }),
      },
    ],
  };
}
export type ProviderAdapterHost = ReturnType<typeof createProviderAdapterHost>;
