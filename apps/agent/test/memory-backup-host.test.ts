import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Layer } from "effect";
import { createCloudflareAccountHost } from "../src/cloudflare-host.ts";
import { randomBytes, createHash } from "node:crypto";
import { CloudBackups, type BackupBucket } from "../src/cloud-backup.ts";
import { cloudflareStorage, type ErasureFence } from "entity-learn/cloudflare";
import { openGuardedMemory } from "../src/memory-restore.ts";
import { openMemory, memoryScope } from "../src/memory.ts";
import {
  productionWorker,
  durableStorage,
} from "./registry-worker-host.test.ts";

// Bun query executes one statement; Worker SQL exec accepts schema batches.
function fixtureStorage(db: Database) {
  const storage = durableStorage(db), exec = storage.sql.exec.bind(storage.sql);
  storage.sql.exec = (sql: string, ...args: any[]) => {
    if (!args.length && sql.trimStart().startsWith("CREATE")) {
      db.exec(sql);
      return { toArray: () => [], *[Symbol.iterator]() {} };
    }
    return exec(sql, ...args);
  };
  const put = storage.put.bind(storage);
  storage.put = async (key: string | Record<string, unknown>, value?: unknown) => {
    if (typeof key === "string") return put(key, value);
    for (const [entry, data] of Object.entries(key)) await put(entry, data);
  };
  return storage;
}

