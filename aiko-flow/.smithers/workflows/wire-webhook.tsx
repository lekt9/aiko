// smithers-source: covenant
// smithers-display-name: Wire Contract Webhook
// smithers-description: Admit, release, fence, and correlate a bounded webhook endpoint without ambient infrastructure authority.
/** @jsxImportSource smthrs */
import { createHash } from "node:crypto";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { ContractCell } from "../../packages/components/src/components/ContractCell.js";
import { sealEndpointManifest, canonicalJson } from "../../packages/cloudflare-webhook/src/manifest.ts";

const HEX = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const sha = (value: unknown) => createHash("sha256").update(value instanceof Uint8Array ? value : typeof value === "string" ? value : canonicalJson(value)).digest("hex");
function refuse(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export type Authority = Readonly<{
  occurrenceId: string; authenticatedSubject: string; verifiedTenant: string;
  grantedScopes: readonly string[]; approved: true; approvalId: string;
}>;
export type EndpointState = Readonly<{
  endpointId: string; generation: number; credentialGeneration: number;
  status: "active" | "paused" | "revoked" | "invalidated";
  manifestDigest: string; releaseVersionId: string; workerGeneration: number;
}>;
export type WiringPorts = Readonly<{
  contract: {
    requireAuthorizedOccurrence(authority: Authority): Promise<void>;
    admitManifest(input: unknown): Promise<{ admitted: true; digest: string }>;
    recordReceipt(receipt: unknown): Promise<void>;
    adoptInbound(input: unknown): Promise<{ disposition: "accepted" | "adopted"; occurrenceId: string }>;
    transition(input: unknown): Promise<void>;
  };
  release: {
    upload(input: unknown): Promise<{ providerVersionId: string; artifactDigest: string; liveDeploymentClaim: false }>;
    promote(input: unknown): Promise<{ providerVersionId: string; environment: string; deploymentId: string; liveDeploymentClaim: false }>;
    rollback(input: unknown): Promise<{ providerVersionId: string; environment: "production"; liveDeploymentClaim: false }>;
  };
  smithers: { projectGeneration(input: unknown): Promise<void> };
  worker: { applyGeneration(input: unknown): Promise<{ url: string; generation: number }> };
  neuron: {
    assertAdmittedLimb(input: unknown): Promise<void>;
    invoke(input: unknown): Promise<{ effectId: string; crossed: true }>;
    readCallback(input: unknown): Promise<{ effectId: string; bodyDigest: string; status: "acknowledged" }>;
    fenceGeneration(input: unknown): Promise<void>;
    compensate(input: unknown): Promise<void>;
  };
}>;

export type WireRequest = Readonly<{
  authority: Authority; endpointId: string; generation: number; credentialGeneration: number;
  manifest: unknown; artifact: Uint8Array; artifactDigest: string;
  outbound?: Readonly<{ effectId: string; bodyDigest: string; callbackBodyDigest: string; limbDigest: string }>;
}>;

function checkAuthority(a: Authority) {
  refuse(a && a.approved === true, "authorized Contract approval is required before infrastructure");
  for (const field of [a.occurrenceId, a.authenticatedSubject, a.verifiedTenant, a.approvalId]) refuse(typeof field === "string" && id.test(field), "authority is malformed");
  refuse(a.grantedScopes.includes("webhook:provision"), "webhook:provision scope is required");
}

/**
 * Deterministic orchestration kernel used by the Smithers cells below. Ports are
 * the already-admitted Contract/Cloudflare/Worker/Neuron surfaces; this module
 * never reads credentials and never turns prompt text into infrastructure authority.
 */
export async function wireWebhook(request: WireRequest, ports: WiringPorts) {
  checkAuthority(request.authority);
  refuse(request.generation === 1 && request.credentialGeneration === 1, "initial generations must begin at one");
  refuse(request.artifact instanceof Uint8Array && request.artifact.byteLength > 0, "immutable artifact bytes are required");
  refuse(HEX.test(request.artifactDigest) && sha(request.artifact) === request.artifactDigest, "artifact digest mismatch");
  await ports.contract.requireAuthorizedOccurrence(request.authority); // first external call

  const pin = await sealEndpointManifest(request.manifest);
  refuse(pin.manifest.endpointId === request.endpointId, "manifest endpoint mismatch");
  refuse(Number(pin.manifest.endpointGeneration) === request.generation, "manifest generation mismatch");
  refuse(Number(pin.manifest.credential.generation) === request.credentialGeneration, "credential generation mismatch");
  const admission = await ports.contract.admitManifest({ occurrenceId: request.authority.occurrenceId, approvalId: request.authority.approvalId, manifest: pin.manifest, digest: pin.digest });
  refuse(admission.admitted === true && admission.digest === pin.digest, "Contract manifest admission read-back mismatch");

  const upload = await ports.release.upload({ endpointId: request.endpointId, generation: request.generation, manifestDigest: pin.digest, artifact: request.artifact, artifactDigest: request.artifactDigest });
  refuse(upload.liveDeploymentClaim === false && upload.artifactDigest === request.artifactDigest && id.test(upload.providerVersionId), "immutable upload receipt mismatch");
  await ports.contract.recordReceipt(upload);
  let production: Awaited<ReturnType<WiringPorts["release"]["promote"]>> | undefined;
  for (const environment of ["preview", "staging", "production"] as const) {
    const receipt = await ports.release.promote({ providerVersionId: upload.providerVersionId, environment });
    refuse(receipt.liveDeploymentClaim === false && receipt.providerVersionId === upload.providerVersionId && receipt.environment === environment, "promotion changed immutable version");
    await ports.contract.recordReceipt(receipt);
    production = receipt;
  }
  refuse(production, "production receipt missing");
  const worker = await ports.worker.applyGeneration({ endpointId: request.endpointId, generation: request.generation, credentialGeneration: request.credentialGeneration, manifestDigest: pin.digest, providerVersionId: upload.providerVersionId, status: "active" });
  refuse(worker.generation === request.generation && /^https:\/\//.test(worker.url), "Worker generation read-back mismatch");
  await ports.smithers.projectGeneration({ endpointId: request.endpointId, generation: request.generation, credentialGeneration: request.credentialGeneration, workerGeneration: worker.generation, manifestDigest: pin.digest, providerVersionId: upload.providerVersionId, status: "active" });

  let outbound: undefined | { effectId: string; callbackDigest: string };
  if (request.outbound) {
    refuse(HEX.test(request.outbound.bodyDigest) && request.outbound.bodyDigest === request.outbound.callbackBodyDigest, "callback pin differs from outbound body");
    refuse(HEX.test(request.outbound.limbDigest), "outbound limb digest pin is required");
    await ports.neuron.assertAdmittedLimb({ name: "webhook", packageDigest: request.outbound.limbDigest, manifestDigest: pin.digest });
    const crossing = await ports.neuron.invoke({ ...request.outbound, endpointId: request.endpointId, generation: request.generation, credentialGeneration: request.credentialGeneration });
    refuse(crossing.crossed === true && crossing.effectId === request.outbound.effectId, "outbound boundary did not durably cross");
    const callback = await ports.neuron.readCallback({ effectId: crossing.effectId });
    refuse(callback.status === "acknowledged" && callback.effectId === crossing.effectId && callback.bodyDigest === request.outbound.bodyDigest, "independent callback/read-back correlation failed");
    outbound = { effectId: crossing.effectId, callbackDigest: sha(callback) };
  }
  return Object.freeze({ endpointId: request.endpointId, generation: request.generation, credentialGeneration: request.credentialGeneration, manifestDigest: pin.digest, providerVersionId: upload.providerVersionId, url: worker.url, liveDeploymentClaim: false as const, outbound });
}

export async function adoptInbound(input: Readonly<{ authority: Authority; state: EndpointState; deliveryId: string; requestDigest: string; body: unknown }>, ports: WiringPorts) {
  checkAuthority(input.authority);
  refuse(input.state.status === "active", "inactive endpoint generation is fenced");
  refuse(HEX.test(input.requestDigest), "raw request digest is required");
  await ports.contract.requireAuthorizedOccurrence(input.authority);
  return ports.contract.adoptInbound({
    identity: sha({ tenant: input.authority.verifiedTenant, endpointId: input.state.endpointId, endpointGeneration: input.state.generation, deliveryId: input.deliveryId }),
    endpointId: input.state.endpointId, endpointGeneration: input.state.generation,
    credentialGeneration: input.state.credentialGeneration, deliveryId: input.deliveryId,
    requestDigest: input.requestDigest, body: input.body,
  });
}

export type Mutation = Readonly<{ kind: "rotate" | "pause" | "revoke" | "rollback" | "invalidate"; expectedGeneration: number; credentialGeneration?: number; priorVersionId?: string; sourceDigest?: string }>;
export async function mutateWebhook(state: EndpointState, mutation: Mutation, authority: Authority, ports: WiringPorts): Promise<EndpointState> {
  checkAuthority(authority);
  await ports.contract.requireAuthorizedOccurrence(authority);
  refuse(state.generation === mutation.expectedGeneration, "stale mutation generation");
  refuse(state.status !== "revoked" || mutation.kind === "invalidate", "revocation is terminal");
  const nextGeneration = state.generation + 1;
  let status: EndpointState["status"] = state.status;
  let credentialGeneration = state.credentialGeneration;
  let releaseVersionId = state.releaseVersionId;
  if (mutation.kind === "rotate") {
    refuse(state.status === "active" && mutation.credentialGeneration === state.credentialGeneration + 1, "rotation must advance credential exactly once");
    credentialGeneration = mutation.credentialGeneration!;
  } else if (mutation.kind === "pause") { refuse(state.status === "active", "only active endpoint can pause"); status = "paused"; }
  else if (mutation.kind === "revoke") status = "revoked";
  else if (mutation.kind === "invalidate") { refuse(HEX.test(mutation.sourceDigest ?? ""), "source invalidation needs digest"); status = state.status === "revoked" ? "revoked" : "invalidated"; }
  else {
    refuse(typeof mutation.priorVersionId === "string", "rollback target required");
    const receipt = await ports.release.rollback({ priorVersionId: mutation.priorVersionId });
    refuse(receipt.liveDeploymentClaim === false && receipt.environment === "production", "rollback receipt invalid");
    await ports.contract.recordReceipt(receipt); releaseVersionId = receipt.providerVersionId;
  }
  await ports.contract.transition({ kind: mutation.kind, endpointId: state.endpointId, expectedGeneration: state.generation, nextGeneration, credentialGeneration, status, releaseVersionId, sourceDigest: mutation.sourceDigest });
  await ports.worker.applyGeneration({ endpointId: state.endpointId, generation: nextGeneration, credentialGeneration, status, manifestDigest: state.manifestDigest, providerVersionId: releaseVersionId });
  await ports.smithers.projectGeneration({ endpointId: state.endpointId, generation: nextGeneration, credentialGeneration, workerGeneration: nextGeneration, status, manifestDigest: state.manifestDigest, providerVersionId: releaseVersionId });
  await ports.neuron.fenceGeneration({ endpointId: state.endpointId, generation: nextGeneration, credentialGeneration, status });
  // Crossed logical effects are diffed/compensated, never invoked again.
  await ports.neuron.compensate({ endpointId: state.endpointId, supersededGeneration: state.generation, replacementGeneration: nextGeneration, reason: mutation.kind, replayCrossed: false });
  return Object.freeze({ ...state, generation: nextGeneration, workerGeneration: nextGeneration, credentialGeneration, releaseVersionId, status });
}

const inputSchema = z.object({ driver: z.custom<any>(), authority: z.custom<Authority>(), declaration: z.record(z.string(), z.unknown()) });
const signalSchema = z.object({ phase: z.string(), occurrenceId: z.string() }).passthrough();
const { Workflow, Sequence, smithers } = createSmithers({ input: inputSchema, signal: signalSchema });
export default smithers((ctx) => (
  <Workflow name="wire-webhook">
    <Sequence>
      <ContractCell id="authorize" driver={ctx.input.driver} signal={{ phase: "authorize", occurrenceId: ctx.input.authority.occurrenceId }} />
      <ContractCell id="admit" driver={ctx.input.driver} signal={{ phase: "manifest-admit", occurrenceId: ctx.input.authority.occurrenceId }} />
      <ContractCell id="release" driver={ctx.input.driver} signal={{ phase: "immutable-release", occurrenceId: ctx.input.authority.occurrenceId }} />
      <ContractCell id="activate" driver={ctx.input.driver} signal={{ phase: "generation-activate", occurrenceId: ctx.input.authority.occurrenceId }} />
      <ContractCell id="correlate" driver={ctx.input.driver} signal={{ phase: "outbox-readback", occurrenceId: ctx.input.authority.occurrenceId }} />
    </Sequence>
  </Workflow>
));
