import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createContractWebhookSurface } from "../../../../aiko-flow/packages/server/src/contractWebhooks.js";
import { ENDPOINT_MANIFEST_VERSION, sealEndpointManifest } from "../../../../aiko-flow/packages/cloudflare-webhook/src/manifest.ts";
import { CONTRACT_GATEWAY_AUDIENCE, VERIFIED_INGRESS_QUEUE, createCloudflareWebhookWorker, type CloudflareWebhookEnv } from "../../../../aiko-flow/packages/cloudflare-webhook/src/worker.ts";
import { importHmacSecretForTestOnly, providerSigningBytes } from "../../../../aiko-flow/packages/cloudflare-webhook/src/verifiers.ts";
import { CloudflareReleaseMachine, type DestinationCredential, type ReleaseEnvironment, type ReleasePins, type ReleaseProvider } from "../../../../aiko-flow/packages/cloudflare-webhook/src/release.ts";
import { wireWebhook, type WiringPorts } from "../../../../aiko-flow/.smithers/workflows/wire-webhook.tsx";

const enc = new TextEncoder();
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const hex = (c: string) => c.repeat(64);

class DurableContractFixture {
  endpoints = new Map<string, any>();
  occurrences = new Map<string, { digest: string; occurrenceId: string }>();
  commands: any[] = [];
  async command(command: any) {
    const old = this.endpoints.get(command.endpointId);
    if ((old?.endpointGeneration ?? 0) !== command.expectedGeneration) throw new Error("CAS_CONFLICT");
    this.endpoints.set(command.endpointId, structuredClone(command.next));
    this.commands.push(structuredClone(command));
  }
  async read(query: any) {
    if (query.projection === "webhook_endpoints") return [...this.endpoints.values()].filter(x => x.tenantId === query.tenantId).map(structuredClone);
    return this.endpoints.has(query.endpointId) ? structuredClone(this.endpoints.get(query.endpointId)) : undefined;
  }
  async intake(delivery: any) {
    const identity = `${delivery.tenantId}:${delivery.endpointId}:${delivery.endpointGeneration}:${delivery.deliveryId}`;
    const old = this.occurrences.get(identity);
    if (old && old.digest !== delivery.requestDigest) throw new Error("same delivery identity changed bytes: conflict");
    if (old) return { durable: true, disposition: "adopted", occurrenceId: old.occurrenceId };
    const receipt = { digest: delivery.requestDigest, occurrenceId: `occurrence-${this.occurrences.size + 1}` };
    this.occurrences.set(identity, receipt);
    return { durable: true, disposition: "accepted", occurrenceId: receipt.occurrenceId };
  }
}

const authority = { verifiedTenant: "tenant-1", authenticatedSubject: "operator-1", grantedScopes: ["orders:write"] };
const declaration = {
  provider: "fixture", audience: "https://gateway.invalid/aiko", route: "/orders", methods: ["POST"],
  contentType: "application/json", bodyLimitBytes: 1024,
  credentialHandle: { handle: "secret-handle-1", generation: 1 }, replayWindowSeconds: 300,
  contractTemplate: { name: "order-created", generation: 1 }, requiredScopes: ["orders:write"],
};

function signedServerRequest(rawBody: Uint8Array, generation = 1) {
  return { method: "POST", headers: { "content-type": "application/json", "x-fixture-signature": sha(Buffer.concat([Buffer.from(`fixture-secret-${generation}:`), rawBody])) }, rawBody };
}

