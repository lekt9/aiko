import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { nodeStorage } from "../lib/storage-node.js";
import { Memory as NodeMemory } from "../lib/index.js";
import { Memory, cloudflareStorage, validateRememberInput, type CloudflareMemoryStorage,
  type MemoryOptions, type RememberInput, type SourceRunner } from "../lib/cloudflare.js";
import type { SqlRow, SqlValue } from "../lib/storage.js";

/** Strict synchronous DO contract over real SQLite. This is adapter parity, not a workerd emulator. */
function durableStorage() {
  const db = new DatabaseSync(":memory:");
  let transactions = 0;
  const storage: CloudflareMemoryStorage = {
    sql: { exec(sql: string, ...args: SqlValue[]): Iterable<SqlRow> {
      if (/\b(?:BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i.test(sql)) throw new Error("Forbidden DO SQL transaction or pragma");
      if (sql.trimStart().startsWith("CREATE") || sql.includes(";")) { db.exec(sql); return []; }
      return db.prepare(sql).all(...args);
    } },
    transactionSync<T>(run: () => T): T {
      transactions++;
      db.exec("BEGIN IMMEDIATE");
      try { const value = run(); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  return { storage, db, transactions: () => transactions };
}
const claim = (subject: string, payload: RememberInput["payload"] = "Durable memory"): RememberInput =>
  ({ subject, title: "Durable memory", type: "decision", kind: "fact", payload });
const write = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "test:agent" } });

async function history(open: (options: Omit<MemoryOptions, "storage">) => Memory) {
  let at = 1000; let broken = false; let rows = [{ id: "one", title: "Visible entity", status: "open" }];
  const adapters: Record<string, SourceRunner> = { fixture: async () => {
    if (broken) throw new Error("private provider error"); return { data: rows };
  } };
  const memory = open({ scope: "owner:a", clock: () => at, adapters });
  try {
    const first = memory.remember(claim("note"), write("one"));
    expect(memory.remember(claim("note"), write("one"))).toEqual(first);
    expect(() => memory.remember(claim("other"), write("one"))).toThrow("different input");
    at = 2000;
    const corrected = memory.remember({ ...claim("note", "Corrected durable memory"), supersedes: first.id }, write("two"));
    const derived = memory.remember({ ...claim("derived"), supports: [corrected.id] }, write("derived"));
    const source = memory.registerSource({ id: "fixture", namespace: "learned", type: "entity", resolver: "adapter",
      locator: "fixture", format: "json", ttlSeconds: 2 }, "register");
    await expect(memory.refresh(source.id, { key: "unapproved" })).rejects.toThrow("approved");
    memory.approveSource(source.id, source.revision, true, "approve");
    const refresh = await memory.refresh(source.id, { key: "refresh" });
    expect(await memory.refresh(source.id, { key: "refresh" })).toEqual(refresh);
    at = 3000; rows = [{ id: "one", title: "Visible entity", status: "closed" }];
    await memory.refresh(source.id, { key: "correction" });
    const snapshot = memory.recall({ depth: 2 });
    const historical = memory.recall({ asOf: 2000 });
    broken = true;
    for (let n = 0; n < 3; n++) await memory.refresh(source.id, { key: `failed:${n}` });
    expect(memory.sources()[0]?.enabled).toBe(false);
    memory.forget("note", corrected.id, "forget");
    expect(memory.get(first.id)).toBeNull(); expect(memory.get(derived.id)).toBeNull();
    expect(() => memory.remember(claim("note"), write("one"))).toThrow("forgotten");
    const events = memory.journal.events(memory.scope);
    const rebuilt = memory.rebuild();
    return { snapshot, historical, events, rebuilt, after: memory.recall(), source: memory.sources(), archive: memory.exportArchive() };
  } finally { memory.close(); }
}

describe("native Cloudflare storage adapter", () => {
  test("offline read-only storage exports exact native journal bytes and rejects writes", () => {
    const directory = mkdtempSync("/tmp/entity-learn-readonly-");
    const path = `${directory}/memory.sqlite`;
    try {
      const source = new NodeMemory({ path, scope: "owner:a" });
      source.remember(claim("note"), write("one"));
      const expected = source.exportArchive(); source.close();
      const before = readFileSync(path);
      const memory = new Memory({ storage: nodeStorage(path, { readonly: true }), scope: "owner:a" });
      try {
        expect(memory.exportArchive()).toEqual(expected);
        expect(() => memory.remember(claim("other"), write("two"))).toThrow();
      } finally { memory.close(); }
      expect(readFileSync(path)).toEqual(before);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("identical native observations, idempotency, corrections, normalization, revocation and journal roots", async () => {
    const fixture = durableStorage();
    try {
      const native = await history(options => new NodeMemory({ ...options, path: ":memory:" }));
      const durable = await history(options => new Memory({ ...options, storage: cloudflareStorage(fixture.storage) }));
      expect(durable).toEqual(native);
      expect(fixture.transactions()).toBeGreaterThan(20);
    } finally { fixture.db.close(); }
  });

  test("failed projection rolls back journal, artifact and head as one native transaction", () => {
    const fixture = durableStorage();
    try {
      const memory = new Memory({ storage: cloudflareStorage(fixture.storage), scope: "owner:a", clock: () => 1000 });
      fixture.db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON heads BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END;");
      expect(() => memory.remember(claim("atomic"), write("atomic"))).toThrow("injected projection failure");
      for (const table of ["journal", "artifacts", "observations", "heads"])
        expect(fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
      fixture.db.exec("DROP TRIGGER fail_projection");
      expect(memory.remember(claim("atomic"), write("atomic")).subject).toBe("atomic");
    } finally { fixture.db.close(); }
  });

  test("same-account handles share storage; close preserves host-owned storage; foreign scope stays sealed", () => {
    const fixture = durableStorage();
    try {
      const options = { storage: cloudflareStorage(fixture.storage), scope: "owner:a", clock: () => 1000 };
      const first = new Memory(options);
      const saved = first.remember(claim("private", "Account A only"), write("first"));
      first.close();
      const reopened = new Memory(options);
      expect(reopened.get(saved.id)?.observation).toEqual(saved);
      const foreign = new Memory({ ...options, scope: "owner:b" });
      expect(foreign.get(saved.id)).toBeNull();
      expect(foreign.recall().items).toEqual([]);
      expect(() => foreign.remember({ ...claim("foreign"), supports: [saved.id] }, write("foreign"))).toThrow("unavailable");
      foreign.close(); reopened.close();
    } finally { fixture.db.close(); }
  });

  test("Worker source file access is absent unless explicitly mounted; pure validation retains native rejection", () => {
    const fixture = durableStorage();
    try {
      const memory = new Memory({ storage: cloudflareStorage(fixture.storage), scope: "owner:a" });
      expect(() => memory.registerSource({ id: "file", namespace: "file", type: "file", resolver: "file",
        locator: "/etc/passwd", format: "text", ttlSeconds: 10 }, "register")).toThrow("not mounted file sources");
      expect(memory.sources()).toEqual([]);
      expect(() => validateRememberInput(claim("secret", { password: "not-memory" }))).toThrow("Credential");
      expect(() => validateRememberInput({ ...claim("owner"), scope: "other" })).toThrow("Unknown field");
      expect(validateRememberInput(claim("note"))).toEqual(claim("note"));
    } finally { fixture.db.close(); }
  });

  test("Worker entry bundle has no reachable filesystem, SQLite or child-process module", async () => {
    const bundled = await Bun.build({ entrypoints: [new URL("../lib/cloudflare.ts", import.meta.url).pathname],
      target: "browser", format: "esm", external: ["node:*" ] });
    expect(bundled.success).toBe(true);
    const code = await bundled.outputs[0]!.text();
    expect(code).not.toMatch(/(?:storage-node|sources-node|lib\/memory\.ts)/);
    expect(code).not.toMatch(/node:(?:fs|sqlite|child_process)|bun:sqlite/);
    expect(code).toContain("memory-core.ts");
    expect(code).toContain("journal.ts");
    expect(code).toContain("recall.ts");
  });

  test("full native archive moves Node history to DO SQLite without changing citations, replay receipts or revocations", async () => {
    const original = await history(options => new NodeMemory({ ...options, path: ":memory:" }));
    const fixture = durableStorage();
    try {
      const memory = new Memory({ storage: cloudflareStorage(fixture.storage), scope: "owner:a", clock: () => 3000 });
      expect(memory.importArchive(original.archive)).toEqual(original.rebuilt);
      expect(memory.exportArchive()).toEqual(original.archive);
      expect(memory.journal.events(memory.scope)).toEqual(original.events);
      expect(memory.recall()).toEqual(original.after);
      expect(memory.sources()).toEqual(original.source);
      expect(() => memory.remember(claim("note"), write("one"))).toThrow("forgotten");
      await expect(memory.refresh("fixture", { key: "still-revoked" })).rejects.toThrow("approved");
      expect(() => memory.importArchive(original.archive)).toThrow("empty destination");
      memory.close();
      const reopened = new Memory({ storage: cloudflareStorage(fixture.storage), scope: "owner:a", clock: () => 3000 });
      expect(reopened.rebuild()).toEqual(original.rebuilt);
    } finally { fixture.db.close(); }
  });

  test("archive restore refuses foreign scope and tampering, and failed root verification leaves every table empty", async () => {
    const original = await history(options => new NodeMemory({ ...options, path: ":memory:" }));
    const fixture = durableStorage();
    try {
      const options = { storage: cloudflareStorage(fixture.storage), scope: "owner:a" };
      const memory = new Memory(options);
      expect(() => new Memory({ ...options, scope: "owner:b" }).importArchive(original.archive)).toThrow("another scope");
      const changed = structuredClone(original.archive);
      changed.artifacts[0]!.body = JSON.stringify("tampered memory");
      expect(() => memory.importArchive(changed)).toThrow("integrity");
      expect(() => memory.importArchive({ ...original.archive, root: "0".repeat(64) })).toThrow("root mismatch");
      for (const table of ["journal", "artifacts", "observations", "heads", "sources"])
        expect(fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
      expect(memory.importArchive(original.archive)).toEqual(original.rebuilt);
      const foreign = new Memory({ ...options, scope: "owner:b" });
      foreign.remember(claim("foreign"), write("foreign"));
      expect(() => memory.exportArchive()).toThrow("single-scope store");
    } finally { fixture.db.close(); }
  });
});
