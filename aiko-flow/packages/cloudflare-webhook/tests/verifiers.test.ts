import { describe, expect, test } from "bun:test";
import { ENDPOINT_MANIFEST_VERSION, sealEndpointManifest, sha256Hex } from "../src/manifest";
import { importHmacSecretForTestOnly, MemoryRateLimiter, MemoryReplayStore, providerSigningBytes, verifyWebhookDelivery, WebhookRefusal } from "../src/verifiers";

const encoder = new TextEncoder();
const now = 1_700_000_000;
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: ENDPOINT_MANIFEST_VERSION, endpointId: "orders-hook", endpointGeneration: "gen-7",
    provider: { id: "acme", nonceNamespace: "acme.delivery", signatureHeader: "x-acme-signature", timestampHeader: "x-acme-timestamp", deliveryIdHeader: "x-acme-delivery", signaturePrefix: "sha256=", verifier: "hmac-sha256.timestamp-delivery-raw-body.v1" },
    authority: { verifiedTenant: "tenant-42", authenticatedSubject: "acme-app-9", audience: "aiko.contract.ingress", grantedScopes: ["hook.orders.write"] },
    credential: { binding: "ACME_WEBHOOK_KEY", generation: "cred-3" }, destination: { queue: "verified-hook-orders" },
    bounds: { maxBodyBytes: 64, maxDeliveryIdBytes: 24, maxAgeSeconds: 300, maxFutureSkewSeconds: 10, rate: { requests: 10, windowSeconds: 60 } },
    ...overrides,
  };
}
async function fixture(body = encoder.encode('{"order":7}'), delivery = "delivery-1", timestamp = String(now)) {
  const endpoint = await sealEndpointManifest(manifest());
  const key = await importHmacSecretForTestOnly(encoder.encode("test-secret-that-never-enters-the-manifest"));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(providerSigningBytes(timestamp, delivery, body)).buffer));
  const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const headers = { "x-acme-signature": `sha256=${hex}`, "x-acme-timestamp": timestamp, "x-acme-delivery": delivery };
  return { endpoint, body, key, headers, replay: new MemoryReplayStore(), rate: new MemoryRateLimiter() };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, changes: Record<string, unknown> = {}) {
  return verifyWebhookDelivery({ endpoint: f.endpoint, headers: f.headers, rawBody: f.body, nowSeconds: now, secrets: { getHmacKey: (binding) => { expect(binding).toBe("ACME_WEBHOOK_KEY"); return f.key; } }, replay: f.replay, rate: f.rate, ...changes });
}
async function refusal(promise: Promise<unknown>, code: WebhookRefusal["code"]) {
  try { await promise; throw new Error("expected refusal"); } catch (error) { expect(error).toBeInstanceOf(WebhookRefusal); expect((error as WebhookRefusal).code).toBe(code); }
}

describe("Cloudflare webhook verifier kernel", () => {
  test("verifies original raw bytes without parsing and emits only closed authority", async () => {
    const f = await fixture(new Uint8Array([0xff, 0x00, 0x7b])); // deliberately not valid JSON/text
    const result = await run(f, { callerTenant: "attacker", destination: { queue: "arbitrary" }, scopes: ["cloudflare.deploy"] });
    expect(result.disposition).toBe("accepted");
    expect(result.destination).toEqual({ queue: "verified-hook-orders" });
    expect(Object.keys(result).sort()).toEqual(["destination", "disposition", "ingress"]);
    expect(result.ingress).toEqual({
      version: "aiko.verified-ingress.v1", authenticatedSubject: "acme-app-9", verifiedTenant: "tenant-42", transport: "cloudflare.webhook",
      audience: "aiko.contract.ingress", grantedScopes: ["hook.orders.write"], canonicalRequestDigest: await sha256Hex(f.body),
      nonceNamespace: "acme.delivery", idempotencyKey: "delivery-1",
      verificationEvidence: { verifier: "hmac-sha256.timestamp-delivery-raw-body.v1", signatureResult: "verified", credentialGeneration: "cred-3", endpointGeneration: "gen-7", manifestDigest: f.endpoint.digest },
    });
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(JSON.stringify(result)).not.toContain("attacker");
    expect(JSON.stringify(result)).not.toContain("arbitrary");
  });

  test("rejects bad signatures and signatures computed after body mutation", async () => {
    const f = await fixture();
    await refusal(run(f, { headers: { ...f.headers, "x-acme-signature": `sha256=${"00".repeat(32)}` } }), "signature");
    const changed = encoder.encode('{ "order": 7 }');
    await refusal(run(f, { rawBody: changed }), "signature");
  });

  test("rejects expired and future timestamps before admission", async () => {
    const expired = await fixture(undefined, undefined, String(now - 301));
    await refusal(run(expired), "timestamp");
    const future = await fixture(undefined, undefined, String(now + 11));
    await refusal(run(future), "timestamp");
  });

  test("classifies exact redelivery as replay and changed raw bytes as conflict", async () => {
    const f = await fixture();
    expect((await run(f)).disposition).toBe("accepted");
    expect((await run(f)).disposition).toBe("replay");
    const changedBody = encoder.encode('{"order":8}');
    const changed = await fixture(changedBody);
    changed.replay = f.replay;
    await refusal(run(changed), "replay_conflict");
  });

  test("endpoint and credential generations are fingerprinted, not caller-selectable", async () => {
    const f = await fixture(); await run(f);
    const nextPin = await sealEndpointManifest(manifest({ endpointGeneration: "gen-8" }));
    await refusal(run(f, { endpoint: nextPin }), "replay_conflict");
    const tampered = { manifest: { ...f.endpoint.manifest, endpointGeneration: "gen-attacker" }, digest: f.endpoint.digest } as typeof f.endpoint;
    await refusal(run(f, { endpoint: tampered }), "manifest");
  });

  test("refuses plaintext manifest secrets and arbitrary manifest fields", async () => {
    await expect(sealEndpointManifest({ ...manifest(), secret: "plaintext" })).rejects.toThrow("not allowed");
    await expect(sealEndpointManifest({ ...manifest(), authority: { ...(manifest().authority as object), role: "admin" } })).rejects.toThrow("not allowed");
    const pin = await sealEndpointManifest(manifest());
    expect(JSON.stringify(pin)).not.toContain("test-secret");
    expect(JSON.stringify(pin)).not.toContain("plaintext");
  });

  test("enforces body, delivery-id, and rate bounds", async () => {
    const f = await fixture();
    await refusal(run(f, { rawBody: new Uint8Array(65) }), "body_bound");
    await refusal(run(f, { headers: { ...f.headers, "x-acme-delivery": "x".repeat(25) } }), "delivery");
    const boundedPin = await sealEndpointManifest({ ...manifest(), bounds: { ...(manifest().bounds as object), rate: { requests: 1, windowSeconds: 60 } } });
    const bounded = await fixture(); bounded.endpoint = boundedPin;
    await run(bounded);
    const second = await fixture(undefined, "delivery-2"); second.endpoint = boundedPin; second.rate = bounded.rate; second.replay = bounded.replay;
    await refusal(run(second), "rate");
  });

  test("rejects unbounded manifest settings", async () => {
    await expect(sealEndpointManifest({ ...manifest(), bounds: { ...(manifest().bounds as object), maxBodyBytes: Number.MAX_SAFE_INTEGER } })).rejects.toThrow("out of bounds");
    await expect(sealEndpointManifest({ ...manifest(), bounds: { ...(manifest().bounds as object), rate: { requests: 0, windowSeconds: 60 } } })).rejects.toThrow("out of bounds");
  });
});
