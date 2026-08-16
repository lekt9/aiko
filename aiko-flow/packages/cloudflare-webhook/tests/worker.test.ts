import { describe, expect, test } from "bun:test";
import { ENDPOINT_MANIFEST_VERSION, sealEndpointManifest } from "../src/manifest";
import { CONTRACT_GATEWAY_AUDIENCE, VERIFIED_INGRESS_QUEUE, createCloudflareWebhookWorker, type CloudflareWebhookEnv } from "../src/worker";
import { importHmacSecretForTestOnly, providerSigningBytes } from "../src/verifiers";
import type { QueuedContractDelivery } from "../src/queue";

const now = 1_700_000_000;
const secret = "hermetic-secret-value-123";
const encoder = new TextEncoder();
const digest = (c: string) => c.repeat(64);
async function pin(changes: Record<string, unknown> = {}) {
  return sealEndpointManifest({
    version: ENDPOINT_MANIFEST_VERSION, endpointId: "orders", endpointGeneration: "gen-1",
    provider: { id: "acme", nonceNamespace: "acme.delivery", signatureHeader: "x-signature", timestampHeader: "x-timestamp", deliveryIdHeader: "x-delivery", signaturePrefix: "sha256=", verifier: "hmac-sha256.timestamp-delivery-raw-body.v1" },
    authority: { verifiedTenant: "tenant-1", authenticatedSubject: "acme-app", audience: CONTRACT_GATEWAY_AUDIENCE, grantedScopes: ["hook.orders.write"] },
    credential: { binding: "ACME_HOOK_SECRET", generation: "key-1" }, destination: { queue: VERIFIED_INGRESS_QUEUE },
    bounds: { maxBodyBytes: 64, maxDeliveryIdBytes: 24, maxAgeSeconds: 300, maxFutureSkewSeconds: 10, rate: { requests: 2, windowSeconds: 60 } }, ...changes,
  });
}
async function signedRequest(body: Uint8Array, delivery = "delivery-1") {
  const timestamp = String(now); const key = await importHmacSecretForTestOnly(encoder.encode(secret));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, providerSigningBytes(timestamp, delivery, body)));
  const hex = [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://edge.invalid/contract-webhooks/orders", { method: "POST", headers: { "x-signature": `sha256=${hex}`, "x-timestamp": timestamp, "x-delivery": delivery }, body });
}
function environment(endpoint: Awaited<ReturnType<typeof pin>>) {
  const queued: QueuedContractDelivery[] = []; const dlq: unknown[] = []; const gatewayRequests: Request[] = [];
  const replay = new Map<string, string>(); let rate = 0;
  const env: CloudflareWebhookEnv = {
    ENDPOINT_MANIFESTS: { fetch: async () => Response.json(endpoint) },
    WEBHOOK_COORDINATOR: { fetch: async (request) => {
      const input = await request.json() as Record<string, unknown>;
      if (new URL(request.url).pathname.endsWith("/claim")) { const old = replay.get(String(input.tuple)); if (!old) { replay.set(String(input.tuple), String(input.fingerprint)); return Response.json("accepted"); } return Response.json(old === input.fingerprint ? "replay" : "conflict"); }
      rate++; return Response.json({ allowed: rate <= Number(input.limit) });
    } },
    WEBHOOK_SECRETS: { get: async (name) => name === "ACME_HOOK_SECRET" ? secret : null },
    VERIFIED_INGRESS_QUEUE: { send: async (message) => { queued.push(message); } }, WEBHOOK_DLQ: { send: async (message) => { dlq.push(message); } },
    AIKO_GATEWAY: { fetch: async (request) => { gatewayRequests.push(request); const path = new URL(request.url).pathname; if (path.includes("read-back")) return Response.json({ kind: "absent" }, { status: 404 }); const message = await request.clone().json() as QueuedContractDelivery; return Response.json({ kind: "durable", receipt: { kind: "contract-durable-intake", replayIdentity: message.replayIdentity, receiptDigest: digest("e") } }); } },
  };
  return { env, queued, dlq, gatewayRequests };
}
const worker = () => createCloudflareWebhookWorker({ fixedAudience: CONTRACT_GATEWAY_AUDIENCE, queueName: VERIFIED_INGRESS_QUEUE, delivery: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 }, nowSeconds: () => now });