async function serverScenario() {
  const contract = new DurableContractFixture();
  const verifiedBytes: Uint8Array[] = [];
  const surface = createContractWebhookSurface({
    contract,
    allocateEndpointId: () => "wh_fixture-endpoint-0001",
    resolveCredential: async ({ generation }: any) => `fixture-secret-${generation}`,
    verifier: { verify: async ({ endpoint, headers, rawBody, credential }: any) => {
      verifiedBytes.push(Uint8Array.from(rawBody));
      const signature = sha(Buffer.concat([Buffer.from(`${credential}:`), rawBody]));
      return { verified: headers["x-fixture-signature"] === signature, deliveryId: headers["x-delivery"], requestDigest: sha(rawBody), verificationEvidence: { endpointGeneration: endpoint.endpointGeneration, credentialGeneration: endpoint.credentialHandle.generation, verifier: "synthetic-hmac-over-raw-bytes" } };
    } },
  });
  const created = await surface.rpc("contractWebhooks.create", authority, declaration);
  const raw = enc.encode('{"amount":7,"note":"\\u0061"}');
  const request = { ...signedServerRequest(raw), headers: { ...signedServerRequest(raw).headers, "x-delivery": "delivery-1" } };
  const accepted = await surface.deliver(authority, created.endpointId, request);
  const adopted = await surface.deliver(authority, created.endpointId, request);
  const changed = enc.encode('{"amount":8,"note":"\\u0061"}');
  const changedRequest = { ...signedServerRequest(changed), headers: { ...signedServerRequest(changed).headers, "x-delivery": "delivery-1" } };
  await expect(surface.deliver(authority, created.endpointId, changedRequest)).rejects.toThrow("changed bytes");

  const rotated = await surface.rpc("contractWebhooks.rotate", authority, { endpointId: created.endpointId, expectedGeneration: 1, credentialHandle: { handle: "secret-handle-2", generation: 2 } });
  await expect(surface.rpc("contractWebhooks.pause", authority, { endpointId: created.endpointId, expectedGeneration: 1 })).rejects.toMatchObject({ code: "CAS_CONFLICT" });
  const paused = await surface.rpc("contractWebhooks.pause", authority, { endpointId: created.endpointId, expectedGeneration: 2 });
  await expect(surface.deliver(authority, created.endpointId, request)).rejects.toMatchObject({ code: "FENCED" });
  const revoked = await surface.rpc("contractWebhooks.revoke", authority, { endpointId: created.endpointId, expectedGeneration: 3 });
  return { contract, verifiedBytes, created, accepted, adopted, rotated, paused, revoked };
}

describe("Contract ingress and endpoint lifecycle through public server surfaces", () => {
  test("duplicate adopts one occurrence, changed bytes conflict, and every generation fences its predecessor", async () => {
    const result = await serverScenario();
    expect([result.accepted.disposition, result.adopted.disposition]).toEqual(["accepted", "adopted"]);
    expect(result.accepted.occurrenceId).toBe(result.adopted.occurrenceId);
    expect(result.contract.occurrences.size).toBe(1);
    expect(result.verifiedBytes.map(sha)).toEqual([result.accepted.requestDigest, result.adopted.requestDigest, expect.any(String)]);
    expect([result.created, result.rotated, result.paused, result.revoked].map(x => [x.endpointGeneration, x.status])).toEqual([[1,"active"],[2,"active"],[3,"paused"],[4,"revoked"]]);
    expect(() => createContractWebhookSurface({ contract: result.contract, verifier: {}, resolveCredential: async () => "x" } as any)).toThrow("raw-byte verifier");
  });
});

const edgeNow = 1_700_000_000;
const edgeSecret = "hermetic-edge-secret-123";
async function edgePin() {
  return sealEndpointManifest({
    version: ENDPOINT_MANIFEST_VERSION, endpointId: "orders", endpointGeneration: "gen-1",
    provider: { id: "acme", nonceNamespace: "acme.delivery", signatureHeader: "x-signature", timestampHeader: "x-timestamp", deliveryIdHeader: "x-delivery", signaturePrefix: "sha256=", verifier: "hmac-sha256.timestamp-delivery-raw-body.v1" },
    authority: { verifiedTenant: "tenant-1", authenticatedSubject: "acme-app", audience: CONTRACT_GATEWAY_AUDIENCE, grantedScopes: ["hook.orders.write"] },
    credential: { binding: "ACME_HOOK_SECRET", generation: "key-1" }, destination: { queue: VERIFIED_INGRESS_QUEUE },
    bounds: { maxBodyBytes: 128, maxDeliveryIdBytes: 24, maxAgeSeconds: 300, maxFutureSkewSeconds: 10, rate: { requests: 10, windowSeconds: 60 } },
  });
}
async function edgeRequest(body: Uint8Array, delivery = "edge-delivery-1") {
  const timestamp = String(edgeNow);
  const key = await importHmacSecretForTestOnly(enc.encode(edgeSecret));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, providerSigningBytes(timestamp, delivery, body)));
  return new Request("https://edge.invalid/contract-webhooks/orders", { method: "POST", headers: { "x-signature": `sha256=${[...signature].map(b=>b.toString(16).padStart(2,"0")).join("")}`, "x-timestamp": timestamp, "x-delivery": delivery }, body });
}