for (const mode of ["vm", "account"] as const)
  test(`memory backup host: ${mode} restore authority and native erasure publication gate`, async () => {
    const module = await productionWorker(),
      db = new Database(":memory:"),
      registryDb = new Database(":memory:"),
      sourceDb = new Database(":memory:"),
      originDb = new Database(":memory:");
    const storage = fixtureStorage(db),
      owner = "123";
    const objects = new Map<string, Uint8Array>();
    const bucket: BackupBucket = {
      put: async (k, v) => {
        objects.set(k, v.slice());
      },
      get: async (k) => {
        const v = objects.get(k);
        return v ? { arrayBuffer: async () => v.slice().buffer } : null;
      },
      delete: async (k) => {
        objects.delete(k);
      },
    };
    const key = randomBytes(32).toString("base64"),
      backups = new CloudBackups(bucket, key);
    let trusted: ErasureFence | undefined;
    const id = (name: string) => ({
      name,
      equals: (other: any) => other?.name === name,
    });
    const env: any = {
      AIKO_MODE: "demo",
      AIKO_INSTANCE_ID: "backup-authority",
      AIKO_REPLY_STYLE: "direct",
      AIKO_OPERATOR_TOKEN: "controlled-backup-operator-123456789",
      AIKO_ALLOWED_USERS: owner,
      AIKO_VOICE_ENABLED: "false",
      AIKO_MEMORY_RESTORE_AUTHORITY: () => trusted,
      AIKO_BACKUPS: bucket,
      AIKO_BACKUP_KEY: key,
      AIKO_ACCOUNTS: { idFromName: id },
    };
    env.AIKO_REGISTRY = { getByName: () => registry };
    const registry = new module.AikoRegistryDO(
      { storage: fixtureStorage(registryDb) },
      env,
    );
    const account: any = new module.AikoAccountDO(
      {
        id: id(module.accountObjectName(owner)),
        storage,
        waitUntil: () => {},
        blockConcurrencyWhile: (run: any) => run(),
      },
      env,
    );
    const request = (path: string, body?: unknown) =>
      account.handle(
        owner,
        new Request("https://controlled.invalid" + path, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        { owner, operator: true, scopes: ["read", "write"] },
      );
    const source = openGuardedMemory({
      storage: cloudflareStorage(fixtureStorage(sourceDb)),
      scope: memoryScope(owner),
    });
    const origin = await createCloudflareAccountHost({
      storage: fixtureStorage(originDb), actorName: "aiko", actorInstance: "backup-authority",
      ownsThread: (thread) => thread === "user-123",
      actorFor: () => undefined, layersFor: () => Layer.empty,
    });
    await origin.seed("user-123", [{ type: "Archived", id: "controlled-settled", at: 1 }]);
    let runtime: any;
    const release = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    try {
      const target = source.remember(
        {
          subject: "erase",
          title: "Erase",
          type: "fact",
          payload: "OLD_PRIVATE_VALUE",
        },
        { key: "source", producer: { kind: "agent", reference: "controlled" } },
      );
      const old = source.exportArchive();
      source.eraseSubject({
        subject: target.subject,
        expectedHead: target.id,
        expectedScopeVersion: source.scan().sourceVersion,
        key: "source-erase",
      });
      const clean = source.exportArchive(),
        fence = source.erasureFence();
      const save = async (memory: unknown) => {
        const data = new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            owner,
            threads: origin.exportHistory(),
            memory,
            state: [
              [
                "aiko_memory_erasure_authority",
                { fence: "forged-kv-authority" },
              ],
            ],
          }),
        );
        const vm = new Uint8Array([1, 2, 3]);
        const files = [
          ["vm.bin", vm],
          ["account.json", data],
        ] as const;
        return backups.save(owner, {
          files: files.map(([path, b]) => ({
            path,
            bytes: b.length,
            sha256: createHash("sha256").update(b).digest("hex"),
          })),
          read: async (path, offset, length) =>
            files.find((f) => f[0] === path)![1].slice(offset, offset + length),
        });
      };
      const stale = await save(old),
        current = await save(clean);
      await request("/api/harness/readiness");
      runtime = await account.runtime;
      const effects: string[] = [];
      let hold = false, downgradeOnWrite = false;
      // Controlled physical VM edge only: the production account handler, guard,
      // native account import and owner memory gate remain mounted unchanged.
      runtime.capabilities = {
        ...runtime.capabilities,
        sandbox: {
          busy: false,
          restore: async (produce: any) => {
            effects.push("stage");
            await produce({
              write: async () => {
                effects.push("write");
                if (downgradeOnWrite) delete env.AIKO_MEMORY_RESTORE_AUTHORITY;
              },
              abort: async () => {
                effects.push("abort");
              },
              commit: async () => {
                if (hold) {
                  entered.resolve();
                  await release.promise;
                }
                effects.push("published");
              },
            });
          },
        },
      };
      const restore = (backup: string) =>
        request("/api/control/restore", { id: backup, mode });
      expect((await restore(current.id)).status).toBe(409);
      expect(effects).toEqual([]);
      trusted = { ...fence, scope: "aiko:foreign" };
      expect((await restore(current.id)).status).toBe(409);
      expect(effects).toEqual([]);
      trusted = fence;
      expect((await restore(stale.id)).status).toBe(409);
      expect(effects).toEqual([]);
      if (mode === "vm") {
        // External proof alone cannot supply the local erased-subject tombstones.
        expect((await restore(current.id)).status).toBe(409);
        expect(effects).toEqual([]);
        expect((await request("/api/control/import", {
          id: "backup-native-prerequisite", threads: origin.exportHistory(), memory: clean,
        })).status).toBe(201);
        expect(effects).toEqual([]);
      }
      expect((await restore(current.id)).status).toBe(200);
      expect((await restore(current.id)).status).toBe(200);
      const before = effects.slice();
      trusted = undefined;
      expect((await restore(current.id)).status).toBe(409);
      expect(effects).toEqual(before);
      trusted = fence;
      // A retained local checkpoint must not downgrade an initially required
      // external authority when its configuration disappears during staging.
      const beforeDowngrade = effects.length;
      downgradeOnWrite = true;
      try {
        expect((await restore(current.id)).status).toBe(409);
        expect(effects.slice(beforeDowngrade)).toContain("write");
        expect(effects.slice(beforeDowngrade)).toContain("abort");
        expect(effects.slice(beforeDowngrade)).not.toContain("published");
      } finally {
        downgradeOnWrite = false;
        env.AIKO_MEMORY_RESTORE_AUTHORITY = () => trusted;
      }
      hold = true;
      const restoring = restore(current.id);
      await entered.promise;
      const binding = runtime.binding("user-123");
      let erased = false;
      const erasing = binding.withErasure(async () => {
        const memory = openMemory(binding);
        try {
          const row = memory.remember(
            {
              subject: "native",
              title: "Native erase",
              type: "fact",
              payload: "private",
            },
            {
              key: "native",
              producer: { kind: "agent", reference: "controlled" },
            },
          );
          memory.eraseSubject({
            subject: row.subject,
            expectedHead: row.id,
            expectedScopeVersion: memory.scan().sourceVersion,
            key: "native-erase",
          });
          erased = true;
          effects.push("erased");
        } finally {
          memory.close();
        }
      });
      await Promise.resolve();
      expect(erased).toBe(false);
      release.resolve();
      expect((await restoring).status).toBe(200);
      await erasing;
      expect(effects.lastIndexOf("erased")).toBeGreaterThan(
        effects.lastIndexOf("published"),
      );
      const authority = db
        .query("SELECT fence FROM aiko_memory_erasure_authority")
        .all();
      expect(authority).toHaveLength(1);
      const checkpoint = JSON.parse((authority[0] as any).fence);
      expect(checkpoint.scope).toBe(memoryScope(owner));
      expect(checkpoint).not.toEqual({ fence: "forged-kv-authority" });
      const count = effects.length;
      expect((await restore(current.id)).status).toBe(409);
      expect(effects).toHaveLength(count);
      expect(
        db.query("SELECT fence FROM aiko_memory_erasure_authority").all(),
      ).toEqual(authority);
    } finally {
      release.resolve();
      await runtime?.host.close();
      await origin.close();
      originDb.close();
      source.close();
      sourceDb.close();
      registryDb.close();
      db.close();
    }
  });
