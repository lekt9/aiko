import { expect, test } from "bun:test";
import { nodeStorage } from "entity-learn";
import { Memory, Knowledge } from "entity-learn/cloudflare";
import { planeMemoryRead } from "../src/plane.ts";
import { openMemory, memoryScope, type MemoryStoreBinding } from "../src/memory.ts";
import { indexLearning, memorySnapshot, validateLearningInput } from "../src/learning.ts";

test("native injected storage shares learned evidence without touching a filesystem path and rejects foreign factories", async () => {
  const native = nodeStorage(":memory:");
  const shared = { ...native, close: () => {} };
  const binding: MemoryStoreBinding = {
    stateDir: "/proc/aiko-must-never-create-this", owner: "account-a",
    openMemory: adapters => new Memory({ storage: shared, scope: memoryScope("account-a"), adapters }),
  };
  try {
    const input = { id: "injected-hook-1", subject: "browser/search", title: "Search skill", kind: "skill" as const,
      type: "browser-tool", payload: { site: "example.test", action: "search" } };
    const first = await indexLearning(binding, input, text => text);
    const snapshot = memorySnapshot(binding);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.leaves).toHaveLength(1);
    expect(snapshot.leaves[0]?.observation).toBe(first.observation);
    expect(await indexLearning(binding, input, text => text)).toEqual(first);
    expect(memorySnapshot(binding)).toEqual(snapshot);
    const recalled = openMemory(binding);
    expect(recalled.get(first.observation)?.observation.subject).toBe(first.subject);
    recalled.close();
    expect(() => openMemory({ ...binding, owner: "account-b" })).toThrow("Incorrect host memory scope");
    const other = openMemory({ ...binding, owner: "account-b",
      openMemory: adapters => new Memory({ storage: shared, scope: memoryScope("account-b"), adapters }) });
    expect(other.get(first.observation)).toBeNull();
    expect(other.recall().items).toEqual([]);
    other.close();
    expect(validateLearningInput({ ...input, id: `sk-${"x".repeat(30)}` })).toBeUndefined();
  } finally { native.close(); }
});

test("private knowledge API uses the Worker account storage factory without touching the filesystem opener", async () => {
  const native = nodeStorage(":memory:"); const shared = { ...native, close: () => {} };
  const binding: MemoryStoreBinding = { stateDir: "/proc/aiko-must-never-create-this", owner: "123",
    openMemory: adapters => new Memory({ storage: shared, scope: memoryScope("123"), adapters }) };
  try {
    const memory = openMemory(binding); const knowledge = new Knowledge(memory);
    const options = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "fixture:worker" } });
    const raw = knowledge.source({ subject: "raw", title: "Source", text: "Review on Friday.", reference: "fixture" }, options("raw"));
    const page = knowledge.publish({ subject: "wiki", title: "Review", claims: [{ text: "Review on Friday.", basis: "stated",
      citations: [{ observation: raw.id, path: ["text"], quote: "Review on Friday." }] }] }, options("page"));
    memory.close();
    const response = planeMemoryRead(new URL(`https://example.test/v1/memory/knowledge/${page.id}`), binding)!;
    expect(response.status).toBe(200); expect((await response.json()).html).toContain("Review on Friday.");
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally { native.close(); }
});

test("workerd package conditions exclude both application and native library filesystem backends", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../src/learning.ts", import.meta.url).pathname],
    target: "browser", format: "esm", conditions: ["workerd"],
    external: ["node:*"],
  });
  expect(result.success).toBe(true);
  const code = await result.outputs[0]!.text();
  expect(code).not.toMatch(/node:(?:fs|sqlite|child_process)|bun:sqlite/);
  expect(code).not.toContain("memory-node.ts");
  expect(code).toContain("Worker memory requires an account-bound storage factory");
});