async function edgeEnvironment() {
  const endpoint = await edgePin();
  const queued: any[] = []; const calls: string[] = []; const replay = new Map<string,string>();
  let releaseQueue!: () => void;
  const queueBarrier = new Promise<void>(resolve => { releaseQueue = resolve; });
  const env: CloudflareWebhookEnv = {
    ENDPOINT_MANIFESTS: { fetch: async () => Response.json(endpoint) },
    WEBHOOK_COORDINATOR: { fetch: async request => {
      const input: any = await request.json();
      if (new URL(request.url).pathname.endsWith("/claim")) { const old=replay.get(input.tuple); if (!old) { replay.set(input.tuple,input.fingerprint); return Response.json("accepted"); } return Response.json(old===input.fingerprint?"replay":"conflict"); }
      return Response.json({ allowed: true });
    } },
    WEBHOOK_SECRETS: { get: async name => name === "ACME_HOOK_SECRET" ? edgeSecret : null },
    VERIFIED_INGRESS_QUEUE: { send: async message => { calls.push("queue-start"); queued.push(message); await queueBarrier; calls.push("queue-durable"); } },
    WEBHOOK_DLQ: { send: async () => {} },
    AIKO_GATEWAY: { fetch: async request => {
      calls.push("contract-intake");
      const delivery: any = await request.clone().json();
      return Response.json({ kind: "durable", receipt: { kind: "contract-durable-intake", replayIdentity: delivery.replayIdentity, receiptDigest: hex("e") } });
    } },
  };
  return { env, queued, calls, releaseQueue };
}

describe("public Cloudflare Worker raw-byte ingress", () => {
  test("does not return 202 before durable queue and ACKs only a durable Contract receipt", async () => {
    const state = await edgeEnvironment();
    const worker = createCloudflareWebhookWorker({ fixedAudience: CONTRACT_GATEWAY_AUDIENCE, queueName: VERIFIED_INGRESS_QUEUE, delivery: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 }, nowSeconds: () => edgeNow });
    const raw = new Uint8Array([0xff, 0x00, 0x7b, 0x7d]);
    const pending = worker.fetch(await edgeRequest(raw), state.env);
    let returned = false; pending.then(() => { returned = true; });
    while (!state.calls.includes("queue-start")) await Bun.sleep(0);
    expect(returned).toBe(false);
    state.releaseQueue();
    const response = await pending;
    expect(response.status).toBe(202);
    expect(state.calls).toEqual(["queue-start", "queue-durable"]);
    expect(state.queued).toHaveLength(1);
    expect(JSON.stringify(state.queued[0])).not.toMatch(/rawBody|hermetic-edge-secret/);
    let acked = 0;
    await worker.queue({ messages: [{ body: state.queued[0], attempts: 1, ack: () => { acked++; state.calls.push("ack"); }, retry: () => { throw new Error("durable intake must not retry"); } }] }, state.env);
    expect(acked).toBe(1);
    expect(state.calls.slice(-2)).toEqual(["contract-intake", "ack"]);

    const mutated = raw.slice(); mutated[0] ^= 1;
    const bad = await worker.fetch(await edgeRequest(raw, "edge-mutant").then(async original => new Request(original.url, { method: "POST", headers: original.headers, body: mutated })), state.env);
    expect(bad.status).toBe(401);
  });
});

const pins: ReleasePins = { gitSha: "a".repeat(40), manifestDigest: hex("b"), bindingsDigest: hex("c"), migrationsDigest: hex("d") };
const credential: DestinationCredential = { provider: "cloudflare", accountId: "acct-fixture", handleId: "credential-handle", generation: "credential-1", destinations: ["preview","staging","production"] };
class ProviderFixture implements ReleaseProvider {
  uploads: any[]=[]; promotions: any[]=[]; versions=new Map<string,string>(); mutatePromotion=false;
  async upload(input:any) { this.uploads.push(input); const versionId=`version-${this.uploads.length}`; this.versions.set(versionId,input.artifactDigest); return { accountId:input.accountId, versionId, artifactDigest:input.artifactDigest }; }
  async promote(input:any) { this.promotions.push(input); return { accountId:input.accountId, environment:input.environment, versionId:this.mutatePromotion?"changed-version":input.versionId, deploymentId:`deployment-${this.promotions.length}` }; }
  async verifyVersion(input:any) { return { accountId:input.accountId, versionId:input.versionId, artifactDigest:this.versions.get(input.versionId)! }; }
}
async function promote(machine: CloudflareReleaseMachine, releaseId:string, bytes:Uint8Array) {
  const receipts=[await machine.upload({ releaseId, artifact:bytes, pins, credential })];
  for (const env of ["preview","staging","production"] as ReleaseEnvironment[]) receipts.push(await machine.promote(env));
  return receipts;
}

