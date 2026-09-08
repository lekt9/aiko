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

for (const backend of ["node", "cloudflare"] as const) {
  test(`indexed journal receipt preserves interleaved scope ordinals and hydrates only its event (${backend})`, () => {
    const directory = mkdtempSync("/tmp/entity-learn-receipt-");
    const durable = backend === "cloudflare" ? durableStorage() : undefined;
    const path = `${directory}/receipt.sqlite`;
    let storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
    try {
      let a = new Memory({ storage, scope: "owner:a", clock: () => 1000 });
      const b = new Memory({ storage, scope: "owner:b", clock: () => 1000 });
      a.remember(claim("first"), write("a-first"));
      b.remember(claim("foreign-first"), write("shared-key"));
      const observation = a.remember(claim("target"), write("shared-key"));
      const original = a.journal.receipt(a.scope, "shared-key")!;
      expect(original.seq).toBe(3);
      expect(original.scopeVersion).toBe(2);
      expect(original.event.observations).toEqual([observation]);
      expect(a.journal.prior(a.scope, "shared-key", original.event.requestDigest)).toEqual(original.event);
      expect(() => a.journal.prior(a.scope, "shared-key", "different")).toThrow("different input");
      expect(b.journal.receipt(b.scope, "shared-key")?.scopeVersion).toBe(1);
      expect(b.journal.receipt(b.scope, "a-first")).toBeUndefined();
      expect(a.journal.receipt(a.scope, "missing")).toBeUndefined();
      const unrelated = a.remember(claim("later", { text: "separate artifact" }), write("a-later"));
      b.remember(claim("foreign-later"), write("b-later"));
      expect(a.journal.receipt(a.scope, "shared-key")).toEqual(original);
      const keyPlan = storage.prepare("EXPLAIN QUERY PLAN SELECT * FROM journal WHERE scope=? AND request_key=?").all(a.scope, "shared-key");
      const ordinalPlan = storage.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM journal WHERE scope=? AND seq<=?").all(a.scope, original.seq);
      expect(JSON.stringify(keyPlan)).toContain("sqlite_autoindex_journal_1");
      expect(JSON.stringify(ordinalPlan)).toContain("COVERING INDEX journal_scope_seq");
      expect(JSON.stringify(ordinalPlan)).toContain("seq<?");
      // A real missing unrelated payload must not prevent recovery of this receipt.
      storage.prepare("DELETE FROM artifacts WHERE digest=?").run(unrelated.payloadDigest);
      expect(a.journal.receipt(a.scope, "shared-key")).toEqual(original);
      expect(() => a.journal.events(a.scope)).toThrow("artifact is missing");
      storage.close();
      storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
      a = new Memory({ storage, scope: "owner:a" });
      expect(a.journal.receipt(a.scope, "shared-key")).toEqual(original);
      expect(a.journal.scopeVersion(a.scope)).toBe(3);
      // The requested event's missing bytes still fail closed.
      storage.prepare("DELETE FROM artifacts WHERE digest=?").run(observation.payloadDigest);
      expect(() => a.journal.receipt(a.scope, "shared-key")).toThrow("artifact is missing");
    } finally {
      storage.close();
      durable?.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const backend of ["node", "cloudflare"] as const) {
  test(`receipt rejects stored-row corruption without claiming whole-chain verification (${backend})`, () => {
    const durable = backend === "cloudflare" ? durableStorage() : undefined;
    const storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(":memory:");
    try {
      const memory = new Memory({ storage, scope: "owner:a" });
      memory.remember(claim("target"), write("receipt"));
      const original = memory.journal.receipt(memory.scope, "receipt")!;
      const saved = storage.prepare("SELECT * FROM journal WHERE request_key=?").get("receipt")!;
      for (const [column, value] of [
        ["digest", "0".repeat(64)], ["previous", "1".repeat(64)],
        ["body", String(saved.body).replace('"recordedAt":', '"recordedAt":1,"ignored":')],
        ["request_digest", "f".repeat(64)], ["seq", 0], ["seq", 9007199254740992],
      ] as const) {
        storage.prepare(`UPDATE journal SET ${column}=? WHERE request_key=?`).run(value, "receipt");
        // The SQLite driver itself may reject an unsafe integer before Journal sees it.
        expect(() => memory.journal.receipt(memory.scope, "receipt")).toThrow();
        storage.prepare(`UPDATE journal SET ${column}=? WHERE request_key=?`).run(saved[column] as SqlValue, "receipt");
        expect(memory.journal.receipt(memory.scope, "receipt")).toEqual(original);
      }
      memory.remember(claim("later"), write("later"));
      const later = memory.journal.receipt(memory.scope, "later")!;
      storage.prepare("UPDATE journal SET digest=? WHERE request_key=?").run("0".repeat(64), "receipt");
      // A valid later row is not a witness that its parent still exists unaltered.
      expect(memory.journal.receipt(memory.scope, "later")).toEqual(later);
      expect(() => memory.rebuild()).toThrow();
    } finally { storage.close(); durable?.db.close(); }
  });
}

for (const backend of ["node", "cloudflare"] as const) {
  test(`scope erasure removes live private copies, retires replay and preserves shared foreign custody (${backend})`, () => {
    const durable = backend === "cloudflare" ? durableStorage() : undefined;
    const dir = mkdtempSync("/tmp/entity-learn-erasure-");
    const path = `${dir}/memory.sqlite`;
    let storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
    try {
      let a = new Memory({ storage, scope: "owner:a" });
      const b = new Memory({ storage, scope: "owner:b" });
      const secret = "erase-private-marker-987";
      const one = a.remember({ ...claim("private-subject-987", secret), title: "private-title-987" }, write("private-key-987"));
      a.remember({ ...claim("private-derived-987", { quote: secret }), supports: [one.id] }, write("derived"));
      const shared = a.remember(claim("shared", "shared-body"), write("shared"));
      const foreign = b.remember(claim("foreign", "shared-body"), write("foreign"));
      expect(shared.payloadDigest).toBe(foreign.payloadDigest);
      const foreignReceipt = b.journal.receipt(b.scope, "foreign");
      a.journal.putDerived(a.scope, "fixture", "private-cache", { quote: secret });
      const version = a.journal.scopeVersion(a.scope);
      expect(() => a.eraseScope(version - 1, "erase-request")).toThrow("exact current scope version");
      expect(a.get(one.id)).not.toBeNull();
      expect(a.eraseScope(version, "erase-request")).toEqual({ scope: a.scope, erased: true, retired: true });
      expect(a.eraseScope(version, "erase-request")).toEqual({ scope: a.scope, erased: true, retired: true });
      expect(() => a.eraseScope(version, "changed-request")).toThrow("different input");
      expect(a.get(one.id)).toBeNull();
      expect(() => a.remember(claim("new"), write("new"))).toThrow("permanently erased");
      expect(() => a.journal.putDerived(a.scope, "fixture", "late", "late-private")).toThrow("permanently erased");
      expect(() => a.journal.receipt(a.scope, "private-key-987")).toThrow("permanently erased");
      expect(() => a.remember(claim("private-subject-987", secret), write("private-key-987"))).toThrow("permanently erased");
      for (const table of ["journal", "artifacts", "observations", "heads", "sources", "derived"]) {
        const bytes = JSON.stringify(storage.prepare(`SELECT * FROM ${table}`).all());
        for (const marker of [secret, "private-subject-987", "private-title-987", "private-key-987", "private-derived-987"])
          expect(bytes).not.toContain(marker);
      }
      expect(b.get(foreign.id)?.observation.payload).toBe("shared-body");
      expect(b.journal.receipt(b.scope, "foreign")).toEqual(foreignReceipt);
      a.rebuild();
      expect(a.recall().items).toEqual([]);
      expect(b.get(foreign.id)?.observation.payload).toBe("shared-body");
      storage.close();
      storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
      a = new Memory({ storage, scope: "owner:a" });
      expect(a.eraseScope(version, "erase-request").erased).toBe(true);
      expect(a.get(one.id)).toBeNull();
      a.rebuild();
      // Tampering with a replacement is not accepted as the old committed row.
      storage.prepare("UPDATE journal SET body=replace(body, 'erased', 'broken') WHERE scope=? AND request_key=?").run(a.scope, "erased:1");
      expect(() => a.rebuild()).toThrow();
    } finally { storage.close(); durable?.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("scope erasure archive imports tombstones without restoring payloads and rolls back failed erasure", () => {
  const storage = nodeStorage(":memory:");
  const memory = new Memory({ storage, scope: "owner:a" });
  try {
    const saved = memory.remember(claim("sensitive-title", "sensitive-payload"), write("first"));
    const version = memory.journal.scopeVersion(memory.scope);
    storage.exec("CREATE TRIGGER fail_erase BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT, 'erase-failed'); END;");
    expect(() => memory.eraseScope(version, "erase")).toThrow("erase-failed");
    expect(memory.get(saved.id)?.observation.payload).toBe("sensitive-payload");
    storage.exec("DROP TRIGGER fail_erase;");
    memory.rebuild();
    memory.eraseScope(version, "erase");
    const archive = memory.exportArchive();
    expect(JSON.stringify(archive)).not.toContain("sensitive-payload");
    expect(JSON.stringify(archive)).not.toContain("sensitive-title");
    const restored = new NodeMemory({ path: ":memory:", scope: "owner:a" });
    try {
      restored.importArchive(archive);
      expect(restored.get(saved.id)).toBeNull();
      expect(restored.eraseScope(version, "erase").retired).toBe(true);
      expect(() => restored.remember(claim("again"), write("again"))).toThrow("permanently erased");
      expect(restored.exportArchive()).toEqual(archive);
    } finally { restored.close(); }
  } finally { memory.close(); }
});

test("an in-flight source refresh cannot restore bytes after scope erasure", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const memory = new NodeMemory({ path: ":memory:", scope: "owner:a", adapters: {
    fixture: async () => { entered(); await gate; return { data: [{ id: "one", title: "late-private-title", value: "late-private-bytes" }] }; },
  } });
  try {
    const source = memory.registerSource({ id: "source", namespace: "private-source", type: "note", resolver: "adapter",
      locator: "fixture", format: "json", ttlSeconds: 100 }, "register");
    memory.approveSource(source.id, source.revision, true, "approve");
    const running = memory.refresh(source.id, { key: "pending" });
    await started;
    memory.eraseScope(memory.journal.scopeVersion(memory.scope), "erase-running");
    release();
    await expect(running).rejects.toMatchObject({ code: "erased" });
    expect(JSON.stringify(memory.exportArchive())).not.toContain("late-private");
    memory.rebuild();
    expect(memory.recall().items).toEqual([]);
  } finally { release(); memory.close(); }
});

for (const backend of ["node", "cloudflare"] as const) {
  test(`successive selective erasures preserve a mixed refresh, same-scope data and foreign shared bytes (${backend})`, async () => {
    const durable = backend === "cloudflare" ? durableStorage() : undefined;
    const dir = mkdtempSync("/tmp/entity-learn-selective-");
    const path = `${dir}/memory.sqlite`;
    let storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
    let calls = 0;
    const adapters = { fixture: async () => { calls++; return { data: [
      { id: "remove-a", title: "private-title-alpha", value: "private-alpha" },
      { id: "remove-b", title: "private-title-beta", value: "private-beta" },
      { id: "keep-c", title: "Keep unrelated", value: "unrelated" },
    ] }; } };
    try {
      let a = new Memory({ storage, scope: "owner:a", adapters });
      const b = new Memory({ storage, scope: "owner:b" });
      const source = a.registerSource({ id: "batch", namespace: "batch", type: "note", resolver: "adapter", locator: "fixture", format: "json", ttlSeconds: 10000 }, "register");
      a.approveSource(source.id, source.revision, true, "approve");
      await a.refresh(source.id, { key: "mixed" });
      const original = a.journal.receipt(a.scope, "mixed")!;
      const [oa, ob, oc] = original.event.observations;
      const foreign = b.remember(claim("foreign", oa!.payload), write("foreign"));
      expect(foreign.payloadDigest).toBe(oa!.payloadDigest);
      const foreignReceipt = b.journal.receipt(b.scope, "foreign");
      const unrelated = a.remember(claim("unrelated-manual", "keep-manual"), write("manual"));
      const manualReceipt = a.journal.receipt(a.scope, "manual");
      const derived = a.remember({ ...claim("known-quote", "private-alpha"), title: "private-derived-title", supports: [oa!.id] }, write("quote"));
      a.remember({ ...claim("known-quote", "older-quote-now-corrected"), supersedes: derived.id }, write("quote-correction"));
      const requestA = { subject: oa!.subject, expectedHead: oa!.id, expectedScopeVersion: a.journal.scopeVersion(a.scope), key: "erase-a" };
      expect(a.eraseSubject(requestA)).toMatchObject({ erased: true, retired: false, subjects: 2, observations: 3 });
      expect(a.get(oa!.id)).toBeNull(); expect(a.get(derived.id)).toBeNull();
      expect(a.get(ob!.id)?.observation).toEqual(ob!);
      expect(a.get(oc!.id)?.observation).toEqual(oc!);
      expect(a.journal.receipt(a.scope, "manual")).toEqual(manualReceipt);
      await expect(a.refresh(source.id, { key: "mixed" })).rejects.toMatchObject({ code: "erased" });
      expect(calls).toBe(1);
      const requestB = { subject: ob!.subject, expectedHead: ob!.id, expectedScopeVersion: a.journal.scopeVersion(a.scope), key: "erase-b" };
      a.eraseSubject(requestB);
      const proofs = a.journal.events(a.scope).filter(r => r.event.operation === "erase-subject");
      const first = proofs[0]!.event.erasure!.rows.find(r => r.seq === original.seq)!;
      expect(proofs[1]!.event.erasure!.rows.find(r => r.seq === original.seq)?.previousReplacement).toBe(first.replacement);
      for (const marker of ["private-alpha", "private-beta", "private-title", "private-derived-title", "known-quote", "remove-a", "remove-b"])
        expect(JSON.stringify(a.journal.events(a.scope))).not.toContain(marker);
      expect(b.get(foreign.id)?.observation).toEqual(foreign);
      expect(b.journal.receipt(b.scope, "foreign")).toEqual(foreignReceipt);
      a.rebuild();
      expect(a.get(oc!.id)?.state).toBe("current");
      expect(a.get(unrelated.id)?.observation).toEqual(unrelated);
      expect(a.sources()[0]).toEqual(original.event.source!);
      expect(a.eraseSubject(requestA).observations).toBe(3);
      expect(() => a.eraseSubject({ ...requestA, expectedHead: oc!.id })).toThrow("different input");
      storage.close(); storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
      a = new Memory({ storage, scope: "owner:a", adapters });
      expect(a.eraseSubject(requestB).retired).toBe(false);
      expect(() => a.remember(claim(oa!.subject, "reintroduced"), write("new-a"))).toThrow("erased");
      const fresh = await a.refresh(source.id, { key: "fresh-source-read" });
      expect(fresh.observations).toHaveLength(1);
      expect(a.get(fresh.observations[0]!)?.observation.subject).toBe(oc!.subject);
      expect(a.get(unrelated.id)?.observation).toEqual(unrelated);
      a.rebuild();
      // Whole-scope retirement remains separately callable after selective proofs.
      a.eraseScope(a.journal.scopeVersion(a.scope), "explicit-entire-scope");
      a.rebuild();
      expect(new Memory({ storage, scope: "owner:b" }).get(foreign.id)?.observation).toEqual(foreign);
    } finally { storage.close(); durable?.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("selective erasure preserves history elsewhere, imports fences and rejects modified cumulative archives", () => {
  const memory = new NodeMemory({ path: ":memory:", scope: "owner:a" });
  const input = claim("remove-history", "first-private-history");
  try {
    const first = memory.remember(input, write("first"));
    const last = memory.remember({ ...input, payload: "last-private-history", supersedes: first.id }, write("last"));
    const keep = memory.remember(claim("keep-history", "keep-first"), write("keep-first"));
    const keepLast = memory.remember({ ...claim("keep-history", "keep-last"), supersedes: keep.id }, write("keep-last"));
    const request = { subject: first.subject, expectedHead: last.id, expectedScopeVersion: memory.journal.scopeVersion(memory.scope), key: "erase-history" };
    expect(() => memory.eraseSubject({ ...request, expectedHead: first.id })).toThrow("exact current observation");
    const result = memory.eraseSubject(request);
    expect(result.observationIds).toEqual([first.id, last.id].sort());
    expect(memory.get(keep.id)?.state).toBe("superseded");
    expect(memory.get(keepLast.id)?.state).toBe("current");
    memory.journal.putDerived(memory.scope, "fixture", first.id, { stale: "late-private-history" });
    expect(memory.journal.derived(memory.scope, "fixture", first.id)).toBeUndefined();
    const archive = memory.exportArchive();
    expect(JSON.stringify(archive)).not.toContain("private-history");
    expect(JSON.stringify(archive)).not.toContain("remove-history");
    const restore = new NodeMemory({ path: ":memory:", scope: memory.scope });
    try {
      restore.importArchive(archive);
      expect(restore.eraseSubject(request)).toEqual(result);
      expect(restore.get(first.id)).toBeNull();
      expect(restore.get(keepLast.id)?.observation).toEqual(keepLast);
      expect(() => restore.remember(input, write("resurrect"))).toThrow("erased");
      restore.rebuild();
      expect(restore.exportArchive()).toEqual(archive);
    } finally { restore.close(); }
    for (const mutation of ["replacement", "artifact", "scope"] as const) {
      const bad = structuredClone(archive);
      if (mutation === "replacement") {
        const row = bad.journal.find(r => JSON.parse(r.body).operation === "erase-subject")!;
        row.body = row.body.replace(/"replacement":"[a-f0-9]+"/, `"replacement":"${"0".repeat(64)}"`);
      } else if (mutation === "artifact") bad.artifacts.push({ digest: first.payloadDigest, body: JSON.stringify(first.payload) });
      else bad.scope = "owner:b";
      const target = new NodeMemory({ path: ":memory:", scope: memory.scope });
      try {
        expect(() => target.importArchive(bad)).toThrow();
        expect(target.journal.scopeVersion(target.scope)).toBe(0);
      } finally { target.close(); }
    }
  } finally { memory.close(); }
});

test("cumulative erasure rejects a rehashed manifest with a broken predecessor commitment", async () => {
  const { canonical, digest } = await import("../lib/codec.js");
  const storage = nodeStorage(":memory:");
  const memory = new Memory({ storage, scope: "owner:a", adapters: { fixture: async () => ({ data: [{ id: "a", title: "a" }, { id: "b", title: "b" }, { id: "c", title: "c" }] }) } });
  try {
    const source = memory.registerSource({ id: "batch", namespace: "batch", type: "note", resolver: "adapter", locator: "fixture", format: "json", ttlSeconds: 1000 }, "register");
    memory.approveSource(source.id, source.revision, true, "approve");
    const result = await memory.refresh(source.id, { key: "read" });
    const [a, b] = result.observations.map(id => memory.get(id)!.observation);
    memory.eraseSubject({ subject: a!.subject, expectedHead: a!.id, expectedScopeVersion: memory.journal.scopeVersion(memory.scope), key: "erase-a" });
    // A failure during artifact collection must roll back row replacement, fences and heads.
    storage.exec("CREATE TRIGGER fail_selective BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'gc-failure'); END;");
    const request = { subject: b!.subject, expectedHead: b!.id, expectedScopeVersion: memory.journal.scopeVersion(memory.scope), key: "erase-b" };
    expect(() => memory.eraseSubject(request)).toThrow("gc-failure");
    expect(memory.get(b!.id)?.observation).toEqual(b!);
    memory.rebuild();
    storage.exec("DROP TRIGGER fail_selective;");
    memory.eraseSubject(request);
    const archive = memory.exportArchive();
    const row = archive.journal.at(-1)!;
    const event = JSON.parse(row.body);
    event.erasure.rows[0].previousReplacement = "0".repeat(64);
    row.body = canonical(event);
    row.digest = digest("entity-learn.journal/v1", { seq: row.seq, previous: row.previous, event });
    archive.root = row.digest;
    const target = new NodeMemory({ path: ":memory:", scope: memory.scope });
    try {
      expect(() => target.importArchive(archive)).toThrow("cumulative erasure proof");
      expect(target.journal.scopeVersion(target.scope)).toBe(0);
    } finally { target.close(); }
  } finally { memory.close(); }
});

for (const backend of ["node", "cloudflare"] as const) {
  test(`pre-erasure archive cannot roll back retained receipts or hydrate before target rejection (${backend})`, async () => {
    const durable = backend === "cloudflare" ? durableStorage() : undefined;
    const dir = mkdtempSync("/tmp/entity-erasure-restore-");
    const path = `${dir}/memory.sqlite`;
    let storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
    try {
      let memory = new Memory({ storage, scope: "owner:a", adapters: { fixture: async () => ({ data: [
        { id: "a", title: "private-alpha", text: "private-alpha-body" },
        { id: "b", title: "private-beta", text: "private-beta-body" },
        { id: "c", title: "retained", text: "keep-body" },
      ] }) } });
      const source = memory.registerSource({ id: "batch", namespace: "batch", type: "note", resolver: "adapter", locator: "fixture", format: "json", ttlSeconds: 10000 }, "register");
      memory.approveSource(source.id, source.revision, true, "approve");
      const batch = await memory.refresh(source.id, { key: "mixed" });
      const [a, b, c] = batch.observations.map(id => memory.get(id)!.observation);
      memory.remember({ ...claim("known-dependent", "private-alpha-body"), supports: [a!.id] }, write("dependent"));
      const old = memory.exportArchive();
      expect(JSON.stringify(old)).toContain("private-alpha-body");
      // Boundary witness: without the retained journal a fresh store cannot know
      // that this valid archive will later be superseded by an erasure receipt.
      const noFence = new NodeMemory({ path: ":memory:", scope: memory.scope });
      try {
        noFence.importArchive(old);
        expect(noFence.get(a!.id)?.observation).toEqual(a!);
      } finally { noFence.close(); }
      for (const target of [a!, b!]) memory.eraseSubject({ subject: target.subject, expectedHead: target.id,
        expectedScopeVersion: memory.journal.scopeVersion(memory.scope), key: `erase-${target.id}` });
      const current = memory.exportArchive();
      expect(JSON.stringify(current)).not.toContain("private-alpha");
      expect(JSON.stringify(current)).not.toContain("private-beta");
      expect(memory.sources()[0]?.revision).toBe(source.revision);
      expect(() => memory.importArchive(old)).toThrow("empty destination");
      let candidateReads = 0;
      const unopened = new Proxy(old, { get(target, property, receiver) { candidateReads++; return Reflect.get(target, property, receiver); } });
      expect(() => memory.importArchive(unopened)).toThrow("empty destination");
      expect(candidateReads).toBe(0);
      expect(memory.exportArchive()).toEqual(current);
      // Erasure authority is in the journal, not a disposable head/source projection.
      storage.exec("DELETE FROM observations; DELETE FROM heads; DELETE FROM sources;");
      storage.close(); storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
      memory = new Memory({ storage, scope: "owner:a" });
      expect(() => memory.importArchive(old)).toThrow("empty destination");
      memory.rebuild();
      expect(memory.get(a!.id)).toBeNull(); expect(memory.get(b!.id)).toBeNull();
      expect(memory.get(c!.id)?.observation).toEqual(c!);
      expect(memory.sources()[0]?.revision).toBe(source.revision);
      expect(memory.exportArchive()).toEqual(current);
      const restored = new NodeMemory({ path: ":memory:", scope: memory.scope });
      try {
        restored.importArchive(current); restored.rebuild();
        expect(restored.get(a!.id)).toBeNull(); expect(restored.get(c!.id)?.observation).toEqual(c!);
        expect(() => restored.remember(claim(a!.subject), write("restore-again"))).toThrow("erased");
      } finally { restored.close(); }
      memory.eraseScope(memory.journal.scopeVersion(memory.scope), "retire-all");
      expect(() => memory.importArchive(old)).toThrow("empty destination");
      memory.rebuild(); expect(memory.recall().items).toEqual([]);
    } finally { storage.close(); durable?.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const backend of ["node", "cloudflare"] as const) {
  test(`navigational links are rewritten with new canonical IDs without deleting linked facts (${backend})`, async () => {
    const durable = backend === "cloudflare" ? durableStorage() : undefined;
    const dir = mkdtempSync("/tmp/entity-navigation-erasure-");
    const path = `${dir}/memory.sqlite`;
    let storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
    const links = [{ subject: "batch/note/private-a", relation: "see-also" }, { subject: "batch/note/private-b", relation: "related" }];
    let reads = 0;
    const adapters = { fixture: async () => { reads++; return { data: [
      { id: "private-a", title: "private-a-title", value: "private-a-bytes" },
      { id: "private-b", title: "private-b-title", value: "private-b-bytes" },
      { id: "kept", title: "Keep independent", value: "unrelated-payload" },
    ], links: { "batch/note/kept": links } }; } };
    try {
      let memory = new Memory({ storage, scope: "owner:a", adapters });
      const source = memory.registerSource({ id: "batch", namespace: "batch", type: "note", resolver: "adapter", locator: "fixture", format: "json", ttlSeconds: 10000 }, "register");
      memory.approveSource(source.id, source.revision, true, "approve");
      const batch = await memory.refresh(source.id, { key: "mixed-linked" });
      const [a, b, linked] = batch.observations.map(id => memory.get(id)!.observation);
      const initialInput = { ...claim("independent-history", "first-independent-payload"), links };
      const first = memory.remember(initialInput, write("independent-first"));
      const last = memory.remember({ ...initialInput, payload: "last-independent-payload", supersedes: first.id }, write("independent-last"));
      const dependent = memory.remember({ ...claim("depends-on-independent", "keep-derived-payload"), supports: [first.id], dependsOn: [last.id] }, write("keep-derived"));
      const copied = memory.remember({ ...claim("actually-copied", "private-a-bytes"), supports: [a!.id] }, write("copied"));
      const erase = (o: NonNullable<typeof a>, key: string) => memory.eraseSubject({ subject: o.subject, expectedHead: o.id, expectedScopeVersion: memory.journal.scopeVersion(memory.scope), key });
      const one = erase(a!, "erase-a-link");
      expect(one.observationIds.sort()).toEqual([a!.id, copied.id].sort());
      expect(one.observationIds).not.toContain(linked!.id);
      const linked1 = one.replacements.find(r => r.previous === linked!.id)!.observation;
      expect(linked1).not.toBe(linked!.id);
      expect(memory.get(linked!.id)).toBeNull();
      expect(memory.get(linked1)?.observation).toMatchObject({ payload: linked!.payload, links: [links[1]!] });
      const dependent1 = one.replacements.find(r => r.previous === dependent.id)!.observation;
      expect(memory.get(dependent1)?.state).toBe("current");
      expect(memory.get(dependent1)?.freshness).not.toBe("stale");
      const two = erase(b!, "erase-b-link");
      expect(two.observationIds).toEqual([b!.id]);
      const linked2 = two.replacements.find(r => r.previous === linked1)!.observation;
      expect(linked2).not.toBe(linked1);
      expect(memory.get(linked1)).toBeNull();
      memory.journal.putDerived(memory.scope, "fixture", linked1, { staleLink: "private-b" });
      expect(memory.journal.derived(memory.scope, "fixture", linked1)).toBeUndefined();
      expect(memory.get(linked2)?.observation).toMatchObject({ payload: linked!.payload, links: [] });
      const history = memory.history(first.subject);
      expect(history).toHaveLength(2);
      expect(history.map(h => h.observation.payload).sort()).toEqual(["first-independent-payload", "last-independent-payload"].sort());
      expect(history.every(h => h.observation.links.length === 0)).toBe(true);
      expect(() => memory.remember(initialInput, write("independent-first"))).toThrow("erased");
      await expect(memory.refresh(source.id, { key: "mixed-linked" })).rejects.toMatchObject({ code: "erased" });
      expect(reads).toBe(1);
      const archive = memory.exportArchive();
      expect(JSON.stringify(archive)).not.toContain("private-a");
      expect(JSON.stringify(archive)).not.toContain("private-b");
      memory.rebuild(); expect(memory.get(linked2)?.state).toBe("current");
      storage.close(); storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
      memory = new Memory({ storage, scope: "owner:a", adapters });
      expect(memory.get(linked2)?.observation.payload).toEqual(linked!.payload);
      expect(memory.history(first.subject)).toHaveLength(2);
      const fresh = memory.remember({ ...claim("new-navigation"), links }, write("fresh-navigation"));
      expect(fresh.links).toEqual([]);
      const next = await memory.refresh(source.id, { key: "new-linked-read" });
      expect(next.observations).toHaveLength(1);
      expect(memory.get(next.observations[0]!)?.observation.links).toEqual([]);
      const restored = new NodeMemory({ path: ":memory:", scope: memory.scope });
      try {
        restored.importArchive(archive); restored.rebuild();
        expect(restored.get(linked2)?.observation).toEqual({ ...linked!, id: linked2, links: [] });
        expect(restored.history(first.subject)).toHaveLength(2);
        expect(restored.get(a!.id)).toBeNull();
      } finally { restored.close(); }
    } finally { storage.close(); durable?.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const backend of ["node", "cloudflare"] as const) {
  test(`external erasure authority fences fresh archive restore (${backend})`, () => {
    const source = new NodeMemory({ path: ":memory:", scope: "owner:restore" });
    const durable = backend === "cloudflare" ? durableStorage() : undefined;
    const dir = mkdtempSync("/tmp/entity-restore-authority-");
    const path = `${dir}/memory.sqlite`;
    let storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
    let authority: ReturnType<typeof source.erasureFence> | undefined;
    const target = new Memory({ storage, scope: source.scope, restoreAuthority: () => authority });
    try {
      const a = source.remember(claim("secret-a", "private-a"), write("a"));
      const b = source.remember(claim("secret-b", "private-b"), write("b"));
      const kept = source.remember({ ...claim("kept", "independent"), links: [
        { subject: a.subject, relation: "see" }, { subject: b.subject, relation: "see" }] }, write("kept"));
      const old = source.exportArchive();
      expect(() => target.importArchive(new Proxy({}, { get() { throw Error("archive inspected"); } }))).toThrow("authority");
      source.eraseSubject({ subject: a.subject, expectedHead: a.id, expectedScopeVersion: source.journal.scopeVersion(source.scope), key: "erase-a" });
      const middle = source.exportArchive();
      source.eraseSubject({ subject: b.subject, expectedHead: b.id, expectedScopeVersion: source.journal.scopeVersion(source.scope), key: "erase-b" });
      authority = source.erasureFence();
      const latestAuthority = authority;
      authority = { ...authority, seq: 0, digest: "0".repeat(64) };
      expect(() => target.importArchive(source.exportArchive())).toThrow("fence");
      authority = latestAuthority;
      expect(() => target.importArchive(old)).toThrow("fence");
      expect(() => target.importArchive(middle)).toThrow("fence");
      expect(storage.prepare("SELECT COUNT(*) AS n FROM artifacts").get()!.n).toBe(0);
      const correct = authority;
      authority = { ...correct, scope: "foreign" };
      expect(() => target.importArchive(source.exportArchive())).toThrow("authority");
      authority = correct;
      const forged = source.exportArchive();
      forged.journal[correct.seq - 1]!.body = forged.journal[correct.seq - 1]!.body.replace('"erase-subject"', '"remember"');
      expect(() => target.importArchive(forged)).toThrow();
      expect(storage.prepare("SELECT COUNT(*) AS n FROM journal").get()!.n).toBe(0);
      target.importArchive(source.exportArchive()); target.rebuild();
      storage.close();
      storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(path);
      const reopened = new Memory({ storage, scope: source.scope, restoreAuthority: () => authority });
      expect(reopened.erasureFence()).toEqual(correct);
      expect(reopened.get(a.id)).toBeNull(); expect(reopened.get(b.id)).toBeNull();
      expect(reopened.get(kept.id)).toBeNull();
      expect(reopened.history("kept")[0]!.observation).toMatchObject({ payload: "independent", links: [] });
      expect(JSON.stringify(reopened.exportArchive())).not.toContain("private-a");
      expect(JSON.stringify(reopened.exportArchive())).not.toContain("private-b");
    } finally { source.close(); storage.close(); durable?.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const backend of ["node", "cloudflare"] as const) {
  test(`erasure authority commits atomically and preflight is read only (${backend})`, () => {
    const durable = backend === "cloudflare" ? durableStorage() : undefined;
    const storage = durable ? cloudflareStorage(durable.storage) : nodeStorage(":memory:");
    storage.exec("CREATE TABLE host_authority (id INTEGER PRIMARY KEY, body TEXT)");
    let reject = false;
    const memory = new Memory({ storage, scope: "owner:atomic", restoreAuthority: () => {
      const row = storage.prepare("SELECT body FROM host_authority WHERE id=1").get();
      return row ? JSON.parse(String(row.body)).fence : undefined;
    }, onErasure: receipt => {
      storage.prepare("INSERT OR REPLACE INTO host_authority VALUES(1,?)").run(JSON.stringify(receipt));
      if (reject) throw Error("custody failed");
    } });
    try {
      const a = memory.remember(claim("a", "private-a"), write("a"));
      const b = memory.remember(claim("b", "private-b"), write("b"));
      memory.remember(claim("kept", "independent"), write("kept"));
      const old = memory.exportArchive();
      expect(() => memory.checkArchiveErasure(new Proxy({}, { get() { throw Error("inspected"); } }))).toThrow("authority");
      const input = { subject: a.subject, expectedHead: a.id, expectedScopeVersion: memory.journal.scopeVersion(memory.scope), key: "erase-a" };
      reject = true; expect(() => memory.eraseSubject(input)).toThrow("custody failed");
      expect(memory.exportArchive()).toEqual(old);
      expect(storage.prepare("SELECT body FROM host_authority").get()).toBeUndefined();
      reject = false; memory.eraseSubject(input);
      const first = JSON.parse(String(storage.prepare("SELECT body FROM host_authority").get()!.body));
      memory.eraseSubject({ subject: b.subject, expectedHead: b.id, expectedScopeVersion: memory.journal.scopeVersion(memory.scope), key: "erase-b" });
      const currentFence = memory.erasureFence();
      memory.eraseSubject(input);
      const replay = JSON.parse(String(storage.prepare("SELECT body FROM host_authority").get()!.body));
      expect(replay.receipt).toEqual(first.receipt); expect(replay.fence).toEqual(currentFence);
      const current = memory.exportArchive();
      expect(() => memory.checkArchiveErasure(old)).toThrow("fence");
      expect(memory.checkArchiveErasure(current)).toEqual({ scope: memory.scope, fence: currentFence, journalRows: current.journal.length, artifacts: current.artifacts.length, chainVerified: false });
      expect(memory.exportArchive()).toEqual(current);
      const foreign = new Memory({ storage, scope: memory.scope, restoreAuthority: () => ({ ...currentFence, scope: "foreign" }) });
      expect(() => foreign.checkArchiveErasure(new Proxy({}, { get() { throw Error("inspected"); } }))).toThrow("authority");
      const corrupt = structuredClone(current); corrupt.artifacts[0]!.body = '"wrong"';
      expect(() => memory.checkArchiveErasure(corrupt)).toThrow("integrity");
      expect(memory.exportArchive()).toEqual(current);
      const version = memory.journal.scopeVersion(memory.scope);
      reject = true; expect(() => memory.eraseScope(version, "all")).toThrow("custody failed");
      expect(memory.exportArchive()).toEqual(current);
      reject = false; memory.eraseScope(version, "all"); memory.eraseScope(version, "all");
      expect(JSON.parse(String(storage.prepare("SELECT body FROM host_authority").get()!.body)).fence).toEqual(memory.erasureFence());
      const legacy = new NodeMemory({ path: ":memory:", scope: memory.scope });
      try { expect(() => legacy.checkArchiveErasure(old)).toThrow("authority"); legacy.importArchive(old); } finally { legacy.close(); }
    } finally { storage.close(); durable?.db.close(); }
  });
}

test("original subject erasure keys resolve verified receipts without mutating history", () => {
  const storage = nodeStorage(":memory:");
  const memory = new Memory({ storage, scope: "owner:a" });
  try {
    const a = memory.remember(claim("a"), write("a"));
    expect(memory.subjectErasureReceipt("missing")).toBeUndefined();
    memory.eraseSubject({ subject: a.subject, expectedHead: a.id, expectedScopeVersion: 1, key: "original-tool-key" });
    const receipt = memory.subjectErasureReceipt("original-tool-key")!;
    expect(receipt.event.operation).toBe("erase-subject"); expect(receipt.seq).toBe(2); expect(receipt.scopeVersion).toBe(2);
    memory.remember(claim("unrelated"), write("later"));
    const archive = memory.exportArchive();
    expect(memory.subjectErasureReceipt("original-tool-key")).toEqual(receipt);
    expect(new Memory({ storage, scope: "owner:b" }).subjectErasureReceipt("original-tool-key")).toBeUndefined();
    expect(() => memory.subjectErasureReceipt("")).toThrow();
    expect(memory.exportArchive()).toEqual(archive);
    storage.prepare("DELETE FROM journal WHERE seq=1").run();
    expect(() => memory.subjectErasureReceipt("missing")).toThrow();
    expect(() => memory.subjectErasureReceipt("original-tool-key")).toThrow();
  } finally { storage.close(); }
});

test("subject erasure preparation binds exact committed identity without reserving a write", () => {
  const memory = new NodeMemory({ path: ":memory:", scope: "owner:prepare" });
  try {
    const a = memory.remember(claim("private-subject"), write("a"));
    const input = { subject: a.subject, expectedHead: a.id, expectedScopeVersion: 1, key: "original-tool" };
    const before = memory.exportArchive(), prepared = memory.prepareSubjectErasure(input);
    expect(memory.exportArchive()).toEqual(before);
    expect(JSON.stringify(prepared)).not.toContain("private-subject");
    expect(() => memory.prepareSubjectErasure({ ...input, expectedHead: "foreign" })).toThrow();
    memory.remember(claim("other"), write("other"));
    expect(() => memory.eraseSubject(input)).toThrow("scope version");
    const current = { ...input, expectedScopeVersion: 2 }, identity = memory.prepareSubjectErasure(current);
    memory.eraseSubject(current);
    const receipt = memory.subjectErasureReceipt(input.key)!;
    expect(receipt.event.key).toBe(identity.receiptKey);
    expect(receipt.event.requestDigest).toBe(identity.requestDigest);
    expect(memory.prepareSubjectErasure(current)).toEqual(identity);
    expect(() => memory.prepareSubjectErasure(input)).toThrow("conflict");
  } finally { memory.close(); }
});
