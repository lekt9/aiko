import { assertManifestPin, sha256Hex, type PinnedEndpointManifest } from "./manifest";

export type WorkerSecretBindings = Readonly<{
  /** Resolve a Cloudflare secret binding to a non-extractable signing key. */
  getHmacKey(binding: string): Promise<CryptoKey> | CryptoKey;
}>;

export type ReplayClaim = "accepted" | "replay" | "conflict";
export interface ReplayStore {
  /** Must atomically insert or compare fingerprint for this tuple. */
  claim(tuple: string, fingerprint: string): Promise<ReplayClaim> | ReplayClaim;
}
export interface RateLimiter {
  /** Must atomically enforce the supplied manifest-owned bound. */
  consume(key: string, limit: number, windowSeconds: number, nowSeconds: number): Promise<boolean> | boolean;
}

export type VerifiedIngressProjection = Readonly<{
  version: "aiko.verified-ingress.v1";
  authenticatedSubject: string;
  verifiedTenant: string;
  transport: "cloudflare.webhook";
  audience: string;
  grantedScopes: readonly string[];
  canonicalRequestDigest: string;
  nonceNamespace: string;
  idempotencyKey: string;
  verificationEvidence: Readonly<{
    verifier: "hmac-sha256.timestamp-delivery-raw-body.v1";
    signatureResult: "verified";
    credentialGeneration: string;
    endpointGeneration: string;
    manifestDigest: string;
  }>;
}>;

export type VerifiedWebhook = Readonly<{
  disposition: "accepted" | "replay";
  destination: Readonly<{ queue: string }>;
  ingress: VerifiedIngressProjection;
}>;

export class WebhookRefusal extends Error {
  constructor(public readonly code: "manifest" | "body_bound" | "delivery" | "timestamp" | "signature" | "rate" | "replay_conflict", message: string) {
    super(message);
    this.name = "WebhookRefusal";
  }
}

type HeaderBag = Headers | Readonly<Record<string, string | undefined>>;
function header(headers: HeaderBag, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value ?? null;
  return null;
}
function asciiBytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.byteLength; } return result;
}
function parseHexSignature(value: string | null): Uint8Array | null {
  if (!value || !value.startsWith("sha256=")) return null;
  const hex = value.slice(7);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}

/** Provider signing preimage. rawBody is appended byte-for-byte and is never decoded or parsed. */
export function providerSigningBytes(timestamp: string, deliveryId: string, rawBody: Uint8Array): Uint8Array {
  return concatenate(asciiBytes(`${timestamp}.${deliveryId}.`), rawBody);
}