describe("immutable release evidence through public release machine", () => {
  test("one uploaded version survives all promotions and rollback receipts never claim live verification", async () => {
    const provider=new ProviderFixture(); const machine=new CloudflareReleaseMachine(provider);
    const v1=await promote(machine,"release-1",enc.encode("worker-v1"));
    const v2=await promote(machine,"release-2",enc.encode("worker-v2"));
    const rollback=await machine.rollback("version-1");
    expect(v1.map(x=>x.providerVersionId)).toEqual(["version-1","version-1","version-1","version-1"]);
    expect(v2.map(x=>x.providerVersionId)).toEqual(["version-2","version-2","version-2","version-2"]);
    expect(rollback).toMatchObject({ operation:"rollback", providerVersionId:"version-1", environment:"production", liveDeploymentClaim:false, smoke:"not-run" });
    for (const receipt of [...v1,...v2,rollback]) { expect(Object.isFrozen(receipt)).toBe(true); expect(receipt.liveDeploymentClaim).toBe(false); }
    const mutant=new ProviderFixture(); mutant.mutatePromotion=true;
    const m=new CloudflareReleaseMachine(mutant); await m.upload({ releaseId:"mutant", artifact:enc.encode("x"), pins, credential });
    await expect(m.promote("preview")).rejects.toThrow("version mismatch");
  });
});

function wiringManifest() {
  return {
    version: ENDPOINT_MANIFEST_VERSION, endpointId:"orders", endpointGeneration:"1",
    provider:{ id:"acme", nonceNamespace:"acme.delivery", signatureHeader:"x-signature", timestampHeader:"x-timestamp", deliveryIdHeader:"x-delivery", signaturePrefix:"sha256=", verifier:"hmac-sha256.timestamp-delivery-raw-body.v1" },
    authority:{ verifiedTenant:"tenant-1", authenticatedSubject:"operator-1", audience:CONTRACT_GATEWAY_AUDIENCE, grantedScopes:["webhook:provision"] },
    credential:{ binding:"ACME_HOOK_SECRET", generation:"1" }, destination:{ queue:VERIFIED_INGRESS_QUEUE },
    bounds:{ maxBodyBytes:128,maxDeliveryIdBytes:24,maxAgeSeconds:300,maxFutureSkewSeconds:10,rate:{requests:10,windowSeconds:60} },
  };
}
function wiringPorts(callbackDigest:string) {
  const calls:string[]=[]; let admitted="";
  const ports: WiringPorts = {
    contract:{ requireAuthorizedOccurrence:async()=>{calls.push("authority")}, admitManifest:async (x:any)=>{calls.push("admit");admitted=x.digest;return {admitted:true,digest:x.digest}}, recordReceipt:async()=>{}, adoptInbound:async()=>({disposition:"accepted",occurrenceId:"unused"}),transition:async()=>{} },
    release:{ upload:async (x:any)=>({providerVersionId:"version-fixture",artifactDigest:x.artifactDigest,liveDeploymentClaim:false}), promote:async (x:any)=>({providerVersionId:x.providerVersionId,environment:x.environment,deploymentId:`deploy-${x.environment}`,liveDeploymentClaim:false}), rollback:async()=>({providerVersionId:"prior",environment:"production",liveDeploymentClaim:false}) },
    worker:{ applyGeneration:async()=>({url:"https://edge.invalid/contract-webhooks/orders",generation:1}) }, smithers:{projectGeneration:async()=>{}},
    neuron:{ assertAdmittedLimb:async()=>{calls.push("limb-admitted")}, invoke:async(x:any)=>{calls.push("outbound-crossed");return {effectId:x.effectId,crossed:true}}, readCallback:async(x:any)=>{calls.push("independent-readback");return {effectId:x.effectId,bodyDigest:callbackDigest,status:"acknowledged"}}, fenceGeneration:async()=>{},compensate:async()=>{} },
  };
  return {ports,calls,get admitted(){return admitted}};
}

describe("admitted outbound crossing and independent read-back through public wiring kernel", () => {
  test("settles only after callback correlation; a mutated read-back cannot settle", async () => {
    const artifact=enc.encode("immutable-worker"); const bodyDigest=sha("outbound-body");
    const request:any={ authority:{occurrenceId:"occ-1",authenticatedSubject:"operator-1",verifiedTenant:"tenant-1",grantedScopes:["webhook:provision"],approved:true,approvalId:"approval-1"},endpointId:"orders",generation:1,credentialGeneration:1,manifest:wiringManifest(),artifact,artifactDigest:sha(artifact),outbound:{effectId:"effect-1",bodyDigest,callbackBodyDigest:bodyDigest,limbDigest:hex("f")} };
    const good=wiringPorts(bodyDigest); const receipt=await wireWebhook(request,good.ports);
    expect(good.calls).toEqual(["authority","admit","limb-admitted","outbound-crossed","independent-readback"]);
    expect(receipt.outbound?.effectId).toBe("effect-1"); expect(receipt.liveDeploymentClaim).toBe(false);
    const mutant=wiringPorts(hex("0"));
    await expect(wireWebhook(request,mutant.ports)).rejects.toThrow("independent callback/read-back correlation failed");
  });
});