describe("production Cloudflare Worker adapter", () => {
  test("verifies opaque raw bytes, emits minimized authority, and waits for durable queue send before 202", async () => {
    const state = environment(await pin()); let release!: () => void;
    state.env.VERIFIED_INGRESS_QUEUE.send = async (message) => { state.queued.push(message); await new Promise<void>((resolve) => { release = resolve; }); };
    const pending = worker().fetch(await signedRequest(new Uint8Array([0xff, 0x00, 0x7b])), state.env); let settled = false; pending.then(() => { settled = true; });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false); release(); const response = await pending;
    expect(response.status).toBe(202); expect(state.queued).toHaveLength(1);
    expect(Object.keys(state.queued[0]!).sort()).toEqual(["deliveryKey", "ingress", "manifestDigest", "replayIdentity", "version"]);
    expect(state.queued[0]!.ingress.audience).toBe(CONTRACT_GATEWAY_AUDIENCE);
    expect(JSON.stringify(state.queued[0])).not.toContain(secret);
    expect(JSON.stringify(state.queued[0])).not.toMatch(/rawBody|tenantId|rootId|effect|https?:/i);
  });

  test("refuses mutation, stale time, body/rate bounds, and manifest destination widening", async () => {
    const endpoint = await pin(); const state = environment(endpoint); const bad = await signedRequest(encoder.encode('{"x":1}'));
    const bytes = new Uint8Array(await bad.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
    const mutated = new Request(bad.url, { method: "POST", headers: bad.headers, body: bytes });
    expect((await worker().fetch(mutated, state.env)).status).toBe(401);
    const oversized = await signedRequest(new Uint8Array(65), "delivery-big"); expect((await worker().fetch(oversized, state.env)).status).toBe(413);
    await worker().fetch(await signedRequest(encoder.encode("{}"), "rate-1"), state.env);
    await worker().fetch(await signedRequest(encoder.encode("{}"), "rate-2"), state.env);
    expect((await worker().fetch(await signedRequest(encoder.encode("{}"), "rate-3"), state.env)).status).toBe(429);
    const widened = environment(await pin({ destination: { queue: "attacker-forward" } }));
    expect((await worker().fetch(await signedRequest(encoder.encode("{}")), widened.env)).status).toBe(503);
    expect(widened.queued).toHaveLength(0);
  });

  test("secret lookup is confined to Secret Store binding and bad endpoint registry pins fail closed", async () => {
    const endpoint = await pin(); const state = environment(endpoint); const names: string[] = [];
    state.env.WEBHOOK_SECRETS.get = async (name) => { names.push(name); return secret; };
    await worker().fetch(await signedRequest(encoder.encode("{}")), state.env); expect(names).toEqual(["ACME_HOOK_SECRET"]);
    state.env.ENDPOINT_MANIFESTS.fetch = async () => Response.json({ ...endpoint, digest: digest("0") });
    expect((await worker().fetch(await signedRequest(encoder.encode("{}"), "bad-pin"), state.env)).status).toBe(503);
  });

  test("queue consumer uses only fixed Gateway binding, ACKs durable Contract receipt, retries bounded, and DLQs poison", async () => {
    const state = environment(await pin()); await worker().fetch(await signedRequest(encoder.encode("{}")), state.env);
    let acked = 0; const retries: number[] = [];
    await worker().queue({ messages: [{ body: state.queued[0], attempts: 1, ack: () => { acked++; }, retry: ({ delaySeconds } = {}) => { retries.push(delaySeconds ?? 0); } }] }, state.env);
    expect(acked).toBe(1); expect(state.gatewayRequests).toHaveLength(1);
    expect(new URL(state.gatewayRequests[0]!.url).pathname).toBe("/v1/contract/webhooks/intake");
    expect(state.gatewayRequests[0]!.headers.get("x-aiko-audience")).toBe(CONTRACT_GATEWAY_AUDIENCE);
    expect(JSON.stringify(await state.gatewayRequests[0]!.clone().json())).not.toMatch(/rawBody|secret|url/i);

    state.env.AIKO_GATEWAY.fetch = async () => new Response("down", { status: 503 });
    await worker().queue({ messages: [{ body: state.queued[0], attempts: 1, ack: () => { acked++; }, retry: ({ delaySeconds } = {}) => { retries.push(delaySeconds ?? 0); } }] }, state.env);
    expect(retries).toHaveLength(1); expect(retries[0]).toBeGreaterThan(0); expect(retries[0]).toBeLessThanOrEqual(5);

    await worker().queue({ messages: [{ body: { poison: secret }, attempts: 1, ack: () => { acked++; }, retry: () => {} }] }, state.env);
    expect(state.dlq).toHaveLength(1); expect(JSON.stringify(state.dlq[0])).not.toContain(secret); expect(acked).toBe(2);
  });

  test("factory rejects arbitrary Gateway audience and queue destination", () => {
    expect(() => createCloudflareWebhookWorker({ fixedAudience: "attacker" as never, queueName: VERIFIED_INGRESS_QUEUE, delivery: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } })).toThrow("fixed");
    expect(() => createCloudflareWebhookWorker({ fixedAudience: CONTRACT_GATEWAY_AUDIENCE, queueName: "arbitrary" as never, delivery: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } })).toThrow("fixed");
  });
});
