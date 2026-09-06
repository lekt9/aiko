import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { Knowledge, nodeStorage, SemanticIndex, type EmbeddingProvider, type Observation, type EmbeddingRequest } from "entity-learn";
import { memoryTools, openMemory, type MemoryBinding, type MemoryReceipt } from "../src/memory.ts";
import { EmbeddingBudget } from "../src/embedding-budget.ts";
import { WikiMemory } from "../src/wiki-memory.ts";
import { loadConfig, PERSONA } from "../src/config.ts";
import { createService } from "../src/server.ts";
import { accountDirectory } from "../src/accounts.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { createAikoClient } from "../../../packages/sdk/src/aiko.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const stateDir = await mkdtemp("/tmp/aiko-knowledge-"); cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const binding: MemoryBinding = { stateDir, owner: "alice", thread: "user-alice", redact: text => text.replaceAll("PRIVATE_FIXTURE", "[redacted]"), readPage: async () => [] };
  const run = async (name: string, input: unknown, callId: string, bound = binding, signal = new AbortController().signal): Promise<MemoryReceipt> => {
    const native = memoryTools(bound, { fixtures: false }).find(t => t.spec.name === name)!;
    return await Effect.runPromise(native.run(input, { callId, signal }).pipe(
      Effect.provideService(Self, { actor: "aiko", instance: "test", thread: bound.thread }))) as MemoryReceipt;
  };
  return { stateDir, binding, run };
}
const write = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "fixture:compiler" } });
const saved = (r: MemoryReceipt) => r.result as unknown as Observation;

test("native tools compile quoted source evidence with durable call identities, CAS, lint and suppression", async () => {
  const f = await fixture();
  const raw = saved(await f.run("memory_remember", { subject: "raw/thesis", title: "Thesis conference", type: "source", payload: { text: "I presented my thesis in June." } }, "raw"));
  const draft = { subject: "wiki/thesis", title: "Thesis presentation", claims: [{ text: "The thesis presentation happened in June.", basis: "stated",
    citations: [{ observation: raw.id, path: ["text"], quote: "I presented my thesis in June." }] }] };
  const compiled = await f.run("memory_publish_page", draft, "page"); expect(compiled.outcome).toBe("ok");
  const id = saved(compiled).id;
  expect(await f.run("memory_publish_page", draft, "page")).toEqual(compiled);
  expect((await f.run("memory_publish_page", { ...draft, title: "Changed" }, "page")).outcome).toBe("error");
  const page = await f.run("memory_page", { observation: id }, "read");
  expect(page.result).toMatchObject({ verification: "quote-presence-only", viewPath: `/v1/memory/knowledge/${id}` });
  expect((await f.run("memory_lint_pages", {}, "lint")).result).toMatchObject({ issues: [], semanticTruthChecked: false });
  const other = { ...f.binding, owner: "bob", thread: "user-bob" };
  expect((await f.run("memory_page", { observation: id }, "foreign", other)).result).toBeNull();
  await f.run("memory_forget", { subject: raw.subject, expected: raw.id }, "forget");
  expect((await f.run("memory_page", { observation: id }, "forgotten")).result).toBeNull();
});

test("embedding tools require an injected grant, index one batch and never run on ordinary recall/rebuild", async () => {
  const f = await fixture(); const calls: { purpose: string; texts: readonly string[] }[] = [];
  const provider: EmbeddingProvider = { space: { model: "fixture/local", dimensions: 2, revision: "v1" }, maxBatch: 8, maxInputBytes: 4096,
    embed: async (texts, context) => { calls.push({ texts, purpose: context.purpose }); return { vectors: texts.map(() => [1, 0]), usage: { promptTokens: 1, totalTokens: 1, costUsd: null } }; } };
  expect(memoryTools(f.binding).some(t => t.spec.name === "memory_index")).toBe(false);
  const bound = { ...f.binding, embedding: provider };
  await f.run("memory_remember", { subject: "canine", title: "Dog", type: "note", payload: { text: "A dog enjoys walks." } }, "raw");
  expect((await f.run("memory_index", {}, "index", bound)).outcome).toBe("ok"); expect(calls).toHaveLength(1);
  expect(calls[0]?.purpose).toBe("document");
  await f.run("memory_index", {}, "index-again", bound); expect(calls).toHaveLength(1);
  await f.run("memory_recall", { search: "Dog" }, "lexical", bound); expect(calls).toHaveLength(1);
  expect((await f.run("memory_semantic_recall", { search: "hound", minSimilarity: 0.8 }, "query", bound)).result).toMatchObject({ items: [{ matchedBy: ["semantic"] }] });
  expect(calls).toHaveLength(2); expect(calls[1]?.purpose).toBe("query");
  const memory = openMemory(bound); try { memory.rebuild(); } finally { memory.close(); }
  expect(calls).toHaveLength(2);
});

