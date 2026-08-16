import { describe, expect, test } from "bun:test";
import {
  QueueRefusal, consumeQueuedDelivery, deriveDeliveryIdentity, deterministicRetryDelayMs, enqueueVerifiedDelivery,
  type ConsumerControl, type ContractClient, type ContractDurableReceipt, type DeadLetterRecord, type DigestDeadLetterQueue,
  type DurableQueueClient, type QueuedContractDelivery,
} from "../src/queue";
import type { VerifiedIngressProjection } from "../src/verifiers";

const d = (character: string) => character.repeat(64);
const policy = { fixedAudience: "aiko.contract.ingress", maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 } as const;
function projection(changes: Partial<VerifiedIngressProjection> = {}): VerifiedIngressProjection {
  return {
    version: "aiko.verified-ingress.v1", authenticatedSubject: "provider-app", verifiedTenant: "tenant-42",
    transport: "cloudflare.webhook", audience: policy.fixedAudience, grantedScopes: ["hook.orders.write"],
    canonicalRequestDigest: d("a"), nonceNamespace: "acme.delivery", idempotencyKey: "delivery-7",
    verificationEvidence: { verifier: "hmac-sha256.timestamp-delivery-raw-body.v1", signatureResult: "verified", credentialGeneration: "cred-3", endpointGeneration: "endpoint-9", manifestDigest: d("b") },
    ...changes,
  };
}
async function envelope(changes: Partial<QueuedContractDelivery> = {}): Promise<QueuedContractDelivery> {
  const ingress = projection();
  const identity = await deriveDeliveryIdentity(ingress);
  return { version: "aiko.cloudflare-webhook.queue.v1", ...identity, manifestDigest: d("b"), ingress, ...changes };
}
class AtomicQueue implements DurableQueueClient {
  entries = new Map<string, string>();
  messages: QueuedContractDelivery[] = [];
  durable = true;
  async enqueue(message: QueuedContractDelivery) {
    this.messages.push(message);
    const existing = this.entries.get(message.deliveryKey);
    const disposition = existing === undefined ? "enqueued" as const : existing === message.replayIdentity ? "adopted" as const : "conflict" as const;
    if (existing === undefined) this.entries.set(message.deliveryKey, message.replayIdentity);
    return { durable: this.durable as true, disposition, receiptDigest: d("c") };
  }
}
class Control implements ConsumerControl {
  acks: ContractDurableReceipt[] = []; retries: number[] = []; parks: string[] = []; quarantines: string[] = [];
  ack(receipt: ContractDurableReceipt) { this.acks.push(receipt); }
  retry(delay: number) { this.retries.push(delay); }
  park(reason: "read_back_indeterminate") { this.parks.push(reason); }
  quarantine(receipt: { durable: true; receiptDigest: string }) { this.quarantines.push(receipt.receiptDigest); }
}
class Dlq implements DigestDeadLetterQueue {
  records: DeadLetterRecord[] = [];
  put(record: DeadLetterRecord) { this.records.push(record); return { durable: true as const, receiptDigest: d("d") }; }
}
const receipt = (replayIdentity: string): ContractDurableReceipt => ({ kind: "contract-durable-intake", replayIdentity, receiptDigest: d("e") });
function clients(outcome: Awaited<ReturnType<ContractClient["intake"]>>, readBack: Awaited<ReturnType<ContractClient["readBack"]>> = { kind: "indeterminate" }) {
  const calls = { intake: 0, readBack: 0 };
  const contract: ContractClient = { intake: () => { calls.intake++; return outcome; }, readBack: () => { calls.readBack++; return readBack; } };
  return { contract, calls };
}

async function refused(promise: Promise<unknown>, code: QueueRefusal["code"]) {
  try { await promise; throw new Error("expected refusal"); } catch (error) { expect(error).toBeInstanceOf(QueueRefusal); expect((error as QueueRefusal).code).toBe(code); }
}

