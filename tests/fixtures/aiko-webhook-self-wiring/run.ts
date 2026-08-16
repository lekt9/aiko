import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(process.argv[2]);
const stateDir = resolve(process.argv[3]);
mkdirSync(stateDir, { recursive: true });
const journal = join(stateDir, "journal.jsonl");
const scenario = JSON.parse(readFileSync(join(import.meta.dir, "scenario.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(import.meta.dir, "manifest.json"), "utf8"));
const workflow = await import(process.argv[4] ? resolve(process.argv[4]) : resolve(repo, "aiko-flow/.smithers/workflows/wire-webhook.tsx"));
const { CloudflareReleaseMachine } = await import(resolve(repo, "aiko-flow/packages/cloudflare-webhook/src/release.ts"));
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const append = (kind: string, data: any = {}) => appendFileSync(journal, JSON.stringify({ ordinal: readRows().length + 1, kind, ...data }) + "\n", { mode: 0o600 });
const readRows = () => { try { return readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
const expectReject = async (fn: () => Promise<any>, text: string) => { try { await fn(); throw Error(`expected refusal: ${text}`); } catch (e: any) { if (String(e.message).startsWith("expected refusal")) throw e; append("refusal", { text, message: String(e.message) }); } };
if (readRows().length) throw Error("fixture requires empty state");

let providerCounter = 0;
const providerVersions = new Map<string, string>();
const provider = {
  async upload({ accountId, artifactDigest }: any) { const versionId = `version-fixture-${++providerCounter}`; providerVersions.set(versionId, artifactDigest); append("provider-upload", { versionId, artifactDigest }); return { accountId, versionId, artifactDigest }; },
  async promote({ accountId, environment, versionId }: any) { if (!providerVersions.has(versionId)) throw Error("unknown immutable version"); const deploymentId = `deployment-${environment}-${versionId}`; append("provider-promote", { environment, versionId, deploymentId }); return { accountId, environment, versionId, deploymentId }; },
  async verifyVersion({ accountId, versionId }: any) { const artifactDigest = providerVersions.get(versionId); if (!artifactDigest) throw Error("unverified rollback version"); append("provider-verify", { versionId, artifactDigest }); return { accountId, versionId, artifactDigest }; },
};
const machine = new CloudflareReleaseMachine(provider);
const credential = { provider: "cloudflare", accountId: "fixture-account", handleId: "credential-handle-fixture", generation: "1", destinations: ["preview", "staging", "production"] };
const pins = (manifestDigest: string) => ({ gitSha: "1".repeat(40), manifestDigest, bindingsDigest: "2".repeat(64), migrationsDigest: "3".repeat(64) });
const priorBytes = new TextEncoder().encode("prior fixture worker");
const prior = await machine.upload({ releaseId: "release-prior", artifact: priorBytes, pins: pins("4".repeat(64)), credential });
for (const env of ["preview", "staging", "production"] as const) await machine.promote(env);
const priorVersionId = prior.providerVersionId;

const admitted = new Map<string, string>();
const inbound = new Map<string, { digest: string; occurrenceId: string }>();
const receipts: any[] = [];
let contractGeneration = 0;
let contractStatus = "absent";
let currentCredential = 0;
let currentVersion = "";
const projections: any[] = [];
const workerRows: any[] = [];
const neuronFences: any[] = [];
const compensations: any[] = [];
let sends = 0, readbacks = 0;
const callbackBodies = new Map<string, string>();

const ports: any = {
  contract: {
    async requireAuthorizedOccurrence(a: any) { if (!a.approved || a.occurrenceId !== scenario.authority.occurrenceId || a.approvalId !== scenario.authority.approvalId) throw Error("unauthorized occurrence"); append("authority-read", { occurrenceId: a.occurrenceId, approvalId: a.approvalId }); },
    async admitManifest(x: any) { if (admitted.has(x.digest)) throw Error("manifest already admitted"); admitted.set(x.digest, x.occurrenceId); append("manifest-admitted", { digest: x.digest, occurrenceId: x.occurrenceId }); return { admitted: true, digest: x.digest }; },
    async recordReceipt(r: any) { if (r.liveDeploymentClaim !== false || !r.providerVersionId) throw Error("non-immutable receipt"); receipts.push(structuredClone(r)); append("release-receipt", { operation: r.operation, environment: r.environment, providerVersionId: r.providerVersionId, artifactDigest: r.artifactDigest, liveDeploymentClaim: r.liveDeploymentClaim }); },
    async adoptInbound(x: any) { if (x.endpointGeneration !== contractGeneration || x.credentialGeneration !== currentCredential || contractStatus !== "active") throw Error("inbound generation fenced"); const old = inbound.get(x.identity); if (old) { if (old.digest !== x.requestDigest) throw Error("delivery identity conflict: changed bytes"); append("inbound-adopted", { occurrenceId: old.occurrenceId, disposition: "adopted" }); return { disposition: "adopted", occurrenceId: old.occurrenceId }; } const occurrenceId = `occ-inbound-${inbound.size + 1}`; inbound.set(x.identity, { digest: x.requestDigest, occurrenceId }); append("inbound-accepted", { occurrenceId, identity: x.identity, requestDigest: x.requestDigest }); return { disposition: "accepted", occurrenceId }; },
    async transition(x: any) { if (x.expectedGeneration !== contractGeneration || x.nextGeneration !== contractGeneration + 1) throw Error("Contract generation CAS conflict"); contractGeneration = x.nextGeneration; contractStatus = x.status; currentCredential = x.credentialGeneration; currentVersion = x.releaseVersionId; append("contract-transition", { mutation: x }); },
  },
  release: {
    async upload(x: any) { const r = await machine.upload({ releaseId: `release-${x.endpointId}-${x.generation}`, artifact: x.artifact, pins: pins(x.manifestDigest), credential }); if (r.artifactDigest !== x.artifactDigest) throw Error("release artifact mismatch"); return r; },
    async promote(x: any) { return machine.promote(x.environment); },
    async rollback(x: any) { return machine.rollback(x.priorVersionId); },
  },
  smithers: { async projectGeneration(x: any) { projections.push(structuredClone(x)); append("smithers-generation", x); } },
  worker: { async applyGeneration(x: any) { if (workerRows.length && x.generation !== workerRows.at(-1).generation + 1) throw Error("Worker generation gap"); workerRows.push(structuredClone(x)); contractGeneration = x.generation; contractStatus = x.status; currentCredential = x.credentialGeneration; currentVersion = x.providerVersionId; append("worker-generation", x); return { url: `https://fixture.invalid/hooks/${x.endpointId}/g/${x.generation}`, generation: x.generation }; } },
  neuron: {
    async assertAdmittedLimb(x: any) { if (x.name !== "webhook" || x.packageDigest !== admittedLimbDigest || !admitted.has(x.manifestDigest)) throw Error("outbound limb package was not digest-admitted"); append("neuron-limb-admitted", x); },
    async invoke(x: any) { sends++; callbackBodies.set(x.effectId, x.bodyDigest); append("neuron-crossed", { effectId: x.effectId, generation: x.generation, bodyDigest: x.bodyDigest }); return { effectId: x.effectId, crossed: true }; },
    async readCallback(x: any) { readbacks++; const bodyDigest = callbackBodies.get(x.effectId); if (!bodyDigest) throw Error("independent callback absent"); append("neuron-readback", { effectId: x.effectId, bodyDigest }); return { effectId: x.effectId, bodyDigest, status: "acknowledged" }; },
    async fenceGeneration(x: any) { neuronFences.push(structuredClone(x)); append("neuron-fence", x); },
    async compensate(x: any) { if (x.replayCrossed !== false) throw Error("crossed effect replay requested"); compensations.push(structuredClone(x)); append("neuron-compensation-diff", x); },
  },
};

// Authorization failure happens before provider upload: prompt text is not authority.
const artifact = new TextEncoder().encode("fixture worker artifact v1");
const artifactDigest = hash(artifact);
const outboundBytes = JSON.stringify(scenario.outboundBody);
const outboundDigest = hash(outboundBytes);
const limbFiles = ["SKILL.md", "neuron.json", "boundary.py", "neurons/webhook.py", "schemas/neuron.webhook-plan.v1.json", "schemas/neuron.webhook-request.v1.json"].sort();
const limbHash = createHash("sha256");
for (const file of limbFiles) { limbHash.update(file); limbHash.update("\0"); limbHash.update(readFileSync(resolve(repo, "neuron/limbs/webhook", file))); }
const limbDigest = limbHash.digest("hex");
const admittedLimbDigest = limbDigest;
append("limb-admission-pin", { name: "webhook", packageDigest: limbDigest });
await expectReject(() => workflow.wireWebhook({ authority: { ...scenario.authority, approved: false }, endpointId: scenario.endpointId, generation: 1, credentialGeneration: 1, manifest, artifact, artifactDigest }, ports), "approval-before-infrastructure");
const uploadsBefore = readRows().filter((r: any) => r.kind === "provider-upload").length;

const wired = await workflow.wireWebhook({ authority: scenario.authority, endpointId: scenario.endpointId, generation: 1, credentialGeneration: 1, manifest, artifact, artifactDigest, outbound: { effectId: "effect-fixture-0001", bodyDigest: outboundDigest, callbackBodyDigest: outboundDigest, limbDigest } }, ports);
if (wired.liveDeploymentClaim !== false || sends !== 1 || readbacks !== 1) throw Error("wire/correlation invariant failed");
const state1 = { endpointId: wired.endpointId, generation: 1, credentialGeneration: 1, status: "active", manifestDigest: wired.manifestDigest, releaseVersionId: wired.providerVersionId, workerGeneration: 1 };
const raw = JSON.stringify(scenario.deliveryBody);
const requestDigest = hash(raw);
const delivery = { authority: scenario.authority, state: state1, deliveryId: scenario.deliveryId, requestDigest, body: scenario.deliveryBody };
const first = await workflow.adoptInbound(delivery, ports);
const duplicate = await workflow.adoptInbound(delivery, ports);
if (first.disposition !== "accepted" || duplicate.disposition !== "adopted" || first.occurrenceId !== duplicate.occurrenceId || inbound.size !== 1) throw Error("inbound exact-once adoption failed");
await expectReject(() => workflow.adoptInbound({ ...delivery, requestDigest: "9".repeat(64) }, ports), "same-delivery-changed-bytes-conflict");

let state: any = state1;
state = await workflow.mutateWebhook(state, { kind: "rotate", expectedGeneration: 1, credentialGeneration: 2 }, scenario.authority, ports);
await expectReject(() => workflow.adoptInbound(delivery, ports), "old-generation-inbound-fenced");
state = await workflow.mutateWebhook(state, { kind: "rollback", expectedGeneration: 2, priorVersionId }, scenario.authority, ports);
state = await workflow.mutateWebhook(state, { kind: "pause", expectedGeneration: 3 }, scenario.authority, ports);
state = await workflow.mutateWebhook(state, { kind: "revoke", expectedGeneration: 4 }, scenario.authority, ports);
state = await workflow.mutateWebhook(state, { kind: "invalidate", expectedGeneration: 5, sourceDigest: "8".repeat(64) }, scenario.authority, ports);
if (state.generation !== 6 || state.status !== "revoked") throw Error("mutation generation/status mismatch");
if (sends !== 1 || readbacks !== 1 || compensations.length !== 5 || compensations.some(x => x.replayCrossed !== false)) throw Error("crossed effect replayed instead of diff/compensation");
for (const generations of [projections, workerRows]) if (generations.map((x: any) => x.generation).join(",") !== "1,2,3,4,5,6") throw Error("generation propagation gap");
if (neuronFences.map(x => x.generation).join(",") !== "2,3,4,5,6") throw Error("Neuron fence propagation gap");
if (receipts.some(r => r.liveDeploymentClaim !== false)) throw Error("synthetic fixture claimed live deploy");
const uploadsAfter = readRows().filter((r: any) => r.kind === "provider-upload").length;
if (uploadsAfter - uploadsBefore !== 1) throw Error("endpoint release did not upload exactly one immutable artifact");

const result = { schema: "aiko.webhook-self-wiring.fixture-result.v1", emptyState: true, authorizedBeforeInfrastructure: true, manifestDigest: wired.manifestDigest, providerVersionId: wired.providerVersionId, inboundOccurrenceId: first.occurrenceId, inboundOccurrences: inbound.size, outboundSends: sends, independentReadbacks: readbacks, finalGeneration: state.generation, finalStatus: state.status, generationDiff: projections.map((x: any) => ({ generation: x.generation, credentialGeneration: x.credentialGeneration, status: x.status, providerVersionId: x.providerVersionId })), compensations: compensations.length, replayedCrossedEffects: 0, liveDeploymentClaim: false, journalDigest: hash(readFileSync(journal)) };
writeFileSync(join(stateDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
