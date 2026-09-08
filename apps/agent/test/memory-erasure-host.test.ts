import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, infer, Infer, outputValidateOnce, system, tool } from "tardie";
import { createBunHost } from "tardie/bun/host";
import type { Event } from "tardie/core/event";
import { Memory, cloudflareStorage, type CloudflareMemoryStorage } from "entity-learn/cloudflare";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { memoryScope, memoryTools, openMemory, type MemoryBinding } from "../src/memory.ts";

import { memoryTestAuthority } from "./memory-authority-fixture.ts";

// Real native tool effects and disk storage, with a controlled acknowledgement
// cut. The Worker uses its actual entity-learn adapter over a local SQL fixture;
// this is not deployment evidence or erasure of earlier actor-log payloads.
for (const backend of ["bun", "worker"] as const) {
  test(`${backend}: selective erasure recovers a lost native tool acknowledgement without a second mutation`, async () => {
    const dir = await mkdtemp("/tmp/native-memory-erasure-");
    const thread = "user-123", owner = "123";
    const authority = memoryTestAuthority(dir);
    const binding: MemoryBinding = { stateDir: dir, owner, thread, ...authority.binding(owner), redact: s => s, readPage: async () => [] };
    let db: Database | undefined, loseAck = true;
    const closeDatabase = () => { db?.close(); db = undefined; };
    let request: { subject: string; expected: string; expectedScopeVersion: number };
    const create = async () => {
      const guard = (_thread: string, events: readonly Event[]) => {
        if (loseAck && events.some(e => e.type === "ToolReturned")) throw Error("controlled erasure acknowledgement loss");
        return true;
      };
      let storage: (AccountStorage & CloudflareMemoryStorage) | undefined;
      if (backend === "worker") {
        db = new Database(join(dir, "native.sqlite"));
        storage = { sql: { exec: (query: string, ...args: (string | number | null | ArrayBuffer)[]) => {
          const rows = !args.length && query.trimStart().startsWith("CREATE")
            ? (db!.exec(query), []) : db!.query(query).all(...args as any);
          return { toArray: () => rows as never, [Symbol.iterator]: () => (rows as Record<string, never>[])[Symbol.iterator]() };
        } },
          transactionSync: f => db!.transaction(f)(), sync: async () => {},
          getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
        const nativeStorage = cloudflareStorage(storage);
        binding.stateDir = "/proc/no-filesystem-memory";
        binding.openMemory = adapters => new Memory({ storage: nativeStorage, scope: memoryScope(owner), adapters });
      }
      const inference = Layer.succeed(Infer, {
        resolve: () => ({ model: { provider: "fixture", model_id: "erase" } }),
        react: r => Effect.succeed(r.trajectory.some(e => e.type === "ToolReturned")
          ? { kind: "complete" as const, output: "Erasure receipt returned" }
          : { kind: "call" as const, callId: "erase-once", name: "memory_erase", arguments: request }),
      });
      const definition = actor({ name: "aiko", methods: { message: agentMessageMethod },
        components: [infer([system("Perform the explicit scoped erasure"), tool(memoryTools(binding, { fixtures: false })), outputValidateOnce])] });
      if (backend === "bun") return createBunHost({ database: join(dir, "native.sqlite"), actorName: "aiko",
        actorInstance: "erasure", actorFor: () => definition, layersFor: () => inference, canAppend: guard });
      return createCloudflareAccountHost({ storage: storage!, actorName: "aiko", actorInstance: "erasure",
        ownsThread: t => t === thread, actorFor: () => definition, layersFor: () => inference, canAppend: guard });
    };
    let host = await create(), closed = false;
    try {
      const memory = openMemory(binding);
      const options = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "controlled-erasure" } });
      const source = memory.remember({ subject: "erase/native", title: "Delete this", type: "fact", payload: "NATIVE_ERASURE_PAYLOAD" }, options("source"));
      const dependent = memory.remember({ subject: "erase/derivative", title: "Dependent copy", type: "fact", payload: "NATIVE_ERASURE_PAYLOAD",
        supports: [source.id] }, options("dependent"));
      const keep = memory.remember({ subject: "keep/native", title: "Keep this", type: "fact", payload: "UNRELATED_NATIVE_PAYLOAD" }, options("keep"));
      request = { subject: source.subject, expected: source.id, expectedScopeVersion: memory.scan().sourceVersion };
      memory.close();
      await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "erase-request", text: "Permanently erase the selected memory", at: Date.now() });
      await expect(host.drive()).rejects.toThrow("controlled erasure acknowledgement loss");
      const before = openMemory(binding);
      let erasedVersion: number;
      try {
        expect(before.get(source.id)).toBeNull();
        expect(before.get(dependent.id)).toBeNull();
        expect(before.get(keep.id)?.state).toBe("current");
        expect(JSON.stringify(before.exportArchive())).not.toContain("NATIVE_ERASURE_PAYLOAD");
        erasedVersion = before.journal.scopeVersion(before.scope);
      } finally { before.close(); }
      expect((await host.read(thread)).filter(e => e.type === "ToolReturned")).toHaveLength(0);
      closed = true; await host.close(); closeDatabase();
      loseAck = false; host = await create(); closed = false;
      await host.recover();
      let rows = await host.read(thread);
      const receipts = rows.filter(e => e.type === "ToolReturned");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.result).toMatchObject({ operation: "erase", outcome: "ok",
        result: { erased: true, retired: false, observations: 2, subjects: 2 } });
      const after = openMemory(binding);
      try {
        expect(after.journal.scopeVersion(after.scope)).toBe(erasedVersion!);
        expect(after.get(keep.id)?.state).toBe("current");
        expect(after.get(source.id)).toBeNull();
        after.rebuild();
        expect(JSON.stringify(after.exportArchive())).not.toContain("NATIVE_ERASURE_PAYLOAD");
      } finally { after.close(); }
      closed = true; await host.close(); closeDatabase();
      host = await create(); closed = false; await host.recover();
      rows = await host.read(thread);
      expect(rows.filter(e => e.type === "ToolReturned")).toEqual(receipts);
    } finally {
      if (!closed) await host.close();
      closeDatabase();
      await authority.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
