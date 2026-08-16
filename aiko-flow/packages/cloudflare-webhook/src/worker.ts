import { assertManifestPin, canonicalJson, sha256Hex, type PinnedEndpointManifest } from "./manifest";
import { enqueueVerifiedDelivery, consumeQueuedDelivery, type ContractClient, type DeliveryPolicy, type DigestDeadLetterQueue, type DurableQueueClient, type QueuedContractDelivery } from "./queue";
import { verifyWebhookDelivery, WebhookRefusal, type RateLimiter, type ReplayStore, type WorkerSecretBindings } from "./verifiers";

export const CONTRACT_GATEWAY_AUDIENCE = "aiko.contract.ingress" as const;
export const VERIFIED_INGRESS_QUEUE = "verified-contract-ingress" as const;
const ENDPOINT_PATH = /^\/contract-webhooks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const DIGEST = /^[0-9a-f]{64}$/;

type Fetcher = { fetch(request: Request): Promise<Response> };
type QueueBinding<T> = { send(body: T): Promise<void> };
type SecretStore = { get(name: string): Promise<string | null> };
type Message<T> = { body: T; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void };
type MessageBatch<T> = { messages: readonly Message<T>[] };

export type CloudflareWebhookEnv = Readonly<{
  ENDPOINT_MANIFESTS: Fetcher;
  WEBHOOK_COORDINATOR: Fetcher;
  WEBHOOK_SECRETS: SecretStore;
  VERIFIED_INGRESS_QUEUE: QueueBinding<QueuedContractDelivery>;
  WEBHOOK_DLQ: QueueBinding<unknown>;
  AIKO_GATEWAY: Fetcher;
}>;

export type WorkerAdapterOptions = Readonly<{
  fixedAudience: typeof CONTRACT_GATEWAY_AUDIENCE;
  queueName: typeof VERIFIED_INGRESS_QUEUE;
  delivery: Omit<DeliveryPolicy, "fixedAudience">;
  nowSeconds?: () => number;
}>;

const productionOptions: WorkerAdapterOptions = Object.freeze({
  fixedAudience: CONTRACT_GATEWAY_AUDIENCE,
  queueName: VERIFIED_INGRESS_QUEUE,
  delivery: Object.freeze({ maxAttempts: 8, baseDelayMs: 1_000, maxDelayMs: 300_000 }),
});

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
async function bindingJson(binding: Fetcher, path: string, init?: RequestInit): Promise<unknown> {
  const response = await binding.fetch(new Request(`https://binding.invalid${path}`, init));
  if (!response.ok) throw new Error(`binding refused with ${response.status}`);
  return response.json();
}
async function endpointFor(env: CloudflareWebhookEnv, endpointId: string): Promise<PinnedEndpointManifest> {
  const value = await bindingJson(env.ENDPOINT_MANIFESTS, `/v1/endpoints/${encodeURIComponent(endpointId)}`) as PinnedEndpointManifest;
  await assertManifestPin(value);
  if (value.manifest.endpointId !== endpointId) throw new Error("endpoint registry identity mismatch");
  return value;
}

