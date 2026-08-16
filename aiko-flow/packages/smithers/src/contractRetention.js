import { createHash } from "node:crypto";

export const CROSS_JOURNAL_RETENTION_SCHEMA = "aiko.cross-journal-retention/v1";
const DIGEST = /^[0-9a-f]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const FORBIDDEN = /(?:^|[._:/-])(authorization|bearer|body|password|payload|prompt|raw|secret|session|token|transcript)(?:$|[._:/-])/i;

const REQUIRED = Object.freeze({
  contract: ["root", "descendant", "lease", "settlement", "citation"],
  smithers: ["contract_root", "contract_occurrence", "contract_execution", "contract_attempt_fence", "cell_package", "cell_manifest", "graph", "input", "source", "node", "limb", "attachment", "credential", "firing", "effect", "contract_journal_position", "neuron_journal_position"],
  neuron: ["firing", "source_citation", "package_generation", "attachment_generation", "revocation_generation", "effect_outbox", "provider_receipt", "dlq_attempt", "requeue_lineage", "compensation_gap"],
  cloudflare: ["endpoint_manifest", "endpoint_generation", "verifier_key_generation", "verification_evidence", "queue_delivery", "retry_attempt", "dlq_attempt", "destination_audience", "reconciliation", "artifact", "provider_version", "environment_promotion", "rollback_target", "receipt"],
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
}
function pin(layer, raw) {
  const source = raw?.pin ?? raw;
  const reference = source?.reference;
  const commitOrdinal = source?.commitOrdinal ?? source?.commit_ordinal;
  const digest = source?.digest;
  if (!REFERENCE.test(reference ?? "") || FORBIDDEN.test(reference)) throw new Error(`${layer} retention reference is not a secret-free citation ID`);
  if (!Number.isSafeInteger(commitOrdinal) || commitOrdinal < 1) throw new Error(`${layer} retention ordinal is invalid`);
  if (!DIGEST.test(digest ?? "")) throw new Error(`${layer} retention digest is invalid`);
  const kind = raw.kind;
  if (typeof kind !== "string") throw new Error(`${layer} retention kind is missing`);
  return { layer, kind, reference, commitOrdinal, digest, retained: raw.retained === true, state: raw.state ?? "settled" };
}
function requireFamilies(layer, pins) {
  const have = new Set(pins.map((entry) => entry.kind));
  for (const family of REQUIRED[layer]) if (!have.has(family)) throw new Error(`missing ${layer} retention family: ${family}`);
}
function checkpoint(contractArchive) {
  const cp = contractArchive?.checkpoint;
  if (!cp || cp.atomic !== true || cp.recovered !== true) throw new Error("Contract archive lacks a recovered atomic checkpoint");
  if (!Number.isSafeInteger(cp.generation) || cp.generation < 1 || !Number.isSafeInteger(cp.sourceVersion) || cp.sourceVersion < 1) throw new Error("Contract checkpoint version is invalid");
  if (!DIGEST.test(cp.headDigest ?? "") || !DIGEST.test(cp.checkpointDigest ?? "") || !Number.isSafeInteger(cp.headCommitOrdinal) || cp.headCommitOrdinal < 1) throw new Error("Contract digest+ordinal chain head is invalid");
  const identity = { generation: cp.generation, sourceVersion: cp.sourceVersion, headDigest: cp.headDigest, headCommitOrdinal: cp.headCommitOrdinal };
  if (sha(identity) !== cp.checkpointDigest) throw new Error("Contract atomic checkpoint digest mismatch");
  return identity;
}
function assertNoConflictingCrossPins(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const previous = seen.get(`${entry.layer}:${entry.reference}`);
    if (previous && (previous.digest !== entry.digest || previous.commitOrdinal !== entry.commitOrdinal)) throw new Error("cross-journal pin changed digest or ordinal");
    seen.set(`${entry.layer}:${entry.reference}`, entry);
  }
}

