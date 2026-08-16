import { createHash } from "node:crypto";

const PIN_FIELDS = [
  "rootId", "occurrenceId", "executionId", "attempt", "fence",
  "graphDigest", "nodeDigest", "inputDigest", "sourceDigest",
  "cellPackageDigest", "cellManifestDigest", "limbDigest",
  "attachmentGeneration", "credentialGeneration", "credentialScopeDigest",
  "firingId", "effectId", "verifiedSubject", "verifiedScopeDigest", "verifiedRequestDigest",
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export function descriptorDigest(descriptor) {
  return createHash("sha256").update(canonical(descriptor)).digest("hex");
}
export function pinContractDescriptor(claim) {
  const descriptor = {};
  for (const field of PIN_FIELDS) {
    const value = claim[field];
    if (value === undefined || value === null || value === "") throw new Error(`contract descriptor missing pin: ${field}`);
    descriptor[field] = value;
  }
  if (!Number.isInteger(descriptor.attempt) || descriptor.attempt < 1 || !Number.isSafeInteger(descriptor.fence) || descriptor.fence < 1) {
    throw new Error("contract descriptor has invalid attempt/fence");
  }
  descriptor.cellRequest = structuredClone(claim.cellRequest);
  descriptor.sourceRefs = structuredClone(claim.sourceRefs ?? []);
  return freeze(descriptor);
}

/**
 * Smithers is only an operational wake/lease loop. The supplied `contract`
 * adapter owns readiness, descriptors, pin revalidation and settlement. The
 * supplied native route must invoke GraphHarness' pinned Cell adapter.
 */
export function createContractDriver({ contract, graphHarnessCell, owner, leaseSeconds = 60 }) {
  if (!contract || typeof graphHarnessCell !== "function" || !owner) throw new Error("contract driver requires Contract, native GraphHarness Cell, and owner");
  let lastOrdinal = null;

  async function handleSignal(signal) {
    const ordinal = signal?.commitOrdinal;
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("frontier signal requires a positive Contract commitOrdinal");
    const signalOrder = lastOrdinal === null ? "initial" : ordinal === lastOrdinal ? "duplicate" : ordinal < lastOrdinal ? "reordered" : ordinal > lastOrdinal + 1 ? "missing" : "next";
    lastOrdinal = lastOrdinal === null ? ordinal : Math.max(lastOrdinal, ordinal);

    // Even a normal signal is only a wake-up hint. Duplicate/missing/reordered
    // signals therefore converge through the same authoritative Contract read.
    const frontier = await contract.readFrontier({ owner, observedCommitOrdinal: ordinal, signalOrder });
    const results = [];
    for (const work of frontier ?? []) {
      const claim = await contract.acquireFencedLease({ owner, leaseSeconds, workId: work.workId });
      if (!claim) continue;
      if (typeof claim.leaseId !== "string" || !claim.leaseId) throw new Error("Contract returned an unfenced lease");
      const descriptor = pinContractDescriptor(claim);
      const digest = descriptorDigest(descriptor);
      await contract.recordInvocation?.({ owner, leaseId: claim.leaseId, descriptorDigest: digest });
      // The logical effect is durable before the Cell is allowed to cross the
      // boundary. Redelivery reuses this pinned identity rather than inventing
      // a second send.
      await contract.appendEffectOutbox({ leaseId: claim.leaseId, fence: descriptor.fence, descriptorDigest: digest, effect: { effectId: descriptor.effectId, firingId: descriptor.firingId } });

      // Invocation is deliberately at-least-once. A crash here may invoke the
      // Cell again; only the fenced Contract settlement below is singular.
      const evidence = await graphHarnessCell({ descriptor, descriptorDigest: digest });
      if ((evidence.effects ?? []).some((effect) => effect.effectId !== descriptor.effectId)) {
        throw new Error("Cell reported an effect outside the pinned logical identity");
      }
      const readBack = await contract.readBackEffect({ effectId: descriptor.effectId, firingId: descriptor.firingId });
      if (!readBack?.confirmed) throw new Error(`effect read-back unconfirmed: ${descriptor.effectId}`);
      const valid = await contract.revalidatePins({ owner, leaseId: claim.leaseId, fence: descriptor.fence, descriptor, descriptorDigest: digest });
      if (!valid) {
        results.push({ workId: work.workId, status: "stale" });
        continue;
      }
      const settled = await contract.settleFenced({ owner, leaseId: claim.leaseId, fence: descriptor.fence, descriptorDigest: digest, evidence });
      results.push({ workId: work.workId, status: settled ? "settled" : "lost-fence" });
    }
    return { signalOrder, reread: true, results };
  }
  return Object.freeze({ handleSignal });
}
