import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { openMemory } from "../src/memory.ts";
import { indexLearning, memorySnapshot, type LearningInput } from "../src/learning.ts";

// Diagnostic witnesses of present semantics, not a physical-erasure acceptance gate.
const input: LearningInput = { id: "erasure-audit-001", subject: "audit/private", title: "Private audit title",
  type: "note", kind: "fact", payload: { text: "controlled-erasure-marker-81" } };
const opts = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "controlled-audit" } });

test("logical forget suppresses learning and derivatives but retains private native artifacts across SQLite restart", async () => {
  const stateDir = await mkdtemp("/tmp/learning-erasure-");
  const binding = { stateDir, owner: "123" };
  try {
    const indexed = await indexLearning(binding, input, text => text);
    let memory = openMemory(binding);
    const derived = memory.remember({ subject: "derived/audit", title: "Private derived title", type: "note",
      payload: { quote: input.payload }, supports: [indexed.observation] }, opts("derived-audit"));
    expect(memory.forget(indexed.subject, indexed.observation, "forget-audit")).toEqual({ subject: indexed.subject, forgotten: true, erased: false });
    memory.close();
    memory = openMemory(binding);
    try {
      expect(memory.get(indexed.observation)).toBeNull();
      expect(memory.get(derived.id)).toBeNull();
      expect(memory.history(indexed.subject)).toEqual([]);
      expect(memorySnapshot(binding).leaves).toEqual([]);
      expect(memory.journal.receipt(memory.scope, indexed.ingestion.readKey)?.event.observations[0]?.payload).toMatchObject({ data: input.payload });
      const archive = memory.exportArchive();
      expect(JSON.stringify(archive.artifacts)).toContain("controlled-erasure-marker-81");
      expect(JSON.stringify(archive.journal)).toContain("Private audit title");
      expect(JSON.stringify(memory.journal.events(memory.scope))).toContain("controlled-erasure-marker-81");
      memory.rebuild();
      expect(memory.get(indexed.observation)).toBeNull();
      expect(JSON.stringify(memory.exportArchive().artifacts)).toContain("controlled-erasure-marker-81");
    } finally { memory.close(); }
    await expect(indexLearning(binding, input, text => text)).rejects.toMatchObject({ code: "evidence_unavailable" });
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("correction history, dependsOn invalidation, supports history and source revocation have distinct native statuses", async () => {
  const stateDir = await mkdtemp("/tmp/learning-invalidation-");
  const binding = { stateDir, owner: "123" };
  try {
    const first = await indexLearning(binding, input, text => text);
    const memory = openMemory(binding);
    try {
      const historical = memory.remember({ subject: "audit/support", title: "Historical citation", type: "note", payload: "citation",
        supports: [first.observation] }, opts("support-audit"));
      const dependent = memory.remember({ subject: "audit/dependent", title: "Current dependency", type: "note", payload: "dependency",
        dependsOn: [first.observation] }, opts("dependency-audit"));
      const second = await indexLearning(binding, { ...input, id: "erasure-audit-002", payload: { text: "corrected" } }, text => text);
      expect(memory.get(first.observation)?.state).toBe("superseded");
      expect(memory.get(dependent.id)?.freshness).toBe("stale");
      expect(memory.get(historical.id)?.state).toBe("current");
      expect(memory.get(historical.id)?.freshness).not.toBe("stale");
      expect(JSON.stringify(memory.exportArchive().artifacts)).toContain("controlled-erasure-marker-81");
      const source = memory.sources()[0]!;
      memory.approveSource(source.id, source.revision, false, "revoke-audit");
      expect(memory.get(second.observation)).toMatchObject({ state: "current", freshness: "stale" });
      // Native head status remains current; the host semantic snapshot now excludes stale evidence.
      expect(memorySnapshot(binding).leaves.some(leaf => leaf.observation === second.observation)).toBe(false);
    } finally { memory.close(); }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("explicit native scope erasure removes indexed private payload and metadata and blocks learning replay after restart", async () => {
  const stateDir = await mkdtemp("/tmp/learning-scope-erasure-");
  const binding = { stateDir, owner: "123" };
  try {
    const indexed = await indexLearning(binding, input, text => text);
    let memory = openMemory(binding);
    const version = memory.journal.scopeVersion(memory.scope);
    expect(memory.eraseScope(version, "authorized-scope-erasure")).toMatchObject({ erased: true, retired: true });
    memory.close();
    memory = openMemory(binding);
    try {
      expect(memory.get(indexed.observation)).toBeNull();
      expect(() => memory.journal.receipt(memory.scope, indexed.ingestion.readKey)).toThrow("permanently erased");
      const exported = JSON.stringify(memory.exportArchive());
      expect(exported).not.toContain("controlled-erasure-marker-81");
      expect(exported).not.toContain("Private audit title");
      expect(exported).not.toContain("audit/private");
      memory.rebuild();
      expect(memorySnapshot(binding).leaves).toEqual([]);
      expect(memory.eraseScope(version, "authorized-scope-erasure").retired).toBe(true);
    } finally { memory.close(); }
    await expect(indexLearning(binding, input, text => text)).rejects.toMatchObject({ code: "erased" });
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("selective native erasure removes one learned subject while unrelated owner memory stays usable after restart", async () => {
  const stateDir = await mkdtemp("/tmp/learning-selective-erasure-");
  const binding = { stateDir, owner: "123" };
  try {
    const removed = await indexLearning(binding, input, text => text);
    const kept = await indexLearning(binding, { ...input, id: "keep-learning-001", subject: "keep/unrelated", title: "Keep unrelated", payload: { text: "keep this fact" } }, text => text);
    let memory = openMemory(binding);
    const request = { subject: removed.subject, expectedHead: removed.observation,
      expectedScopeVersion: memory.journal.scopeVersion(memory.scope), key: "authorized-selective-erasure" };
    const erased = memory.eraseSubject(request);
    expect(erased.retired).toBe(false);
    expect(erased.observationIds).toEqual([removed.observation]);
    memory.close();
    memory = openMemory(binding);
    try {
      expect(memory.get(removed.observation)).toBeNull();
      expect(memory.get(kept.observation)?.state).toBe("current");
      const archive = JSON.stringify(memory.exportArchive());
      expect(archive).not.toContain("controlled-erasure-marker-81");
      expect(archive).not.toContain("Private audit title");
      memory.rebuild();
      expect(memory.eraseSubject(request)).toEqual(erased);
      expect(memorySnapshot(binding).leaves.map(leaf => leaf.observation)).toEqual([kept.observation]);
    } finally { memory.close(); }
    await expect(indexLearning(binding, input, text => text)).rejects.toMatchObject({ code: "erased" });
    await expect(indexLearning(binding, { ...input, id: "deleted-new-id-001" }, text => text)).rejects.toMatchObject({ code: "evidence_unavailable" });
    expect((await indexLearning(binding, { ...input, id: "keep-learning-002", subject: "keep/new", title: "Still writable", payload: { text: "new permitted fact" } }, text => text)).changed).toBe(true);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