/**
 * Join authority-confirmed projections without copying journal payloads. The
 * Cloudflare input is intentionally an abstract projection: concrete Worker
 * emission is a later release witness, not authority for this checkpoint.
 */
export function projectCrossJournalRetention({ contractArchive, neuronProjection, smithersProjection, cloudflareProjection }) {
  const chainHead = checkpoint(contractArchive);
  if (neuronProjection?.schema !== "neuron.retention-projection/v1") throw new Error("invalid Neuron retention projection");
  if (smithersProjection?.schema !== "smithers.retention-projection/v1" || smithersProjection.complete !== true || smithersProjection.quarantined?.length) throw new Error("Smithers cross-pins are not authority-confirmed");
  if (cloudflareProjection?.schema !== "aiko.cloudflare-retention.v1") throw new Error("invalid Cloudflare retention projection");

  const groups = {
    contract: (contractArchive.retainedPins ?? []).map((entry) => pin("contract", entry)),
    neuron: (neuronProjection.entries ?? neuronProjection.pins ?? []).map((entry) => pin("neuron", entry)),
    smithers: (smithersProjection.pins ?? []).map((entry) => pin("smithers", entry)),
    cloudflare: (cloudflareProjection.entries ?? cloudflareProjection.pins ?? []).map((entry) => pin("cloudflare", entry)),
  };
  for (const [layer, entries] of Object.entries(groups)) requireFamilies(layer, entries);
  const entries = Object.values(groups).flat().sort((a, b) => a.commitOrdinal - b.commitOrdinal || a.layer.localeCompare(b.layer) || a.reference.localeCompare(b.reference));
  assertNoConflictingCrossPins(entries);
  const body = { schema: CROSS_JOURNAL_RETENTION_SCHEMA, chainHead, entries };
  return frozen({ ...body, blocksCollection: entries.some((entry) => entry.retained), projectionDigest: sha(body), concreteWorkerEmissionClaim: false });
}

export function requireCrossJournalCollectible(projection, reference) {
  const body = { schema: projection.schema, chainHead: projection.chainHead, entries: projection.entries };
  if (projection.projectionDigest !== sha(body)) throw new Error("cross-journal projection digest mismatch");
  const matches = reference === undefined ? projection.entries : projection.entries.filter((entry) => entry.reference === reference);
  if (reference !== undefined && matches.length === 0) throw new Error("unknown retention reference");
  if (matches.some((entry) => entry.retained)) throw new Error("live cross-journal reference blocks collection");
  return true;
}

/** Session/model compaction may retain stable citations, never prompt text. */
export function compactSessionCitations(citations) {
  if (!Array.isArray(citations) || citations.length === 0) throw new Error("session compaction requires citation IDs");
  const ids = citations.map((value) => {
    if (typeof value !== "string" || !REFERENCE.test(value) || FORBIDDEN.test(value)) throw new Error("session compaction accepts citation IDs only");
    return value;
  });
  if (new Set(ids).size !== ids.length) throw new Error("duplicate session citation ID");
  return frozen({ schema: "contract.session-citations/v1", citationIds: [...ids].sort(), contentRetained: false });
}

function semantic(items, fields) { return items.map((item) => fields.map((key) => item[key])).sort((a, b) => canonical(a).localeCompare(canonical(b))); }
export function requireCompactionEquivalence({ contextBefore, contextAfter, redriveBefore, redriveAfter }) {
  const contextFields = ["citationDigest", "commitOrdinal", "field", "value"];
  const redriveFields = ["reference", "commitOrdinal", "digest", "verdict"];
  if (canonical(semantic(contextBefore, contextFields)) !== canonical(semantic(contextAfter, contextFields))) throw new Error("context changed across compaction");
  if (canonical(semantic(redriveBefore, redriveFields)) !== canonical(semantic(redriveAfter, redriveFields))) throw new Error("redrive verdict changed across compaction");
  return true;
}