test("private examples and their derived pages require current consent; redacted records never leave for embedding", async () => {
  const f = await fixture(); const memory = openMemory(f.binding); let consent = true;
  let example: Observation; let page: Observation;
  try {
    example = memory.remember({ subject: "raw/style", title: "Private example", type: "style-example", payload: { text: "A private writing example." } }, write("example"));
    const wiki = new WikiMemory({ owner: f.binding.owner, memory, redact: f.binding.redact, styleExampleConsent: () => consent });
    page = wiki.compile({ subject: "wiki/style", title: "Private compilation", claims: [{ text: "A writing-style observation.", basis: "inferred",
      citations: [{ observation: example.id, path: ["text"], quote: "A private writing example." }] }] }, write("page"));
    expect(wiki.contextBundle({ revisions: [page.id] }).items).toHaveLength(1);
    consent = false;
    expect(wiki.contextBundle({ revisions: [page.id] }).reasons).toContain("style_consent_required");
    expect(wiki.contextBundle({ revisions: [page.id] }).items).toEqual([]);
    expect(wiki.compiledHtml(page.id)).toContain("Evidence notebook"); // Owner views remain separate from model-context consent.
    memory.remember({ subject: "old-key", title: "Previously stored", type: "note", payload: { text: "PRIVATE_FIXTURE" } }, write("old-key"));
  } finally { memory.close(); }
  // Every native read is model context, unlike the owner's authenticated page API.
  const denied = { ...f.binding, styleExampleConsent: () => consent };
  for (const id of [example.id, page.id]) {
    expect((await f.run("memory_get", { observation: id }, `get-${id}`, denied)).result).toBeNull();
  }
  expect((await f.run("memory_page", { observation: page.id }, "private-page", denied)).result).toBeNull();
  for (const [name, args] of [["memory_recall", { search: "private", depth: 2 }], ["memory_scan", {}]] as const) {
    const receipt = await f.run(name, args, name, denied);
    expect(receipt.outcome).toBe("ok");
    expect(receipt.result).toMatchObject({ items: [], coverage: "partial", reasons: expect.arrayContaining(["host_policy"]) });
    expect(JSON.stringify(receipt)).not.toContain("A private writing example.");
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_FIXTURE");
  }
  expect((await f.run("memory_history", { subject: example.subject }, "private-history", denied)).result).toEqual([]);
  expect((await f.run("memory_lint_pages", {}, "private-lint", denied)).result).toMatchObject({ issues: [], coverage: "partial", reasons: ["host_policy"] });
  const derived = { subject: "derived/private", title: "Copy", type: "note", payload: "copy", supports: [page.id] };
  expect((await f.run("memory_remember", derived, "denied-copy", denied)).outcome).toBe("error");
  consent = true;
  expect((await f.run("memory_get", { observation: example.id }, "allowed-get", denied)).result).toMatchObject({ observation: { id: example.id } });
  expect((await f.run("memory_page", { observation: page.id }, "allowed-page", denied)).result).toMatchObject({ hit: { observation: { id: page.id } } });
  expect((await f.run("memory_scan", {}, "allowed-scan", denied)).result).toMatchObject({ coverage: "partial", reasons: ["host_policy"] }); // Old redacted record still excluded.
  consent = false;
  let calls = 0;
  const embedding: EmbeddingProvider = { space: { model: "fixture/local", dimensions: 2, revision: "v1" }, maxBatch: 8, maxInputBytes: 4096,
    embed: async texts => { calls++; return { vectors: texts.map(() => [1, 0]), usage: { promptTokens: 1, totalTokens: 1, costUsd: null } }; } };
  const result = await f.run("memory_index", {}, "denied-index", { ...f.binding, embedding });
  expect(result.result).toMatchObject({ accepted: [], reasons: ["egress_policy"] }); expect(calls).toBe(0);
  // Simulate a previously consented cache: revocation must also filter search results, not only future uploads.
  const reopened = openMemory(f.binding);
  try { const index = new SemanticIndex(reopened, embedding.space); const docs = index.prepare().documents; index.commit(docs, docs.map(() => [1, 0])); }
  finally { reopened.close(); }
  const recalled = await f.run("memory_semantic_recall", { search: "writing", minSimilarity: 0.8 }, "revoked-query", { ...f.binding, embedding });
  expect(recalled.result).toMatchObject({ items: [], reasons: ["host_policy"] }); expect(calls).toBe(1);
});

