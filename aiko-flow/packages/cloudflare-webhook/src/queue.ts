import { canonicalJson, sha256Hex } from "./manifest";
import type { VerifiedIngressProjection } from "./verifiers";

const HEX_256 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_ATTEMPTS = 64;
const MAX_DELAY_MS = 86_400_000;

export type DeliveryPolicy = Readonly<{
  fixedAudience: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}>;

export type QueuedContractDelivery = Readonly<{
  version: "aiko.cloudflare-webhook.queue.v1";
  replayIdentity: string;
  deliveryKey: string;
  manifestDigest: string;
  ingress: VerifiedIngressProjection;
}>;

export type DurableEnqueueResult = Readonly<{
  durable: true;
  disposition: "enqueued" | "adopted" | "conflict";
  receiptDigest: string;
}>;

/** The adapter must atomically compare deliveryKey -> replayIdentity and persist the body. */
export interface DurableQueueClient {
  enqueue(message: QueuedContractDelivery): Promise<DurableEnqueueResult> | DurableEnqueueResult;
}

export type EnqueueReceipt = Readonly<{
  status: 202;
  disposition: "enqueued" | "adopted";
  replayIdentity: string;
  queueReceiptDigest: string;
}>;

export type ContractDurableReceipt = Readonly<{
  kind: "contract-durable-intake";
  replayIdentity: string;
  receiptDigest: string;
}>;

export type ContractIntakeResult =
  | Readonly<{ kind: "durable"; receipt: ContractDurableReceipt }>
  | Readonly<{ kind: "retryable" }>
  | Readonly<{ kind: "permanent" }>
  | Readonly<{ kind: "uncertain" }>;
export type ContractReadBack =
  | Readonly<{ kind: "present"; receipt: ContractDurableReceipt }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "indeterminate" }>;

export interface ContractClient {
  intake(delivery: QueuedContractDelivery): Promise<ContractIntakeResult> | ContractIntakeResult;
  /** Must be an independent Contract ledger read, never a sender acknowledgement. */
  readBack(replayIdentity: string): Promise<ContractReadBack> | ContractReadBack;
}

export type DeadLetterRecord = Readonly<{
  version: "aiko.cloudflare-webhook.dlq.v1";
  messageDigest: string;
  replayIdentityDigest: string;
  reason: "poison" | "permanent" | "exhausted";
  attempts: number;
}>;
export type DeadLetterReceipt = Readonly<{ durable: true; receiptDigest: string }>;
export interface DigestDeadLetterQueue {
  put(record: DeadLetterRecord): Promise<DeadLetterReceipt> | DeadLetterReceipt;
}

/** quarantine is deliberately distinct from ACK: ACK accepts only a Contract receipt. */
export interface ConsumerControl {
  ack(receipt: ContractDurableReceipt): Promise<void> | void;
  retry(delayMs: number): Promise<void> | void;
  park(reason: "read_back_indeterminate"): Promise<void> | void;
  quarantine(receipt: DeadLetterReceipt): Promise<void> | void;
}

export class QueueRefusal extends Error {
  constructor(public readonly code: "projection" | "audience" | "enqueue" | "replay_conflict" | "policy" | "receipt", message: string) {
    super(message);
    this.name = "QueueRefusal";
  }
}

