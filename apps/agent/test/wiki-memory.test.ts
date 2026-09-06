import { afterEach, expect, test } from "bun:test";
import { nodeStorage } from "entity-learn";
import { Memory, type Json, type RememberInput, type WriteOptions } from "entity-learn/cloudflare";
import { WikiMemory } from "../src/wiki-memory.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function fixture() {
  const storage = nodeStorage(":memory:");
  cleanup.push(() => storage.close());
  let now = 10000;
  const memory = new Memory({ storage, scope: "aiko:alice", clock: () => now,
    adapters: { local: async () => ({ data: [{ id: "one", title: "Weather", temperature: 29 }] }) } });
  const wiki = new WikiMemory({ owner: "alice", memory, redact: s => s.replaceAll("PRIVATE_CREDENTIAL", "[redacted]") });
  let count = 0;
  const opts = (): WriteOptions => ({ key: `test-${++count}`, producer: { kind: "agent", reference: "test-turn" } });
  const save = (subject: string, extra: Partial<RememberInput> = {}) => memory.remember({ subject, title: subject,
    type: "note", payload: { text: `Recorded ${subject}` }, ...extra }, opts());
  return { storage, memory, wiki, opts, save, time: (n: number) => { now = n; } };
}

test("projection sees native writes and shares existing store across reopen, isolates owners", () => {
  const f = fixture(); const original = f.save("decision");
  expect(f.wiki.page("decision").items[0]?.revision).toBe(original.id);
  expect(f.wiki.read(original.id).items[0]?.hit.observation).toEqual(original);
  expect(f.wiki.search("decision").items[0]?.revision).toBe(original.id);
  const reopened = new WikiMemory({ owner: "alice", memory: new Memory({ storage: f.storage, scope: "aiko:alice" }), redact: s => s });
  expect(reopened.read(original.id).items).toHaveLength(1);
  expect(() => new WikiMemory({ owner: "bob", memory: f.memory, redact: s => s })).toThrow("scope");
  const other = new WikiMemory({ owner: "bob", memory: new Memory({ storage: f.storage, scope: "aiko:bob" }), redact: s => s });
  expect(other.read(original.id).items).toEqual([]);
  expect(other.search("decision").items).toEqual([]);
  expect(other.revisions("decision").items).toEqual([]);
  expect(other.backlinks("decision").items).toEqual([]);
  expect(other.contextBundle({ revisions: [original.id] }).missing).toEqual([{ id: original.id, label: "missing" }]);
  expect(() => other.supersede(original.id, { title: "other", type: "note", payload: {} }, f.opts())).toThrow();
  expect(() => other.forget("decision", original.id, "foreign-forget")).toThrow();
});

test("edit/supersede use exact native CAS and idempotency; forget suppresses dependent views", () => {
  const f = fixture(); const options = f.opts();
  const input = { subject: "decision", title: "Decision", type: "note", payload: { text: "first" } };
  const first = f.wiki.edit(input, options);
  expect(f.wiki.edit(input, options).revision).toBe(first.revision);
  expect(() => f.wiki.edit({ ...input, payload: { text: "different" } }, options)).toThrow();
  const dependent = f.save("summary", { dependsOn: [first.revision] });
  const second = f.wiki.supersede(first.revision, { title: "Decision", type: "note", payload: { text: "second" } }, f.opts());
  expect(f.memory.get(second.revision)?.observation.supersedes).toBe(first.revision);
  expect(f.wiki.revisions("decision").items.map(i => i.revision)).toEqual([second.revision, first.revision]);
  expect(f.wiki.read(first.revision).items[0]?.hit.state).toBe("superseded");
  expect(f.wiki.read(dependent.id).items[0]?.sources).toContainEqual({ relation: "depends_on", id: first.revision, subject: "decision", label: "stale" });
  expect(() => f.wiki.supersede(first.revision, { title: "oops", type: "note", payload: {} }, f.opts())).toThrow();
  expect(() => f.wiki.forget("decision", first.revision, "old-forget")).toThrow();
  expect(f.wiki.forget("decision", second.revision, "forget")).toEqual({ subject: "decision", forgotten: true, erased: false });
  expect(f.wiki.forget("decision", second.revision, "forget").forgotten).toBe(true);
  for (const id of [first.revision, second.revision, dependent.id]) expect(f.wiki.read(id).items).toEqual([]);
  expect(f.wiki.revisions("decision").items).toEqual([]);
  expect(f.wiki.search("decision").items).toEqual([]);
  expect(f.wiki.backlinks("decision").items).toEqual([]);
  expect(f.wiki.contextBundle({ revisions: [dependent.id] }).reasons).toContain("missing_sources");
  expect(() => f.wiki.edit(input, f.opts())).toThrow();
});

test("native links, support and dependency references produce backlinks without a shadow index", () => {
  const f = fixture(); const target = f.save("target");
  const linked = f.save("linked", { links: [{ subject: "target", relation: "mentions" }] });
  const supported = f.save("supported", { supports: [target.id] });
  const derived = f.save("derived", { dependsOn: [target.id] });
  f.save("unrelated");
  expect(f.wiki.backlinks("target").items.map(i => i.revision).sort()).toEqual([linked.id, supported.id, derived.id].sort());
  const before = f.memory.exportArchive();
  f.wiki.page("target"); f.wiki.contextBundle({ query: "derived" }); f.wiki.sources();
  expect(f.memory.exportArchive()).toEqual(before);
});