test.each(["consent", "redaction", "cancellation", "malformed-batch"] as const)("native index rechecks %s after provider I/O before committing vectors", async (change) => {
  const f = await fixture(); let changed = false; let calls = 0;
  const abort = new AbortController();
  const store = openMemory(f.binding);
  let restricted: Observation;
  try {
    restricted = store.remember({ subject: "restricted", title: "Restricted example", type: "style-example", payload: { text: "NEWLY_RESTRICTED" } }, write("restricted"));
    store.remember({ subject: "public", title: "Public note", type: "note", payload: "public" }, write("public"));
  } finally { store.close(); }
  const embedding: EmbeddingProvider = { space: { model: "fixture", dimensions: 2, revision: "v1" }, maxBatch: 8, maxInputBytes: 4096,
    embed: async texts => {
      calls++; changed = true;
      if (change === "cancellation") abort.abort();
      return { vectors: [...texts.map(() => [1, 0]), ...(change === "malformed-batch" ? [[1, 0]] : [])], usage: { promptTokens: 2, totalTokens: 2, costUsd: null } };
    } };
  const bound = { ...f.binding, embedding, styleExampleConsent: () => !(changed && change === "consent"),
    redact: (text: string) => changed && change === "redaction" ? text.replaceAll("NEWLY_RESTRICTED", "[redacted]") : f.binding.redact(text) };
  const result = await f.run("memory_index", {}, "index-race", bound, abort.signal);
  expect(calls).toBe(1);
  if (change === "cancellation" || change === "malformed-batch") expect(result.outcome).toBe("error");
  else expect(result.result).toMatchObject({ rejected: [restricted.id], coverage: "partial", reasons: ["host_policy"], usage: { promptTokens: 2 } });
  const reopened = openMemory(f.binding);
  try {
    const pending = new SemanticIndex(reopened, embedding.space).prepare().documents;
    expect(pending.map(d => d.observation)).toContain(restricted.id);
    expect(pending.length).toBe(change === "cancellation" || change === "malformed-batch" ? 2 : 1);
  } finally { reopened.close(); }
});

test("host embedding allowance is durable, global across owners, replay-safe and unaffected by memory rebuild", async () => {
  const f = await fixture(); const path = join(f.stateDir, "embedding-budget.sqlite");
  let now = Date.UTC(2026, 0, 1); let budget = new EmbeddingBudget(nodeStorage(path), 0.02, () => now);
  const req = (key: string): EmbeddingRequest => ({ key, model: "fixture", documents: 1, inputBytes: 100, maxInputTokens: 100, ceilingUsd: 0.01 });
  try {
    budget.forOwner("123").reserve(req("a"));
    budget.forOwner("123").settle(req("a"), { promptTokens: 1, totalTokens: 1, costUsd: 0.00001 });
    expect(budget.status().accountedUsd).toBe(0.01); // No optimistic refund.
    budget.close(); budget = new EmbeddingBudget(nodeStorage(path), 0.02, () => now);
    expect(() => budget.forOwner("123").reserve(req("a"))).toThrow("already reserved");
    budget.forOwner("456").reserve(req("b"));
    expect(() => budget.forOwner("123").reserve(req("c"))).toThrow("exhausted");
    const memory = openMemory(f.binding); try { memory.rebuild(); } finally { memory.close(); }
    expect(budget.status().accountedUsd).toBe(0.02);
    now += 86400000; expect(budget.status().accountedUsd).toBe(0);
    expect(() => budget.forOwner("123").reserve(req("a"))).toThrow("already reserved");
    budget.forOwner("123").reserve(req("d"));
    budget.forOwner("123").settle(req("d"), { promptTokens: 101, totalTokens: 101, costUsd: 0.03 });
    expect(budget.status().stopped).toBe(true); expect(budget.status().accountedUsd).toBe(0.03);
    now += 86400000; expect(() => budget.forOwner("456").reserve(req("e"))).toThrow("exhausted");
  } finally { budget.close(); }
});

