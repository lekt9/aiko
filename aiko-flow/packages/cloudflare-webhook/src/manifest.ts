export const ENDPOINT_MANIFEST_VERSION = "aiko.cloudflare-webhook.endpoint.v1" as const;

export type EndpointManifest = Readonly<{
  version: typeof ENDPOINT_MANIFEST_VERSION;
  endpointId: string;
  endpointGeneration: string;
  provider: Readonly<{
    id: string;
    nonceNamespace: string;
    signatureHeader: string;
    timestampHeader: string;
    deliveryIdHeader: string;
    signaturePrefix: "sha256=";
    verifier: "hmac-sha256.timestamp-delivery-raw-body.v1";
  }>;
  authority: Readonly<{
    verifiedTenant: string;
    authenticatedSubject: string;
    audience: string;
    grantedScopes: readonly string[];
  }>;
  credential: Readonly<{ binding: string; generation: string }>;
  destination: Readonly<{ queue: string }>;
  bounds: Readonly<{
    maxBodyBytes: number;
    maxDeliveryIdBytes: number;
    maxAgeSeconds: number;
    maxFutureSkewSeconds: number;
    rate: Readonly<{ requests: number; windowSeconds: number }>;
  }>;
}>;

export type PinnedEndpointManifest = Readonly<{ manifest: EndpointManifest; digest: string }>;

const TOP_LEVEL = new Set(["version", "endpointId", "endpointGeneration", "provider", "authority", "credential", "destination", "bounds"]);
const NON_SECRET_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, pattern = NON_SECRET_ID): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} is out of bounds`);
  return value as number;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${name}.${key} is not allowed`);
  for (const key of allowed) if (!(key in value)) throw new Error(`${name}.${key} is required`);
}

/** Canonical JSON is used only for manifest identity; transport bodies are never canonicalized. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate, normalize and digest a closed manifest. Unknown fields (including plaintext secrets) fail closed. */
export async function sealEndpointManifest(input: unknown): Promise<PinnedEndpointManifest> {
  const root = record(input, "manifest");
  exactKeys(root, [...TOP_LEVEL], "manifest");
  if (root.version !== ENDPOINT_MANIFEST_VERSION) throw new Error("unsupported endpoint manifest version");
  const provider = record(root.provider, "provider");
  exactKeys(provider, ["id", "nonceNamespace", "signatureHeader", "timestampHeader", "deliveryIdHeader", "signaturePrefix", "verifier"], "provider");
  const authority = record(root.authority, "authority");
  exactKeys(authority, ["verifiedTenant", "authenticatedSubject", "audience", "grantedScopes"], "authority");
  const credential = record(root.credential, "credential");
  exactKeys(credential, ["binding", "generation"], "credential");
  const destination = record(root.destination, "destination");
  exactKeys(destination, ["queue"], "destination");
  const bounds = record(root.bounds, "bounds");
  exactKeys(bounds, ["maxBodyBytes", "maxDeliveryIdBytes", "maxAgeSeconds", "maxFutureSkewSeconds", "rate"], "bounds");
  const rate = record(bounds.rate, "rate");
  exactKeys(rate, ["requests", "windowSeconds"], "rate");
  if (!Array.isArray(authority.grantedScopes) || authority.grantedScopes.length < 1 || authority.grantedScopes.length > 32) throw new Error("grantedScopes is out of bounds");
  const scopes = authority.grantedScopes.map((scope) => text(scope, "scope"));
  if (new Set(scopes).size !== scopes.length) throw new Error("grantedScopes contains duplicates");
  const normalized: EndpointManifest = {
    version: ENDPOINT_MANIFEST_VERSION,
    endpointId: text(root.endpointId, "endpointId"), endpointGeneration: text(root.endpointGeneration, "endpointGeneration"),
    provider: {
      id: text(provider.id, "provider.id"), nonceNamespace: text(provider.nonceNamespace, "provider.nonceNamespace"),
      signatureHeader: text(provider.signatureHeader, "provider.signatureHeader", HEADER), timestampHeader: text(provider.timestampHeader, "provider.timestampHeader", HEADER),
      deliveryIdHeader: text(provider.deliveryIdHeader, "provider.deliveryIdHeader", HEADER),
      signaturePrefix: provider.signaturePrefix === "sha256=" ? "sha256=" : (() => { throw new Error("unsupported signature prefix"); })(),
      verifier: provider.verifier === "hmac-sha256.timestamp-delivery-raw-body.v1" ? provider.verifier : (() => { throw new Error("unsupported verifier"); })(),
    },
    authority: { verifiedTenant: text(authority.verifiedTenant, "verifiedTenant"), authenticatedSubject: text(authority.authenticatedSubject, "authenticatedSubject"), audience: text(authority.audience, "audience"), grantedScopes: Object.freeze([...scopes].sort()) },
    credential: { binding: text(credential.binding, "credential.binding", /^[A-Z][A-Z0-9_]{0,127}$/), generation: text(credential.generation, "credential.generation") },
    destination: { queue: text(destination.queue, "destination.queue") },
    bounds: { maxBodyBytes: integer(bounds.maxBodyBytes, "maxBodyBytes", 1, 1_048_576), maxDeliveryIdBytes: integer(bounds.maxDeliveryIdBytes, "maxDeliveryIdBytes", 1, 256), maxAgeSeconds: integer(bounds.maxAgeSeconds, "maxAgeSeconds", 1, 86_400), maxFutureSkewSeconds: integer(bounds.maxFutureSkewSeconds, "maxFutureSkewSeconds", 0, 300), rate: { requests: integer(rate.requests, "rate.requests", 1, 10_000), windowSeconds: integer(rate.windowSeconds, "rate.windowSeconds", 1, 3_600) } },
  };
  const digest = await sha256Hex(new TextEncoder().encode(canonicalJson(normalized)));
  return Object.freeze({ manifest: Object.freeze(normalized), digest });
}

export async function assertManifestPin(pin: PinnedEndpointManifest): Promise<void> {
  const actual = await sha256Hex(new TextEncoder().encode(canonicalJson(pin.manifest)));
  if (actual !== pin.digest) throw new Error("endpoint manifest digest mismatch");
}