test("source views and bundles preserve pinned provenance, TTL and disabled source labels", async () => {
  const f = fixture();
  const s = f.memory.registerSource({ id: "weather", namespace: "weather", type: "weather", resolver: "adapter", locator: "local", format: "json", ttlSeconds: 1, schema: { id: "id", title: "title" } }, "register");
  expect(f.wiki.sources().items[0]?.label).toBe("missing");
  f.memory.approveSource(s.id, s.revision, true, "approve");
  const refreshed = await f.memory.refresh(s.id, { key: "refresh" });
  expect(refreshed.error).toBeNull();
  const sourceId = refreshed.observations[0]!;
  const note = f.save("forecast", { supports: [sourceId] });
  const bundle = f.wiki.contextBundle({ query: "forecast" });
  expect(bundle.trust).toBe("untrusted-recorded-evidence");
  expect(bundle.items.map(i => i.revision)).toContain(sourceId);
  expect(bundle.items.find(i => i.revision === note.id)?.sources).toContainEqual({ id: sourceId, relation: "supports", label: "available", subject: "weather/weather/one" });
  expect(f.wiki.read(sourceId).items[0]?.sources[0]).toMatchObject({ sourceId: "weather", sourceRevision: s.revision, label: "available" });
  expect(JSON.stringify(f.wiki.sources())).not.toContain("locator");
  f.time(12000);
  expect(f.wiki.sources().items[0]?.label).toBe("stale");
  expect(f.wiki.contextBundle({ revisions: [sourceId] }).items[0]?.sources[0]?.label).toBe("stale");
  f.memory.approveSource(s.id, s.revision, false, "disable");
  expect(f.wiki.read(sourceId).items[0]?.sources[0]?.label).toBe("stale");
  const foreign = new WikiMemory({ owner: "bob", memory: new Memory({ storage: f.storage, scope: "aiko:bob" }), redact: s => s });
  expect(foreign.sources().items).toEqual([]);
});

test("bundles require a selector, bound UTF-8 envelopes and retain partial-coverage reasons", () => {
  const f = fixture();
  for (let n = 0; n < 105; n++) f.save(`page-${n}`, { payload: { text: "界".repeat(200) }, links: [{ subject: "target", relation: "mentions" }] });
  expect(() => f.wiki.contextBundle({})).toThrow("requires");
  expect(() => f.wiki.contextBundle({ query: " " })).toThrow();
  for (const maxBytes of [512, 1500, 12000]) {
    const bundle = f.wiki.contextBundle({ query: "page", limit: 10, maxBytes });
    expect(new TextEncoder().encode(JSON.stringify(bundle)).length).toBe(bundle.bytes);
    expect(bundle.bytes).toBeLessThanOrEqual(maxBytes);
    expect(bundle.coverage).toBe("partial");
  }
  expect(f.wiki.backlinks("target").coverage).toBe("partial");
  expect(f.wiki.search("page", { limit: 1 }).reasons).toContain("result_budget");
  for (const limit of [0, 101, NaN, 1.5]) expect(() => f.wiki.search("page", { limit })).toThrow();
  const oversized = f.save("large", { payload: { text: "界".repeat(2000) } });
  expect(f.wiki.read(oversized.id, { maxBytes: 512 }).reasons).toContain("byte_budget");
  expect(() => f.wiki.contextBundle({ revisions: Array(17).fill(oversized.id) })).toThrow();
});

test("private style examples require current host consent for bundle use, never payload consent", () => {
  const f = fixture();
  const example = f.save("writing-example", { type: "style-example", payload: { consent: true, text: "private style" } });
  expect(f.wiki.read(example.id).items[0]?.privateStyleExample).toBe(true);
  expect(f.wiki.contextBundle({ revisions: [example.id] }).items).toEqual([]);
  expect(f.wiki.contextBundle({ query: "writing-example" }).reasons).toContain("style_consent_required");
  let consent = true;
  const wiki = new WikiMemory({ owner: "alice", memory: f.memory, redact: s => s, styleExampleConsent: id => id === example.id && consent });
  expect(wiki.contextBundle({ revisions: [example.id] }).items).toHaveLength(1);
  consent = false;
  expect(wiki.contextBundle({ revisions: [example.id] }).items).toHaveLength(0);
});

test("write validation uses native secret detection and host redaction before journal mutation", () => {
  const f = fixture(); const before = f.memory.exportArchive();
  const payloads: Json[] = [{ password: "secret" }, { text: "PRIVATE_CREDENTIAL" }];
  for (const payload of payloads) {
    expect(() => f.wiki.edit({ subject: "unsafe", title: "Unsafe", type: "note", payload }, f.opts())).toThrow();
  }
  expect(() => f.wiki.search("PRIVATE_CREDENTIAL")).toThrow();
  expect(f.memory.exportArchive()).toEqual(before);
});