test("unrepresentable provider accounting commits a durable stop before surfacing its error", async () => {
  const f = await fixture(); const path = join(f.stateDir, "precision-budget.sqlite");
  let budget = new EmbeddingBudget(nodeStorage(path), 0.02);
  const request = { key: "precision", model: "fixture", documents: 1, inputBytes: 1, maxInputTokens: 10, ceilingUsd: 0.01 };
  try {
    budget.forOwner("123").reserve(request);
    expect(() => budget.forOwner("123").settle(request, { promptTokens: 1, totalTokens: 1, costUsd: Number.MAX_VALUE })).toThrow("reconciliation");
    budget.close(); budget = new EmbeddingBudget(nodeStorage(path), 0.02);
    expect(budget.status().stopped).toBe(true);
    expect(() => budget.forOwner("456").reserve({ ...request, key: "blocked" })).toThrow("exhausted");
  } finally { budget.close(); }
});

test("cloud configuration needs separate consent, owner allowlist, revision, dedicated key and USD cap", async () => {
  const f = await fixture();
  const base = { AIKO_SECRET_FILE: join(f.stateDir, "missing.env"), AIKO_STATE_DIR: f.stateDir, AIKO_OPERATOR_TOKEN: "fixture-operator-12345678901234567890",
    AIKO_MODE: "demo", OPENROUTER_EMBEDDING_API_KEY: "fixture-not-real" };
  expect((await loadConfig(base)).memoryEmbedding).toBeUndefined();
  const enabled = { ...base, AIKO_MODE: "live", AIKO_ALLOW_PAID_INFERENCE: "true", CODEGRAFF_API_KEY: "fixture-not-real", AIKO_MEMORY_CLOUD_EMBEDDINGS: "true",
    AIKO_MEMORY_EMBEDDING_OWNERS: "123,456", AIKO_MEMORY_EMBEDDING_MAX_USD_PER_DAY: "0.05", AIKO_MEMORY_EMBEDDING_REVISION: "fixture-v1" };
  expect((await loadConfig(enabled)).memoryEmbedding).toMatchObject({ owners: ["123", "456"], maxUsdPerDay: 0.05, revision: "fixture-v1" });
  for (const name of ["OPENROUTER_EMBEDDING_API_KEY", "AIKO_MEMORY_EMBEDDING_OWNERS", "AIKO_MEMORY_EMBEDDING_MAX_USD_PER_DAY", "AIKO_MEMORY_EMBEDDING_REVISION"]) {
    await expect(loadConfig({ ...enabled, [name]: "" })).rejects.toThrow("Cloud memory requires");
  }
});

test("authenticated SDK exposes inert knowledge HTML only in the owning account, never as a public artifact", async () => {
  const f = await fixture();
  const alice = "aiko_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; const bob = "aiko_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const service = await createService({ stateDir: f.stateDir, mode: "demo", port: 4242, operatorToken: "fixture-operator-12345678901234567890",
    persona: PERSONA, voiceEnabled: false, allowedUsers: new Set(), publicWeb: false,
    planeCredentials: [{ account: "123", digest: credentialDigest(alice), scopes: ["read"] }, { account: "456", digest: credentialDigest(bob), scopes: ["read"] }] });
  cleanups.push(() => service.close());
  const memory = openMemory({ owner: "123", stateDir: accountDirectory(f.stateDir, "123") });
  let raw: Observation; let page: Observation;
  try {
    const knowledge = new Knowledge(memory);
    raw = knowledge.source({ subject: "raw/plan", title: "Plan", text: "The review is on Friday.", reference: "fixture" }, write("raw"));
    page = knowledge.publish({ subject: "wiki/plan", title: "Review plan", claims: [{ text: "Review on Friday.", basis: "stated",
      citations: [{ observation: raw.id, path: ["text"], quote: "The review is on Friday." }] }] }, write("page"));
  } finally { memory.close(); }
  const transport = (async (url: string | URL | Request, init?: RequestInit) => service.fetch(new Request(url, init))) as typeof fetch;
  const client = (token: string) => createAikoClient({ baseUrl: "http://127.0.0.1:4242", token, fetch: transport });
  const view = await client(alice).memory.page(page.id);
  expect(view.html).toContain("Review plan"); expect(view.page.verification).toBe("quote-presence-only");
  expect(view.html).not.toContain("<script");
  await expect(client(bob).memory.page(page.id)).rejects.toMatchObject({ status: 404 });
  expect((await service.fetch(new Request(`http://127.0.0.1:4242/v1/memory/knowledge/${page.id}`))).status).toBe(401);
  const store = openMemory({ owner: "123", stateDir: accountDirectory(f.stateDir, "123") });
  try { store.forget(raw.subject, raw.id, "forget"); } finally { store.close(); }
  await expect(client(alice).memory.page(page.id)).rejects.toMatchObject({ status: 404 });
});
