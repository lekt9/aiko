import { describe, expect, test } from "bun:test";
import {
  SMITHERS_RETENTION_SCHEMA,
  compactSettledProjection,
  projectContractRetention,
  requireLocalCollectible,
} from "../src/contractRetentionProjection.js";

const kinds = [
  ["contractRootRef", "contract"], ["contractOccurrenceRef", "contract"],
  ["contractExecutionRef", "contract"], ["contractAttemptFenceRef", "contract"],
  ["cellPackageRef", "contract"], ["cellManifestRef", "contract"],
  ["graphRef", "contract"], ["inputRef", "contract"], ["sourceRef", "neuron"],
  ["nodeRef", "contract"], ["limbRef", "neuron"], ["attachmentRef", "neuron"],
  ["credentialRef", "neuron"], ["firingRef", "neuron"], ["effectRef", "neuron"],
  ["contractJournalRef", "contract"], ["neuronJournalRef", "neuron"],
];

function fixture(runState = "active") {
  const driverDescriptor = { retention: {} };
  const recoveryDescriptor = { refs: {} };
  const records = new Map();
  kinds.forEach(([name, authority], index) => {
    const pin = {
      reference: `${authority}/${name}/${index + 1}`,
      commitOrdinal: index + 1,
      digest: (index + 1).toString(16).padStart(64, "0"),
    };
    (index % 2 ? recoveryDescriptor.refs : driverDescriptor.retention)[name] = pin;
    records.set(pin.reference, { ...pin, state: "settled", verdict: authority === "contract" ? "contract-valid" : "redrive" });
  });
  const read = async (pin) => records.get(pin.reference);
  return { driverDescriptor, recoveryDescriptor, runState, contractReader: read, neuronReader: read, records };
}

function args(f) {
  return {
    driverDescriptor: f.driverDescriptor, recoveryDescriptor: f.recoveryDescriptor,
    runState: f.runState, contractReader: f.contractReader, neuronReader: f.neuronReader,
  };
}

