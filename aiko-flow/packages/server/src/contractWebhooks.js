import { createHash } from "node:crypto";
import { createContractWebhookLifecycle, WebhookLifecycleError } from "./contractWebhookLifecycle.js";

export class ContractWebhookError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "ContractWebhookError"; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new ContractWebhookError(code, message, status); };
const bytes = (value) => {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Buffer.isBuffer(value)) return Uint8Array.from(value);
  fail("RAW_BYTES_REQUIRED", "delivery requires the exact raw request bytes", 400);
};
const header = (headers, name) => {
  if (headers instanceof Headers) return headers.get(name);
  const found = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? (Array.isArray(found[1]) ? found[1][0] : found[1]) : undefined;
};
const digest = (raw) => createHash("sha256").update(raw).digest("hex");

/** Contract-owned public webhook surface. Verification is injected so provider kernels remain replaceable. */
export function createContractWebhookSurface({ contract, verifier, resolveCredential, allocateEndpointId, authorityFromContext = (x) => x } = {}) {
  if (!contract || typeof contract.intake !== "function") fail("INVALID_INTERFACE", "durable Contract intake is required", 500);
  if (!verifier || typeof verifier.verify !== "function") fail("INVALID_INTERFACE", "raw-byte verifier is required", 500);
  if (typeof resolveCredential !== "function") fail("INVALID_INTERFACE", "credential-handle resolver is required", 500);
  const lifecycle = createContractWebhookLifecycle({ contract, allocateEndpointId });
  const actor = (context) => authorityFromContext(context);

  async function deliver(context, endpointId, request) {
    const authority = actor(context);
    const endpoint = await lifecycle.inspect(authority, endpointId);
    if (endpoint.status !== "active") fail("FENCED", "webhook endpoint is not active", 410);
    const method = String(request.method ?? "").toUpperCase();
    if (!endpoint.methods.includes(method)) fail("METHOD", "webhook method is not admitted", 405);
    const contentType = String(header(request.headers, "content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== endpoint.contentType.toLowerCase()) fail("CONTENT_TYPE", "webhook content type is not admitted", 415);
    const raw = bytes(request.rawBody);
    if (raw.byteLength > endpoint.bodyLimitBytes) fail("BODY_LIMIT", "webhook body exceeds endpoint bound", 413);
    const expectedDigest = digest(raw);
    let credential = await resolveCredential(endpoint.credentialHandle);
    let verified;
    try {
      // No decoding or parsing is permitted before this awaited call.
      verified = await verifier.verify({ endpoint, method, headers: request.headers, rawBody: raw, credential });
    } finally {
      credential = undefined;
    }
    if (!verified || verified.verified !== true || verified.requestDigest !== expectedDigest ||
        verified.deliveryId == null || verified.verificationEvidence == null ||
        String(verified.verificationEvidence.endpointGeneration) !== String(endpoint.endpointGeneration) ||
        String(verified.verificationEvidence.credentialGeneration) !== String(endpoint.credentialHandle.generation)) {
      fail("VERIFICATION", "provider verification did not bind the exact request bytes and active generations", 401);
    }
    let body;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch { fail("PARSE", "verified webhook body is not valid JSON", 400); }
    // Contract receives the digest and parsed stimulus, never secret material or raw bytes.
    const receipt = await contract.intake({
      type: "webhook.delivery", tenantId: endpoint.tenantId, endpointId: endpoint.endpointId,
      endpointGeneration: endpoint.endpointGeneration, authenticatedSubject: authority.authenticatedSubject,
      provider: endpoint.provider, audience: endpoint.audience, route: endpoint.route, method,
      contentType: endpoint.contentType, deliveryId: String(verified.deliveryId), requestDigest: expectedDigest,
      verificationEvidence: verified.verificationEvidence, contractTemplate: endpoint.contractTemplate, body,
    });
    if (!receipt || receipt.durable !== true || !["accepted", "adopted"].includes(receipt.disposition)) {
      fail("DURABILITY", "Contract did not durably accept the webhook", 503);
    }
    return Object.freeze({ acknowledged: true, disposition: receipt.disposition, requestDigest: expectedDigest, occurrenceId: receipt.occurrenceId });
  }

  const management = Object.freeze({
    "contractWebhooks.create": (c,p) => lifecycle.create(actor(c), p),
    "contractWebhooks.list": (c) => lifecycle.list(actor(c)),
    "contractWebhooks.inspect": (c,p) => lifecycle.inspect(actor(c), p.endpointId),
    "contractWebhooks.rotate": (c,p) => lifecycle.rotate(actor(c), p.endpointId, { expectedGeneration: p.expectedGeneration, credentialHandle: p.credentialHandle }),
    "contractWebhooks.pause": (c,p) => lifecycle.pause(actor(c), p.endpointId, { expectedGeneration: p.expectedGeneration }),
    "contractWebhooks.revoke": (c,p) => lifecycle.revoke(actor(c), p.endpointId, { expectedGeneration: p.expectedGeneration }),
  });
  return Object.freeze({
    lifecycle, deliver,
    methods: Object.freeze(Object.keys(management)),
    async rpc(method, context, params = {}) {
      const call = management[method];
      if (!call) fail("METHOD_NOT_FOUND", `unknown Contract webhook method: ${method}`, 404);
      try { return await call(context, params); }
      catch (error) { if (error instanceof WebhookLifecycleError) throw new ContractWebhookError(error.code, error.message, 409); throw error; }
    },
  });
}
