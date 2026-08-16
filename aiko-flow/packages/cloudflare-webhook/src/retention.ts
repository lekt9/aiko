import { canonicalJson, sha256Hex } from "./manifest";

export const CLOUDFLARE_RETENTION_SCHEMA = "aiko.cloudflare-retention.v1" as const;

export type RetentionAuthority = "contract" | "neuron";
export type RetentionKind =
  | "endpoint_manifest" | "endpoint_generation" | "verifier_key_generation" | "verification_evidence"
  | "queue_delivery" | "retry_attempt" | "dlq_attempt" | "destination_audience" | "reconciliation"
  | "artifact" | "provider_version" | "environment_promotion" | "rollback_target" | "receipt";
export type RetentionState =
  | "active" | "replaced" | "revoked" | "settled" | "queued" | "retry_pending" | "dead_letter"
  | "resolved" | "uncertain_reconciliation" | "immutable" | "uploaded" | "deploying" | "superseded";

export type RetentionPin = Readonly<{
  kind: RetentionKind;
  authority: RetentionAuthority;
  reference: string;
  commitOrdinal: number;
  digest: string;
  state: RetentionState;
  parents?: readonly number[];
  environment?: "preview" | "staging" | "production";
}>;
export type RetentionEntry = RetentionPin & Readonly<{ retained: boolean }>;
export type CloudflareRetentionProjection = Readonly<{
  schema: typeof CLOUDFLARE_RETENTION_SCHEMA;
  entries: readonly RetentionEntry[];
  blocksCollection: boolean;
  projectionDigest: string;
}>;
export type RetentionConfirmation = Readonly<{
  confirmed: true;
  kind: RetentionKind;
  reference: string;
  commitOrdinal: number;
  digest: string;
  state: RetentionState;
}>;
export type RetentionReader = (pin: RetentionPin) => Promise<RetentionConfirmation | null> | RetentionConfirmation | null;
export type CompactedCloudflareRetention = Readonly<{
  schema: typeof CLOUDFLARE_RETENTION_SCHEMA;
  compacted: true;
  pins: readonly RetentionPin[];
  confirmationDigest: string;
  liveDeploymentClaim: false;
}>;