describe("Smithers cross-journal retention projection", () => {
  test("projects every descriptor/Cell/graph/limb/effect/journal family as pins only", async () => {
    const f = fixture();
    const projection = await projectContractRetention(args(f));
    expect(projection.schema).toBe(SMITHERS_RETENTION_SCHEMA);
    expect(projection.pins).toHaveLength(kinds.length);
    expect(projection.quarantined).toEqual([]);
    expect(projection.complete).toBe(true);
    expect(projection.blocksLocalGc).toBe(true);
    const encoded = JSON.stringify(projection);
    for (const forbidden of ["prompt", "transcript", "secret", "rawResult", "payload"]) expect(encoded).not.toContain(`\"${forbidden}\"`);
    expect(Object.keys(projection.pins[0]).sort()).toEqual(["authority", "commitOrdinal", "digest", "kind", "reference"].sort());
  });

  test("mutation: omitting any semantic family is an exact hard failure", async () => {
    for (const [name] of kinds) {
      const f = fixture();
      delete f.driverDescriptor.retention[name];
      delete f.recoveryDescriptor.refs[name];
      await expect(projectContractRetention(args(f))).rejects.toThrow("missing retention pin");
    }
  });

  test("mutation: Smithers-only and mismatched hints are quarantined, never authority", async () => {
    const orphan = fixture();
    const missing = orphan.driverDescriptor.retention.contractRootRef;
    orphan.records.delete(missing.reference);
    let p = await projectContractRetention(args(orphan));
    expect(p.complete).toBe(false);
    expect(p.quarantined).toEqual([expect.objectContaining({ kind: "contract_root", reason: "smithers_orphan" })]);
    expect(p.pins.some((pin) => pin.kind === "contract_root")).toBe(false);

    const mismatch = fixture("settled");
    const firing = mismatch.recoveryDescriptor.refs.firingRef;
    mismatch.records.set(firing.reference, { ...firing, digest: "f".repeat(64) });
    p = await projectContractRetention(args(mismatch));
    expect(p.quarantined).toEqual([expect.objectContaining({ kind: "firing", reason: "authority_mismatch" })]);
    expect(() => requireLocalCollectible(p)).toThrow("unconfirmed Smithers pins");
  });

  test("mutation: descriptor identity or fence not confirmed by Contract is quarantined", async () => {
    const f = fixture("settled");
    f.driverDescriptor.rootId = "root-7";
    f.driverDescriptor.attempt = 2;
    f.driverDescriptor.fence = 41;
    let p = await projectContractRetention(args(f));
    expect(p.quarantined.map((pin) => pin.kind)).toEqual(["contract_root", "contract_attempt_fence"]);

    const root = f.driverDescriptor.retention.contractRootRef;
    const fence = f.recoveryDescriptor.refs.contractAttemptFenceRef;
    f.records.set(root.reference, { ...f.records.get(root.reference), rootId: "root-7" });
    f.records.set(fence.reference, { ...f.records.get(fence.reference), attempt: 2, fence: 41 });
    p = await projectContractRetention(args(f));
    expect(p.complete).toBe(true);
  });

  test("mutation: active run blocks local GC", async () => {
    const p = await projectContractRetention(args(fixture("active")));
    expect(() => requireLocalCollectible(p)).toThrow("active Smithers run");
    await expect(compactSettledProjection(p, {})).rejects.toThrow("active Smithers run");
  });

  test("settled compaction preserves pins and authoritative Contract/Neuron verdict", async () => {
    const f = fixture("settled");
    const p = await projectContractRetention(args(f));
    expect(requireLocalCollectible(p)).toBe(true);
    const archived = await compactSettledProjection(p, { contractReader: f.contractReader, neuronReader: f.neuronReader });
    expect(archived.runState).toBe("archived");
    expect(archived.authoritativeVerdict).toBe(p.authoritativeVerdict);
    expect(archived.pins).toEqual(p.pins);
  });

  test("mutation: changed authoritative verdict or pin refuses compaction", async () => {
    const f = fixture("settled");
    const p = await projectContractRetention(args(f));
    const effect = f.driverDescriptor.retention.effectRef ?? f.recoveryDescriptor.refs.effectRef;
    f.records.set(effect.reference, { ...f.records.get(effect.reference), verdict: "compensate" });
    await expect(compactSettledProjection(p, { contractReader: f.contractReader, neuronReader: f.neuronReader })).rejects.toThrow("verdict changed");

    const g = fixture("settled");
    const q = await projectContractRetention(args(g));
    const journal = g.driverDescriptor.retention.contractJournalRef ?? g.recoveryDescriptor.refs.contractJournalRef;
    g.records.set(journal.reference, { ...journal, commitOrdinal: journal.commitOrdinal + 1 });
    await expect(compactSettledProjection(q, { contractReader: g.contractReader, neuronReader: g.neuronReader })).rejects.toThrow("authority changed");
  });

  test("mutation: prompts, transcripts, secrets, payloads and raw results never enter retention", async () => {
    for (const [key, value] of [["prompt", "do it"], ["transcript", "words"], ["secret", "s"], ["payload", { x: 1 }], ["rawResult", "bytes"]]) {
      const f = fixture();
      f.recoveryDescriptor[key] = value;
      const projection = await projectContractRetention(args(f));
      const encoded = JSON.stringify(projection);
      expect(encoded).not.toContain(key);
      expect(encoded).not.toContain(JSON.stringify(value));
    }
  });

  test("raw authority result facts are quarantined rather than retained", async () => {
    const f = fixture("settled");
    const effect = f.driverDescriptor.retention.effectRef ?? f.recoveryDescriptor.refs.effectRef;
    f.records.set(effect.reference, { ...f.records.get(effect.reference), verdict: "provider said: secret body" });
    const p = await projectContractRetention(args(f));
    expect(p.quarantined).toEqual([expect.objectContaining({ kind: "effect", reason: "authority_mismatch" })]);
    expect(JSON.stringify(p)).not.toContain("provider said");
  });

  test("invalid digest, ordinal, reference, and duplicate pins fail closed", async () => {
    for (const [field, value, message] of [
      ["digest", "ABC", "digest"], ["commitOrdinal", 0, "ordinal"], ["reference", "contains secret?", "reference"],
    ]) {
      const f = fixture();
      f.driverDescriptor.retention.contractRootRef[field] = value;
      await expect(projectContractRetention(args(f))).rejects.toThrow(message);
    }
    const f = fixture();
    f.recoveryDescriptor.refs.contractOccurrenceRef = { ...f.driverDescriptor.retention.contractRootRef };
    await expect(projectContractRetention(args(f))).rejects.toThrow("duplicate retention pin");
  });
});