/** Only the dedicated Cloudflare Secret Store binding is consulted. No env[name], KV, vars, or source secrets. */
function secretBindings(env: CloudflareWebhookEnv): WorkerSecretBindings {
  return Object.freeze({
    async getHmacKey(binding: string): Promise<CryptoKey> {
      const secret = await env.WEBHOOK_SECRETS.get(binding);
      if (typeof secret !== "string" || secret.length < 16) throw new Error("secret binding is unavailable");
      return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    },
  });
}
function coordinator(env: CloudflareWebhookEnv): { replay: ReplayStore; rate: RateLimiter } {
  return {
    replay: { async claim(tuple, fingerprint) { return bindingJson(env.WEBHOOK_COORDINATOR, "/v1/replay/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tuple, fingerprint }) }) as Promise<"accepted" | "replay" | "conflict">; } },
    rate: { async consume(key, limit, windowSeconds, nowSeconds) { const result = await bindingJson(env.WEBHOOK_COORDINATOR, "/v1/rate/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, limit, windowSeconds, nowSeconds }) }) as { allowed?: unknown }; return result.allowed === true; } },
  };
}
function durableQueue(env: CloudflareWebhookEnv): DurableQueueClient {
  return { async enqueue(message) {
    await env.VERIFIED_INGRESS_QUEUE.send(message);
    return { durable: true, disposition: "enqueued", receiptDigest: await sha256Hex(new TextEncoder().encode(canonicalJson(message))) };
  } };
}

function gatewayContract(env: CloudflareWebhookEnv): ContractClient {
  return {
    async intake(delivery) {
      const response = await env.AIKO_GATEWAY.fetch(new Request("https://gateway.invalid/v1/contract/webhooks/intake", { method: "POST", headers: { "content-type": "application/json", "x-aiko-audience": CONTRACT_GATEWAY_AUDIENCE }, body: JSON.stringify(delivery) }));
      if (response.status >= 500 || response.status === 429) return { kind: "retryable" };
      if (!response.ok) return { kind: "permanent" };
      try { return await response.json() as Awaited<ReturnType<ContractClient["intake"]>>; } catch { return { kind: "uncertain" }; }
    },
    async readBack(replayIdentity) {
      if (!DIGEST.test(replayIdentity)) return { kind: "indeterminate" };
      const response = await env.AIKO_GATEWAY.fetch(new Request(`https://gateway.invalid/v1/contract/webhooks/read-back/${replayIdentity}`, { headers: { "x-aiko-audience": CONTRACT_GATEWAY_AUDIENCE } }));
      if (response.status === 404) return { kind: "absent" };
      if (!response.ok) return { kind: "indeterminate" };
      try { return await response.json() as Awaited<ReturnType<ContractClient["readBack"]>>; } catch { return { kind: "indeterminate" }; }
    },
  };
}

export function createCloudflareWebhookWorker(options: WorkerAdapterOptions = productionOptions) {
  if (options.fixedAudience !== CONTRACT_GATEWAY_AUDIENCE || options.queueName !== VERIFIED_INGRESS_QUEUE) throw new Error("Worker destination and Gateway audience are fixed");
  const policy: DeliveryPolicy = Object.freeze({ fixedAudience: CONTRACT_GATEWAY_AUDIENCE, ...options.delivery });
  return Object.freeze({
    async fetch(request: Request, env: CloudflareWebhookEnv): Promise<Response> {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      const match = ENDPOINT_PATH.exec(new URL(request.url).pathname);
      if (!match) return json(404, { error: "not_found" });
      try {
        const endpoint = await endpointFor(env, match[1]!);
        if (endpoint.manifest.authority.audience !== CONTRACT_GATEWAY_AUDIENCE || endpoint.manifest.destination.queue !== VERIFIED_INGRESS_QUEUE) throw new WebhookRefusal("manifest", "endpoint attempted to widen fixed destination");
        const declared = request.headers.get("content-length");
        if (declared !== null && (!/^(0|[1-9][0-9]{0,15})$/.test(declared) || Number(declared) > endpoint.manifest.bounds.maxBodyBytes)) throw new WebhookRefusal("body_bound", "raw webhook body exceeds endpoint bound");
        // arrayBuffer preserves transport bytes. No text(), json(), decoder, or parser occurs before verification.
        const rawBody = new Uint8Array(await request.arrayBuffer());
        const state = coordinator(env);
        const verified = await verifyWebhookDelivery({ endpoint, headers: request.headers, rawBody, nowSeconds: options.nowSeconds?.() ?? Math.floor(Date.now() / 1000), secrets: secretBindings(env), replay: state.replay, rate: state.rate });
        const receipt = await enqueueVerifiedDelivery({ ingress: verified.ingress, manifestDigest: endpoint.digest }, policy, durableQueue(env));
        return json(receipt.status, { accepted: true, disposition: receipt.disposition, replayIdentity: receipt.replayIdentity, queueReceiptDigest: receipt.queueReceiptDigest });
      } catch (error) {
        if (error instanceof WebhookRefusal) {
          const status = error.code === "body_bound" ? 413 : error.code === "rate" ? 429 : error.code === "replay_conflict" ? 409 : error.code === "manifest" ? 503 : 401;
          return json(status, { error: error.code });
        }
        return json(503, { error: "edge_unavailable" });
      }
    },
    async queue(batch: MessageBatch<unknown>, env: CloudflareWebhookEnv): Promise<void> {
      const contract = gatewayContract(env);
      const dlq: DigestDeadLetterQueue = { async put(record) { await env.WEBHOOK_DLQ.send(record); return { durable: true, receiptDigest: await sha256Hex(new TextEncoder().encode(canonicalJson(record))) }; } };
      for (const cloudflareMessage of batch.messages) {
        await consumeQueuedDelivery({ message: cloudflareMessage.body, attempt: cloudflareMessage.attempts }, policy, contract, dlq, {
          ack: () => cloudflareMessage.ack(),
          retry: (delayMs) => cloudflareMessage.retry({ delaySeconds: Math.max(1, Math.ceil(delayMs / 1000)) }),
          park: () => cloudflareMessage.retry({ delaySeconds: Math.ceil(policy.maxDelayMs / 1000) }),
          quarantine: () => cloudflareMessage.ack(),
        });
      }
    },
  });
}

const worker = createCloudflareWebhookWorker();
export default worker;