function exactKeys(value: object, keys: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new QueueRefusal("projection", `${name}.${key} is not allowed`);
  for (const key of keys) if (!(key in value)) throw new QueueRefusal("projection", `${name}.${key} is required`);
}
function validText(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function assertDigest(value: unknown, name: string, code: QueueRefusal["code"] = "projection"): asserts value is string {
  if (typeof value !== "string" || !HEX_256.test(value)) throw new QueueRefusal(code, `${name} must be a lowercase sha256 digest`);
}
function assertPolicy(policy: DeliveryPolicy): void {
  exactKeys(policy, ["fixedAudience", "maxAttempts", "baseDelayMs", "maxDelayMs"], "policy");
  if (!validText(policy.fixedAudience) || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > MAX_ATTEMPTS ||
      !Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 1 || !Number.isSafeInteger(policy.maxDelayMs) ||
      policy.maxDelayMs < policy.baseDelayMs || policy.maxDelayMs > MAX_DELAY_MS) throw new QueueRefusal("policy", "delivery policy is invalid or unbounded");
}
function assertProjection(value: unknown, manifestDigest: string, audience: string): asserts value is VerifiedIngressProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QueueRefusal("projection", "verified projection must be an object");
  exactKeys(value, ["version", "authenticatedSubject", "verifiedTenant", "transport", "audience", "grantedScopes", "canonicalRequestDigest", "nonceNamespace", "idempotencyKey", "verificationEvidence"], "ingress");
  const p = value as Record<string, unknown>;
  if (p.version !== "aiko.verified-ingress.v1" || p.transport !== "cloudflare.webhook" || !validText(p.authenticatedSubject) ||
      !validText(p.verifiedTenant) || !validText(p.audience) || !validText(p.nonceNamespace) || !validText(p.idempotencyKey)) throw new QueueRefusal("projection", "verified projection identity is invalid");
  if (p.audience !== audience) throw new QueueRefusal("audience", "projection is outside the fixed Contract audience");
  assertDigest(p.canonicalRequestDigest, "canonicalRequestDigest");
  if (!Array.isArray(p.grantedScopes) || p.grantedScopes.length < 1 || p.grantedScopes.length > 32 || p.grantedScopes.some((scope) => !validText(scope)) || new Set(p.grantedScopes).size !== p.grantedScopes.length) throw new QueueRefusal("projection", "grantedScopes is invalid");
  const evidence = p.verificationEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new QueueRefusal("projection", "verificationEvidence must be an object");
  exactKeys(evidence, ["verifier", "signatureResult", "credentialGeneration", "endpointGeneration", "manifestDigest"], "verificationEvidence");
  const e = evidence as Record<string, unknown>;
  if (e.verifier !== "hmac-sha256.timestamp-delivery-raw-body.v1" || e.signatureResult !== "verified" || !validText(e.credentialGeneration) || !validText(e.endpointGeneration)) throw new QueueRefusal("projection", "verification evidence is invalid");
  assertDigest(e.manifestDigest, "verificationEvidence.manifestDigest");
  if (e.manifestDigest !== manifestDigest) throw new QueueRefusal("projection", "manifest digest does not match verified projection");
}

async function hashFields(domain: string, fields: readonly string[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode([domain, ...fields].map((field) => `${new TextEncoder().encode(field).byteLength}:${field}`).join("|")));
}

export async function deriveDeliveryIdentity(projection: VerifiedIngressProjection): Promise<Readonly<{ deliveryKey: string; replayIdentity: string }>> {
  const fields = [projection.verificationEvidence.endpointGeneration, projection.nonceNamespace, projection.idempotencyKey];
  return Object.freeze({
    deliveryKey: await hashFields("aiko.cloudflare-webhook.delivery-key/v1", fields),
    replayIdentity: await hashFields("aiko.cloudflare-webhook.replay/v1", [...fields, projection.canonicalRequestDigest]),
  });
}

/** Success is constructed only after the injected queue returns a durable receipt. */
export async function enqueueVerifiedDelivery(input: Readonly<{ ingress: VerifiedIngressProjection; manifestDigest: string }>, policy: DeliveryPolicy, queue: DurableQueueClient): Promise<EnqueueReceipt> {
  exactKeys(input, ["ingress", "manifestDigest"], "enqueue");
  assertPolicy(policy);
  assertDigest(input.manifestDigest, "manifestDigest");
  assertProjection(input.ingress, input.manifestDigest, policy.fixedAudience);
  const identity = await deriveDeliveryIdentity(input.ingress);
  const message: QueuedContractDelivery = Object.freeze({ version: "aiko.cloudflare-webhook.queue.v1", ...identity, manifestDigest: input.manifestDigest, ingress: input.ingress });
  const result = await queue.enqueue(message);
  if (!result || result.durable !== true) throw new QueueRefusal("enqueue", "queue did not return durable enqueue evidence");
  assertDigest(result.receiptDigest, "queue receipt", "receipt");
  if (result.disposition === "conflict") throw new QueueRefusal("replay_conflict", "delivery id was reused with changed verified bytes");
  if (result.disposition !== "enqueued" && result.disposition !== "adopted") throw new QueueRefusal("enqueue", "invalid durable queue disposition");
  return Object.freeze({ status: 202, disposition: result.disposition, replayIdentity: identity.replayIdentity, queueReceiptDigest: result.receiptDigest });
}

export async function deterministicRetryDelayMs(replayIdentity: string, nextAttempt: number, policy: DeliveryPolicy): Promise<number> {
  assertPolicy(policy); assertDigest(replayIdentity, "replayIdentity");
  if (!Number.isSafeInteger(nextAttempt) || nextAttempt < 2 || nextAttempt > policy.maxAttempts) throw new QueueRefusal("policy", "retry attempt is outside the bounded policy");
  const exponent = Math.min(nextAttempt - 2, 30);
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const floor = Math.floor(cap / 2);
  const digest = await hashFields("aiko.cloudflare-webhook.retry/v1", [replayIdentity, String(nextAttempt)]);
  const spread = cap - floor;
  return floor + (Number.parseInt(digest.slice(0, 8), 16) % (spread + 1));
}

