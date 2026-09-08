import { mediaLifecycleBudgets } from "./harness-media.ts";
import { harnessDigest, type HarnessBlobStore, type HarnessDigest, type HarnessJson } from "./harness-library.ts";
import { sandboxArtifactDependencies, sandboxDigest, verifySandboxReceipt, type SandboxJob, type SandboxJobReceipt } from "./sandbox-job.ts";
import type { MediaHarnessConfig, MediaReference } from "./harness-media.ts";

/** The transport must be the trusted separate-compute SandboxJob transport, with
 * its durable claim/receipt journal. Never wire a browser-vault transport here. */
export interface MediaEvidenceBinding {
  owner: string;
  blobs: HarnessBlobStore;
  sourceCode: string;
  runtimeLockDigest: HarnessDigest;
  environmentDigest: HarnessDigest;
  contextRef: string;
  authorityRef: string;
  authorize(signal: AbortSignal): Promise<boolean>;
  assets(input: HarnessJson, signal: AbortSignal): Promise<NonNullable<SandboxJob["assets"]>>;
  execute(job: SandboxJob, signal: AbortSignal): Promise<SandboxJobReceipt>;
}

/** Practical reference inspection for arbitrary owned media. The checker has its
 * own immutable source and receipts; candidate output cannot select its code.
 * Private HMAC refs, rather than guessable content hashes, form operation IDs. */
export function createMediaEvidence(binding: MediaEvidenceBinding): Pick<MediaHarnessConfig, "reference" | "decodeFrame"> & { evidenceDigest: HarnessDigest } {
  binding = { ...binding }; // Capture source/lock identities; authorization closures remain live.
  const authorize = async (signal: AbortSignal) => { signal.throwIfAborted(); if (!await binding.authorize(signal)) throw Error("Media inspector authority unavailable"); signal.throwIfAborted(); };
  if (!binding.sourceCode.trim()) throw Error("Media inspector source missing");
  const evidenceDigest = harnessDigest(["media-physical-inspector/v1", binding.sourceCode, binding.runtimeLockDigest]);
  const inspect = async (input: Record<string, unknown>, assets: NonNullable<SandboxJob["assets"]>, signal: AbortSignal) => {
    await authorize(signal);
    const artifact = { kind: "python" as const, entry: "evidence.py", modules: { "evidence.py": { source: binding.sourceCode, digest: await sandboxDigest(binding.sourceCode) } }, runtimeLockDigest: binding.runtimeLockDigest };
    const dependencyLock = sandboxArtifactDependencies(artifact);
    const identity = await binding.blobs.putPrivate(binding.owner, { input, assets, evidenceDigest, contextRef: binding.contextRef, authorityRef: binding.authorityRef });
    const job: SandboxJob = {
      version: 1, owner: binding.owner, operationId: `media-evidence:${identity.slice(7)}`, contextRef: binding.contextRef, authorityRef: binding.authorityRef,
      artifact, harnessDigest: await sandboxDigest(artifact), dependencyLock, dependencyLockDigest: await sandboxDigest(dependencyLock), environmentDigest: binding.environmentDigest,
      input, assets, authority: { origins: [], methods: [] }, budget: { wallMs: mediaLifecycleBudgets.jobWallMs, requests: 0, outputBytes: 1048576, memoryBytes: 2147483648, processes: 64, scratchBytes: 67108864 },
    };
    await authorize(signal);
    const receipt = await verifySandboxReceipt(job, await binding.execute(job, signal));
    await authorize(signal);
    if (receipt.status !== "completed") throw Error("Physical media inspection unavailable; inspect retained job, never replace identity");
    return receipt.output;
  };
  return {
    evidenceDigest,
    reference: async (capability, input, signal) => {
      const modes = { "media.probe": "probe", "media.frames": "frames", "media.transcribe": "transcribe" };
      await authorize(signal);
      const assets = await binding.assets(input, signal);
      await authorize(signal);
      return await inspect({ ...(input as object), mode: modes[capability] }, assets, signal) as MediaReference;
    },
    decodeFrame: async (data, signal) => {
      if (typeof data !== "string" || data.length > 262144 || Buffer.from(data, "base64").toString("base64") !== data) throw Error("Invalid frame bytes");
      return await inspect({ mode: "pixels", asset: "frame.jpg" }, { "frame.jpg": { data, bytes: Buffer.from(data, "base64").length, digest: await sandboxDigest(data) } }, signal) as Awaited<ReturnType<MediaHarnessConfig["decodeFrame"]>>;
    },
  };
}
