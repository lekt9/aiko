import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  CROSS_JOURNAL_RETENTION_SCHEMA, compactSessionCitations, projectCrossJournalRetention,
  requireCompactionEquivalence, requireCrossJournalCollectible,
} from "../src/contractRetention.js";

const d = (n) => n.toString(16).padStart(64, "0");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const sha = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const kinds = {
  contract: ["root", "descendant", "lease", "settlement", "citation"],
  neuron: ["firing", "source_citation", "package_generation", "attachment_generation", "revocation_generation", "effect_outbox", "provider_receipt", "dlq_attempt", "requeue_lineage", "compensation_gap"],
  smithers: ["contract_root", "contract_occurrence", "contract_execution", "contract_attempt_fence", "cell_package", "cell_manifest", "graph", "input", "source", "node", "limb", "attachment", "credential", "firing", "effect", "contract_journal_position", "neuron_journal_position"],
  cloudflare: ["endpoint_manifest", "endpoint_generation", "verifier_key_generation", "verification_evidence", "queue_delivery", "retry_attempt", "dlq_attempt", "destination_audience", "reconciliation", "artifact", "provider_version", "environment_promotion", "rollback_target", "receipt"],
};
function fixture(live = false) {
  let ordinal = 1;
  const pins = (layer) => kinds[layer].map((kind) => ({ kind, reference: `${layer}/${kind}/${ordinal}`, commitOrdinal: ordinal, digest: d(ordinal++), retained: live && kind === (layer === "cloudflare" ? "queue_delivery" : layer === "neuron" ? "compensation_gap" : layer === "contract" ? "lease" : "effect"), state: "settled" }));
  const retainedPins = pins("contract");
  const entries = pins("neuron");
  const smithersPins = pins("smithers");
  const edgeEntries = pins("cloudflare");
  const identity = { generation: 3, sourceVersion: 9, headDigest: d(99), headCommitOrdinal: 98 };
  return {
    contractArchive: { checkpoint: { ...identity, checkpointDigest: sha(identity), atomic: true, recovered: true }, retainedPins },
    neuronProjection: { schema: "neuron.retention-projection/v1", entries },
    smithersProjection: { schema: "smithers.retention-projection/v1", complete: true, quarantined: [], pins: smithersPins },
    cloudflareProjection: { schema: "aiko.cloudflare-retention.v1", entries: edgeEntries },
  };
}

describe("cross-journal retention compaction", () => {
  test("joins all durable semantic families as digest+ordinal citations only", () => {
    const projection = projectCrossJournalRetention(fixture());
    expect(projection.schema).toBe(CROSS_JOURNAL_RETENTION_SCHEMA);
    expect(projection.concreteWorkerEmissionClaim).toBe(false);
    expect(projection.entries).toHaveLength(Object.values(kinds).flat().length);
    expect(projection.projectionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(projection)).not.toMatch(/prompt|transcript|rawBody|secretValue|providerLog/);
    expect(requireCrossJournalCollectible(projection)).toBe(true);
  });

  test("every live Contract lease, Smithers effect, Neuron compensation and Cloudflare delivery refuses GC", () => {
    const projection = projectCrossJournalRetention(fixture(true));
    for (const ref of ["contract/lease/3", "neuron/compensation_gap/15", "smithers/effect/30", "cloudflare/queue_delivery/37"]) {
      expect(() => requireCrossJournalCollectible(projection, ref)).toThrow("blocks collection");
    }
    expect(() => requireCrossJournalCollectible(projection)).toThrow("blocks collection");
  });

  test("missing families, unconfirmed cross-pins, checkpoint tamper and projection tamper fail closed", () => {
    const missing = fixture(); missing.cloudflareProjection.entries.pop();
    expect(() => projectCrossJournalRetention(missing)).toThrow("missing cloudflare retention family");
    const orphan = fixture(); orphan.smithersProjection.complete = false;
    expect(() => projectCrossJournalRetention(orphan)).toThrow("not authority-confirmed");
    const checkpoint = fixture(); checkpoint.contractArchive.checkpoint.headDigest = d(100);
    expect(() => projectCrossJournalRetention(checkpoint)).toThrow("checkpoint digest mismatch");
    const projection = structuredClone(projectCrossJournalRetention(fixture())); projection.entries[0].digest = d(111);
    expect(() => requireCrossJournalCollectible(projection)).toThrow("projection digest mismatch");
  });

  test("session compaction retains citation IDs only", () => {
    expect(compactSessionCitations(["contract/citation/7", "neuron/firing/8"])).toEqual({ schema: "contract.session-citations/v1", citationIds: ["contract/citation/7", "neuron/firing/8"], contentRetained: false });
    expect(() => compactSessionCitations(["prompt/raw/session"])).toThrow("citation IDs only");
    expect(() => compactSessionCitations([{ citationId: "contract/citation/7", prompt: "leak" }])).toThrow("citation IDs only");
  });

  test("context citations and redrive verdicts are equivalent or compaction refuses", () => {
    const context = [{ citationDigest: d(3), commitOrdinal: 3, field: "answer", value: "42", archived: false }];
    const redrive = [{ reference: "neuron/firing/4", commitOrdinal: 4, digest: d(4), verdict: "compensate", payload: "not retained" }];
    expect(requireCompactionEquivalence({ contextBefore: context, contextAfter: [{ ...context[0], archived: true }], redriveBefore: redrive, redriveAfter: redrive })).toBe(true);
    expect(() => requireCompactionEquivalence({ contextBefore: context, contextAfter: [{ ...context[0], value: "43" }], redriveBefore: redrive, redriveAfter: redrive })).toThrow("context changed");
    expect(() => requireCompactionEquivalence({ contextBefore: context, contextAfter: context, redriveBefore: redrive, redriveAfter: [{ ...redrive[0], verdict: "redrive" }] })).toThrow("redrive verdict changed");
  });
});