const DIGEST = /^[0-9a-f]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const FORBIDDEN_REFERENCE = /(?:^|[._:/-])(authorization|bearer|body|log|password|payload|raw|secret|token)(?:$|[._:/-])/i;
const KINDS: readonly RetentionKind[] = [
  "endpoint_manifest", "endpoint_generation", "verifier_key_generation", "verification_evidence",
  "queue_delivery", "retry_attempt", "dlq_attempt", "destination_audience", "reconciliation",
  "artifact", "provider_version", "environment_promotion", "rollback_target", "receipt",
];
const AUTHORITY: Readonly<Record<RetentionKind, RetentionAuthority>> = Object.freeze({
  endpoint_manifest: "neuron", endpoint_generation: "neuron", verifier_key_generation: "neuron", verification_evidence: "contract",
  queue_delivery: "contract", retry_attempt: "contract", dlq_attempt: "contract", destination_audience: "contract", reconciliation: "contract",
  artifact: "neuron", provider_version: "neuron", environment_promotion: "neuron", rollback_target: "neuron", receipt: "neuron",
});
const STATES: Readonly<Record<RetentionKind, readonly RetentionState[]>> = Object.freeze({
  endpoint_manifest: ["active", "replaced"], endpoint_generation: ["active", "replaced"], verifier_key_generation: ["active", "revoked"],
  verification_evidence: ["settled"], queue_delivery: ["queued", "settled"], retry_attempt: ["retry_pending", "settled"],
  dlq_attempt: ["dead_letter", "resolved"], destination_audience: ["active", "replaced"], reconciliation: ["uncertain_reconciliation", "settled"],
  artifact: ["immutable", "replaced"], provider_version: ["uploaded", "replaced"], environment_promotion: ["deploying", "superseded"],
  rollback_target: ["active", "settled"], receipt: ["settled"],
});
const LIVE = new Set<RetentionState>(["active", "queued", "retry_pending", "dead_letter", "uncertain_reconciliation", "immutable", "uploaded", "deploying"]);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function exactKeys(value: object, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${name}.${key} is not allowed`);
  for (const key of allowed) if (!(key in value)) throw new Error(`${name}.${key} is required`);
}
function normalizePin(value: unknown, index: number, length: number): RetentionPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`pin ${index} must be an object`);
  const pin = value as Record<string, unknown>;
  const allowed = ["kind", "authority", "reference", "commitOrdinal", "digest", "state", "parents", "environment"];
  const required = allowed.filter((key) => key !== "parents" && key !== "environment");
  for (const key of Object.keys(pin)) if (!allowed.includes(key)) throw new Error(`pin ${index}.${key} is not allowed`);
  for (const key of required) if (!(key in pin)) throw new Error(`pin ${index}.${key} is required`);
  if (!KINDS.includes(pin.kind as RetentionKind)) throw new Error(`pin ${index} kind is invalid`);
  const kind = pin.kind as RetentionKind;
  if (pin.authority !== AUTHORITY[kind]) throw new Error(`${kind} authority is invalid`);
  if (typeof pin.reference !== "string" || !REFERENCE.test(pin.reference) || FORBIDDEN_REFERENCE.test(pin.reference)) throw new Error(`${kind} reference may contain only a secret-free durable id`);
  if (!Number.isSafeInteger(pin.commitOrdinal) || (pin.commitOrdinal as number) < 1) throw new Error(`${kind} commit ordinal is invalid`);
  if (typeof pin.digest !== "string" || !DIGEST.test(pin.digest)) throw new Error(`${kind} digest is invalid`);
  if (!STATES[kind].includes(pin.state as RetentionState)) throw new Error(`${kind} state is invalid`);
  if (pin.parents !== undefined && (!Array.isArray(pin.parents) || pin.parents.length === 0 || new Set(pin.parents).size !== pin.parents.length || pin.parents.some((parent) => !Number.isSafeInteger(parent) || (parent as number) < 0 || (parent as number) >= length || parent === index))) throw new Error(`${kind} parents are invalid`);
  if (kind === "environment_promotion") {
    if (!new Set(["preview", "staging", "production"]).has(pin.environment as string)) throw new Error("environment promotion destination is invalid");
  } else if (pin.environment !== undefined) throw new Error(`${kind}.environment is not allowed`);
  return Object.freeze({ kind, authority: AUTHORITY[kind], reference: pin.reference, commitOrdinal: pin.commitOrdinal as number, digest: pin.digest, state: pin.state as RetentionState, ...(pin.parents === undefined ? {} : { parents: Object.freeze([...(pin.parents as number[])]) }), ...(pin.environment === undefined ? {} : { environment: pin.environment as "preview" | "staging" | "production" }) });
}

/**
 * Build a content-free reachability projection. Only digest/ordinal pins cross
 * this membrane: request bytes, credential values, provider bodies and logs do not.
 */
export async function projectCloudflareRetention(input: readonly RetentionPin[]): Promise<CloudflareRetentionProjection> {
  if (!Array.isArray(input)) throw new TypeError("retention pins are required");
  const pins = input.map((value, index) => normalizePin(value, index, input.length));
  for (const kind of KINDS) if (!pins.some((pin) => pin.kind === kind)) throw new Error(`missing retention pin: ${kind}`);
  const requireParents = (pin: RetentionPin, kinds: readonly RetentionKind[]) => {
    const actual = (pin.parents ?? []).map((parent) => pins[parent]!.kind);
    for (const kind of kinds) if (!actual.includes(kind)) throw new Error(`${pin.kind} must retain ${kind}`);
    if (actual.some((kind) => !kinds.includes(kind))) throw new Error(`${pin.kind} has an invalid retention edge`);
  };
  for (const pin of pins) {
    if (pin.kind === "endpoint_generation") requireParents(pin, ["endpoint_manifest"]);
    if (pin.kind === "verifier_key_generation") requireParents(pin, ["endpoint_generation"]);
    if (pin.kind === "verification_evidence") requireParents(pin, ["endpoint_generation", "verifier_key_generation"]);
    if (pin.kind === "queue_delivery") requireParents(pin, ["verification_evidence", "destination_audience"]);
    if (["retry_attempt", "dlq_attempt", "reconciliation"].includes(pin.kind)) requireParents(pin, ["queue_delivery"]);
    if (pin.kind === "provider_version") requireParents(pin, ["artifact"]);
    if (pin.kind === "environment_promotion") requireParents(pin, ["provider_version"]);
    if (pin.kind === "rollback_target") requireParents(pin, ["provider_version"]);
    if (pin.kind === "receipt") requireParents(pin, ["verification_evidence", "queue_delivery", "dlq_attempt", "environment_promotion", "rollback_target"]);
  }
  const promotions = pins.filter((pin) => pin.kind === "environment_promotion");
  for (const environment of ["preview", "staging", "production"] as const) if (promotions.filter((pin) => pin.environment === environment).length !== 1) throw new Error(`exactly one ${environment} promotion pin is required`);
  if (new Set(promotions.map((pin) => pin.parents![0])).size !== 1) throw new Error("environment promotion changed immutable provider version identity");

  const identities = new Set<string>();
  const ordinals = new Set<number>();
  for (const pin of pins) {
    const identity = `${pin.authority}:${pin.reference}`;
    if (identities.has(identity) || ordinals.has(pin.commitOrdinal)) throw new Error(`duplicate retention pin: ${pin.kind}`);
    identities.add(identity); ordinals.add(pin.commitOrdinal);
  }
  const retained = pins.map((pin) => LIVE.has(pin.state));
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < pins.length; index += 1) {
      for (const parent of pins[index]!.parents ?? []) {
        if (retained[index] && !retained[parent]) { retained[parent] = true; changed = true; }
        if (retained[parent] && !retained[index]) { retained[index] = true; changed = true; }
      }
    }
  }
  const entries = pins.map((pin, index) => Object.freeze({ ...pin, retained: retained[index]! }));
  const publicPins = entries.map(({ retained: _retained, ...pin }) => pin);
  const projectionDigest = await sha256Hex(new TextEncoder().encode(canonicalJson({ schema: CLOUDFLARE_RETENTION_SCHEMA, pins: publicPins })));
  return deepFreeze({ schema: CLOUDFLARE_RETENTION_SCHEMA, entries, blocksCollection: retained.some(Boolean), projectionDigest });
}

export function requireCloudflareCollectible(projection: CloudflareRetentionProjection, index?: number): true {
  if (projection?.schema !== CLOUDFLARE_RETENTION_SCHEMA || !Array.isArray(projection.entries) || !DIGEST.test(projection.projectionDigest)) throw new TypeError("invalid Cloudflare retention projection");
  if (index !== undefined) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= projection.entries.length) throw new Error("retention index is invalid");
    if (projection.entries[index]!.retained) throw new Error("active Cloudflare reference blocks collection");
  } else if (projection.blocksCollection || projection.entries.some((entry) => entry.retained)) throw new Error("active Cloudflare references block collection");
  return true;
}

function confirmationMatches(pin: RetentionPin, confirmation: RetentionConfirmation | null): confirmation is RetentionConfirmation {
  return confirmation?.confirmed === true && confirmation.kind === pin.kind && confirmation.reference === pin.reference &&
    confirmation.commitOrdinal === pin.commitOrdinal && confirmation.digest === pin.digest && confirmation.state === pin.state;
}

/** Compact only terminal pins independently confirmed by both owning journals. */
export async function compactCloudflareRetention(
  projection: CloudflareRetentionProjection,
  readers: Readonly<{ contract: RetentionReader; neuron: RetentionReader }>,
): Promise<CompactedCloudflareRetention> {
  requireCloudflareCollectible(projection);
  const projectedPins = projection.entries.map(({ retained: _retained, ...pin }) => pin);
  const actualProjectionDigest = await sha256Hex(new TextEncoder().encode(canonicalJson({ schema: CLOUDFLARE_RETENTION_SCHEMA, pins: projectedPins })));
  if (actualProjectionDigest !== projection.projectionDigest) throw new Error("Cloudflare retention projection digest mismatch");
  if (typeof readers?.contract !== "function" || typeof readers?.neuron !== "function") throw new TypeError("Contract and Neuron retention readers are required");
  const pins: RetentionPin[] = [];
  const confirmations: RetentionConfirmation[] = [];
  for (const entry of projection.entries) {
    const { retained: _retained, ...pin } = entry;
    const confirmation = await readers[pin.authority](Object.freeze({ ...pin }));
    if (!confirmationMatches(pin, confirmation)) throw new Error(`${pin.authority} did not confirm ${pin.kind} digest/ordinal state`);
    pins.push(Object.freeze({ ...pin })); confirmations.push(Object.freeze({ ...confirmation }));
  }
  const confirmationDigest = await sha256Hex(new TextEncoder().encode(canonicalJson(confirmations)));
  return deepFreeze({ schema: CLOUDFLARE_RETENTION_SCHEMA, compacted: true, pins, confirmationDigest, liveDeploymentClaim: false });
}