export async function importHmacSecretForTestOnly(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", Uint8Array.from(secret).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function verifyWebhookDelivery(input: Readonly<{
  endpoint: PinnedEndpointManifest;
  headers: HeaderBag;
  rawBody: Uint8Array;
  nowSeconds: number;
  secrets: WorkerSecretBindings;
  replay: ReplayStore;
  rate: RateLimiter;
}>): Promise<VerifiedWebhook> {
  try { await assertManifestPin(input.endpoint); } catch (error) { throw new WebhookRefusal("manifest", error instanceof Error ? error.message : "invalid manifest"); }
  const { manifest, digest: manifestDigest } = input.endpoint;
  if (!(input.rawBody instanceof Uint8Array) || input.rawBody.byteLength > manifest.bounds.maxBodyBytes) throw new WebhookRefusal("body_bound", "raw webhook body exceeds endpoint bound");
  if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 0) throw new WebhookRefusal("timestamp", "invalid verifier clock");

  const deliveryId = header(input.headers, manifest.provider.deliveryIdHeader);
  if (!deliveryId || asciiBytes(deliveryId).byteLength > manifest.bounds.maxDeliveryIdBytes || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(deliveryId)) throw new WebhookRefusal("delivery", "missing or invalid provider delivery id");
  const timestampText = header(input.headers, manifest.provider.timestampHeader);
  if (!timestampText || !/^(0|[1-9][0-9]{0,15})$/.test(timestampText)) throw new WebhookRefusal("timestamp", "missing or invalid provider timestamp");
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || timestamp < input.nowSeconds - manifest.bounds.maxAgeSeconds || timestamp > input.nowSeconds + manifest.bounds.maxFutureSkewSeconds) throw new WebhookRefusal("timestamp", "provider timestamp is outside endpoint window");
  const signature = parseHexSignature(header(input.headers, manifest.provider.signatureHeader));
  if (!signature) throw new WebhookRefusal("signature", "missing or malformed provider signature");

  let verified = false;
  try {
    const key = await input.secrets.getHmacKey(manifest.credential.binding);
    verified = await crypto.subtle.verify("HMAC", key, Uint8Array.from(signature).buffer, Uint8Array.from(providerSigningBytes(timestampText, deliveryId, input.rawBody)).buffer);
  } catch { throw new WebhookRefusal("signature", "provider signature verification failed"); }
  if (!verified) throw new WebhookRefusal("signature", "provider signature verification failed");

  const requestDigest = await sha256Hex(input.rawBody);
  const rateKey = `${manifestDigest}:${manifest.authority.verifiedTenant}:${manifest.authority.authenticatedSubject}`;
  if (!(await input.rate.consume(rateKey, manifest.bounds.rate.requests, manifest.bounds.rate.windowSeconds, input.nowSeconds))) throw new WebhookRefusal("rate", "endpoint rate bound exceeded");

  const tuple = `${manifest.endpointId}:${manifest.provider.nonceNamespace}:${deliveryId}`;
  const fingerprint = await sha256Hex(asciiBytes([
    manifestDigest, manifest.endpointGeneration, manifest.provider.nonceNamespace, deliveryId, requestDigest,
    manifest.authority.verifiedTenant, manifest.authority.authenticatedSubject, manifest.authority.audience,
    manifest.authority.grantedScopes.join(","), manifest.credential.generation,
  ].join("\0")));
  const claim = await input.replay.claim(tuple, fingerprint);
  if (claim === "conflict") throw new WebhookRefusal("replay_conflict", "delivery tuple was previously used with different bytes or authority");
  if (claim !== "accepted" && claim !== "replay") throw new WebhookRefusal("replay_conflict", "invalid replay-store decision");

  return Object.freeze({
    disposition: claim,
    destination: manifest.destination,
    ingress: Object.freeze({
      version: "aiko.verified-ingress.v1", authenticatedSubject: manifest.authority.authenticatedSubject,
      verifiedTenant: manifest.authority.verifiedTenant, transport: "cloudflare.webhook", audience: manifest.authority.audience,
      grantedScopes: manifest.authority.grantedScopes, canonicalRequestDigest: requestDigest,
      nonceNamespace: manifest.provider.nonceNamespace, idempotencyKey: deliveryId,
      verificationEvidence: Object.freeze({ verifier: manifest.provider.verifier, signatureResult: "verified", credentialGeneration: manifest.credential.generation, endpointGeneration: manifest.endpointGeneration, manifestDigest }),
    }),
  });
}

/** Hermetic helpers only; production adapters must provide atomic Durable Object implementations. */
export class MemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, string>();
  claim(tuple: string, fingerprint: string): ReplayClaim { const found = this.entries.get(tuple); if (found === undefined) { this.entries.set(tuple, fingerprint); return "accepted"; } return found === fingerprint ? "replay" : "conflict"; }
}
export class MemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, { start: number; count: number }>();
  consume(key: string, limit: number, windowSeconds: number, now: number): boolean { const found = this.entries.get(key); if (!found || now >= found.start + windowSeconds) { this.entries.set(key, { start: now, count: 1 }); return true; } if (found.count >= limit) return false; found.count += 1; return true; }
}