describe("pure Cloudflare queue and Contract delivery kernel", () => {
  test("mutation: HTTP success cannot precede durable enqueue and carries no raw body, secret, URL, or deployment claim", async () => {
    let release!: (value: Awaited<ReturnType<DurableQueueClient["enqueue"]>>) => void;
    const messages: QueuedContractDelivery[] = [];
    const queue: DurableQueueClient = { enqueue: (message) => { messages.push(message); return new Promise((resolve) => { release = resolve; }); } };
    let settled = false;
    const pending = enqueueVerifiedDelivery({ ingress: projection(), manifestDigest: d("b") }, policy, queue).then((value) => { settled = true; return value; });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release({ durable: true, disposition: "enqueued", receiptDigest: d("c") });
    expect(await pending).toEqual({ status: 202, disposition: "enqueued", replayIdentity: messages[0]!.replayIdentity, queueReceiptDigest: d("c") });
    expect(Object.keys(messages[0]!).sort()).toEqual(["deliveryKey", "ingress", "manifestDigest", "replayIdentity", "version"]);
    expect(JSON.stringify(messages[0])).not.toMatch(/rawBody|secret|https?:|deployment/i);

    const nonDurable: DurableQueueClient = { enqueue: async () => ({ durable: false, disposition: "enqueued", receiptDigest: d("c") } as never) };
    await refused(enqueueVerifiedDelivery({ ingress: projection(), manifestDigest: d("b") }, policy, nonDurable), "enqueue");
  });

  test("mutation: replay identity binds endpoint generation, provider namespace, delivery id, and raw digest", async () => {
    const original = projection();
    const identity = await deriveDeliveryIdentity(original);
    for (const changed of [
      projection({ verificationEvidence: { ...original.verificationEvidence, endpointGeneration: "endpoint-10" } }),
      projection({ nonceNamespace: "other-provider.delivery" }), projection({ idempotencyKey: "delivery-8" }),
      projection({ canonicalRequestDigest: d("f") }),
    ]) expect((await deriveDeliveryIdentity(changed)).replayIdentity).not.toBe(identity.replayIdentity);
    expect((await deriveDeliveryIdentity(projection())).replayIdentity).toBe(identity.replayIdentity);
  });

  test("mutation: identical duplicate is adopted while changed digest on one delivery key conflicts", async () => {
    const queue = new AtomicQueue();
    expect((await enqueueVerifiedDelivery({ ingress: projection(), manifestDigest: d("b") }, policy, queue)).disposition).toBe("enqueued");
    expect((await enqueueVerifiedDelivery({ ingress: projection(), manifestDigest: d("b") }, policy, queue)).disposition).toBe("adopted");
    const changed = projection({ canonicalRequestDigest: d("f") });
    await refused(enqueueVerifiedDelivery({ ingress: changed, manifestDigest: d("b") }, policy, queue), "replay_conflict");
    expect(queue.entries).toHaveLength(1);
  });

  test("mutation: only the fixed manifest audience and exact minimized verifier projection are admitted", async () => {
    const queue = new AtomicQueue();
    await refused(enqueueVerifiedDelivery({ ingress: projection({ audience: "attacker.callback" }), manifestDigest: d("b") }, policy, queue), "audience");
    await refused(enqueueVerifiedDelivery({ ingress: { ...projection(), url: "https://attacker.invalid" } as VerifiedIngressProjection, manifestDigest: d("b") }, policy, queue), "projection");
    await refused(enqueueVerifiedDelivery({ ingress: projection(), manifestDigest: d("b"), rawBody: "secret" } as never, policy, queue), "projection");
    await refused(enqueueVerifiedDelivery({ ingress: projection(), manifestDigest: d("f") }, policy, queue), "projection");
    expect(queue.messages).toHaveLength(0);
  });

  test("mutation: consumer ACK occurs only after a matching Contract durable-intake receipt", async () => {
    const message = await envelope(); const control = new Control(); const dlq = new Dlq();
    const good = clients({ kind: "durable", receipt: receipt(message.replayIdentity) });
    expect(await consumeQueuedDelivery({ message, attempt: 1 }, policy, good.contract, dlq, control)).toBe("acked");
    expect(control.acks).toEqual([receipt(message.replayIdentity)]);
    expect(good.calls.readBack).toBe(0);

    const badControl = new Control();
    const bad = clients({ kind: "durable", receipt: receipt(d("0")) });
    await refused(consumeQueuedDelivery({ message, attempt: 1 }, policy, bad.contract, dlq, badControl), "receipt");
    expect(badControl.acks).toHaveLength(0);
  });

  test("mutation: uncertain downstream result can only be settled through independent read-back", async () => {
    const message = await envelope();
    for (const variant of ["returned", "thrown"] as const) {
      for (const readBack of [{ kind: "present", receipt: receipt(message.replayIdentity) } as const, { kind: "absent" } as const, { kind: "indeterminate" } as const]) {
        const control = new Control(); const dlq = new Dlq(); let reads = 0;
        const contract: ContractClient = {
          intake: () => variant === "thrown" ? Promise.reject(new Error("timeout after crossing")) : { kind: "uncertain" },
          readBack: () => { reads++; return readBack; },
        };
        const result = await consumeQueuedDelivery({ message, attempt: 1 }, policy, contract, dlq, control);
        expect(reads).toBe(1);
        if (readBack.kind === "present") { expect(result).toBe("acked"); expect(control.acks).toHaveLength(1); expect(control.retries).toHaveLength(0); }
        if (readBack.kind === "absent") { expect(result).toBe("retried"); expect(control.acks).toHaveLength(0); expect(control.retries).toHaveLength(1); }
        if (readBack.kind === "indeterminate") { expect(result).toBe("parked"); expect(control.parks).toEqual(["read_back_indeterminate"]); expect(control.acks).toHaveLength(0); expect(control.retries).toHaveLength(0); }
      }
    }
  });

  test("mutation: at-least-once retry is deterministic and bounded; exhaustion never requeues", async () => {
    const message = await envelope(); const expected = await deterministicRetryDelayMs(message.replayIdentity, 2, policy);
    expect(await deterministicRetryDelayMs(message.replayIdentity, 2, policy)).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(50); expect(expected).toBeLessThanOrEqual(100);
    const control = new Control(); const dlq = new Dlq();
    expect(await consumeQueuedDelivery({ message, attempt: 1 }, policy, clients({ kind: "retryable" }).contract, dlq, control)).toBe("retried");
    expect(control.retries).toEqual([expected]); expect(control.acks).toHaveLength(0);

    const exhaustedControl = new Control(); const exhaustedDlq = new Dlq();
    expect(await consumeQueuedDelivery({ message, attempt: 3 }, policy, clients({ kind: "retryable" }).contract, exhaustedDlq, exhaustedControl)).toBe("quarantined");
    expect(exhaustedControl.retries).toHaveLength(0); expect(exhaustedControl.acks).toHaveLength(0);
    expect(exhaustedDlq.records[0]!.reason).toBe("exhausted");
    await expect(deterministicRetryDelayMs(message.replayIdentity, 4, policy)).rejects.toThrow("outside the bounded policy");
  });

  test("mutation: poison and permanent failures become digest-only DLQ records, never ACKs or retries", async () => {
    for (const item of [
      { message: { ...(await envelope()), ingress: { ...(await envelope()).ingress, rawBody: "secret payload" } }, outcome: { kind: "retryable" } as const, reason: "poison" },
      { message: await envelope(), outcome: { kind: "permanent" } as const, reason: "permanent" },
    ] as const) {
      const control = new Control(); const dlq = new Dlq();
      expect(await consumeQueuedDelivery({ message: item.message, attempt: 1 }, policy, clients(item.outcome).contract, dlq, control)).toBe("quarantined");
      expect(control.acks).toHaveLength(0); expect(control.retries).toHaveLength(0); expect(control.quarantines).toEqual([d("d")]);
      expect(dlq.records[0]!.reason).toBe(item.reason);
      expect(Object.keys(dlq.records[0]!).sort()).toEqual(["attempts", "messageDigest", "reason", "replayIdentityDigest", "version"]);
      expect(JSON.stringify(dlq.records[0])).not.toMatch(/secret payload|rawBody|authenticatedSubject|https?:/);
    }
  });
});