function isEnvelope(value: unknown): value is QueuedContractDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    exactKeys(value, ["version", "replayIdentity", "deliveryKey", "manifestDigest", "ingress"], "message");
    const m = value as Record<string, unknown>;
    if (m.version !== "aiko.cloudflare-webhook.queue.v1") return false;
    assertDigest(m.replayIdentity, "replayIdentity"); assertDigest(m.deliveryKey, "deliveryKey"); assertDigest(m.manifestDigest, "manifestDigest");
    return true;
  } catch { return false; }
}
function validContractReceipt(receipt: ContractDurableReceipt, replayIdentity: string): boolean {
  return receipt?.kind === "contract-durable-intake" && receipt.replayIdentity === replayIdentity && HEX_256.test(receipt.receiptDigest);
}
async function digestUnknown(value: unknown): Promise<string> {
  try { return await sha256Hex(new TextEncoder().encode(canonicalJson(value))); }
  catch { return sha256Hex(new TextEncoder().encode("aiko.cloudflare-webhook.unserializable-poison/v1")); }
}
async function deadLetter(message: unknown, replayIdentity: string | undefined, attempts: number, reason: DeadLetterRecord["reason"], dlq: DigestDeadLetterQueue, control: ConsumerControl): Promise<"quarantined"> {
  const messageDigest = await digestUnknown(message);
  const replayIdentityDigest = replayIdentity && HEX_256.test(replayIdentity) ? await hashFields("aiko.cloudflare-webhook.dlq-identity/v1", [replayIdentity]) : await hashFields("aiko.cloudflare-webhook.dlq-identity/v1", [messageDigest]);
  const record: DeadLetterRecord = Object.freeze({ version: "aiko.cloudflare-webhook.dlq.v1", messageDigest, replayIdentityDigest, reason, attempts });
  const receipt = await dlq.put(record);
  if (!receipt || receipt.durable !== true || !HEX_256.test(receipt.receiptDigest)) throw new QueueRefusal("receipt", "DLQ did not return durable evidence");
  await control.quarantine(receipt);
  return "quarantined";
}

export async function consumeQueuedDelivery(input: Readonly<{ message: unknown; attempt: number }>, policy: DeliveryPolicy, contract: ContractClient, dlq: DigestDeadLetterQueue, control: ConsumerControl): Promise<"acked" | "retried" | "parked" | "quarantined"> {
  assertPolicy(policy);
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > MAX_ATTEMPTS || !isEnvelope(input.message)) return deadLetter(input.message, undefined, Number.isSafeInteger(input.attempt) ? input.attempt : 0, "poison", dlq, control);
  const message = input.message;
  try { assertProjection(message.ingress, message.manifestDigest, policy.fixedAudience); } catch { return deadLetter(message, message.replayIdentity, input.attempt, "poison", dlq, control); }
  const derived = await deriveDeliveryIdentity(message.ingress);
  if (derived.replayIdentity !== message.replayIdentity || derived.deliveryKey !== message.deliveryKey) return deadLetter(message, message.replayIdentity, input.attempt, "poison", dlq, control);

  let outcome: ContractIntakeResult;
  try { outcome = await contract.intake(message); } catch { outcome = { kind: "uncertain" }; }
  if (outcome.kind === "durable") {
    if (!validContractReceipt(outcome.receipt, message.replayIdentity)) throw new QueueRefusal("receipt", "Contract durable-intake receipt is invalid");
    await control.ack(outcome.receipt);
    return "acked";
  }
  if (outcome.kind === "uncertain") {
    const readBack = await contract.readBack(message.replayIdentity);
    if (readBack.kind === "present") {
      if (!validContractReceipt(readBack.receipt, message.replayIdentity)) throw new QueueRefusal("receipt", "Contract read-back receipt is invalid");
      await control.ack(readBack.receipt);
      return "acked";
    }
    if (readBack.kind === "indeterminate") { await control.park("read_back_indeterminate"); return "parked"; }
    if (readBack.kind !== "absent") throw new QueueRefusal("receipt", "invalid Contract read-back result");
    outcome = { kind: "retryable" };
  }
  if (outcome.kind === "permanent") return deadLetter(message, message.replayIdentity, input.attempt, "permanent", dlq, control);
  if (outcome.kind !== "retryable") throw new QueueRefusal("receipt", "invalid Contract intake result");
  if (input.attempt >= policy.maxAttempts) return deadLetter(message, message.replayIdentity, input.attempt, "exhausted", dlq, control);
  await control.retry(await deterministicRetryDelayMs(message.replayIdentity, input.attempt + 1, policy));
  return "retried";
}
