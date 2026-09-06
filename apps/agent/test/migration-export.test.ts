import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeStorage } from "entity-learn";
import { Memory } from "entity-learn/cloudflare";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { accountDirectory, accountThreadDatabase } from "../src/accounts.ts";
import { openMemory } from "../src/memory.ts";
import { acquireOfflineSourceLease, exportAikoCloudflare, type MigrationEnvelope } from "../src/migration-export.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function directory() {
  const path = mkdtempSync("/tmp/aiko-native-export-");
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function fixture(owners = ["123", "456"]) {
  const stateDir = directory(), destination = directory();
  const config: AikoConfig = {
    stateDir, mode: "demo", instanceId: "demo", port: 4242,
    operatorToken: "migration-operator-fixture-123456789012345",
    persona: PERSONA, voiceEnabled: false, allowedUsers: new Set(owners),
    planeCredentials: owners.map((account, i) => ({ account,
      digest: credentialDigest(`aiko_${String(i).repeat(44)}`), scopes: ["read", "write"] })),
  };
  const service = await createService(config);
  cleanup.push(() => service.close());
  for (const [index, owner] of owners.entries()) {
    const response = await service.fetch(new Request("http://localhost/v1/hooks", {
      method: "POST", headers: { authorization: `Bearer aiko_${String(index).repeat(44)}`, "content-type": "application/json" },
      body: JSON.stringify({ id: `export-hook-${owner}`, subject: "browser-search", title: "Browser search",
        kind: "skill", type: "browser-tool", payload: { ownerLabel: owner, action: "search" } }),
    }));
    expect(response.status).toBe(202);
  }
  await service.host.drive();
  const expected = new Map<string, MigrationEnvelope["threads"][number]["events"]>();
  for (const thread of await service.host.threads()) expected.set(thread, [...await service.host.read(thread)]);
  return { stateDir, outputDir: join(destination, "export"), service, expected };
}
function poller(stateDir: string, inbox = false) {
  const path = join(stateDir, `telegram-${"a".repeat(24)}.sqlite`);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE cursor(id INTEGER PRIMARY KEY,next INTEGER); INSERT INTO cursor VALUES(1,42); CREATE TABLE rejected(update_id INTEGER PRIMARY KEY,reason TEXT); INSERT INTO rejected VALUES(40,'unsupported'); CREATE TABLE inbox(update_id INTEGER PRIMARY KEY,owner TEXT,payload TEXT)");
  if (inbox) db.prepare("INSERT INTO inbox VALUES(41,'123',?)").run("PRIVATE pending update body");
  db.close(); chmodSync(path, 0o600);
  return path;
}
function sourceDigests(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string) {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      if (statSync(file).isDirectory()) walk(file);
      // SQLite's read-only WAL reader may create empty WAL/SHM coordination
      // sidecars. Existing data-bearing database/WAL bytes must stay identical.
      else if (!file.endsWith("-shm") && !(file.endsWith("-wal") && statSync(file).size === 0)) result[file] = sha(readFileSync(file));
    }
  }
  walk(root); return result;
}

test("offline export retains every scoped foreground/background event and native citations, forgetting, revocations and roots", async () => {
  const f = await fixture();
  await f.service.close();
  const native = openMemory({ stateDir: accountDirectory(f.stateDir, "123"), owner: "123" });
  const producer = { kind: "agent" as const, reference: "migration-fixture" };
  const first = native.remember({ subject: "note", title: "Note", kind: "fact", type: "decision", payload: "private useful note" }, { key: "fixture:note", producer });
  const derived = native.remember({ subject: "derived", title: "Derived", kind: "fact", type: "decision", payload: "Derived note", supports: [first.id] }, { key: "fixture:derived", producer });
  native.forget(first.subject, first.id, "fixture:forget");
  const source = native.sources()[0]!;
  native.approveSource(source.id, source.revision, false, "fixture:revoke");
  const beforeMemory = native.exportArchive(); native.close();
  poller(f.stateDir);
  const before = sourceDigests(f.stateDir);
  const inventory = exportAikoCloudflare({ ...f, sourceOffline: true });
  expect(sourceDigests(f.stateDir)).toEqual(before);
  expect(inventory.actor).toBe("aiko"); expect(inventory.instance).toBe("demo");
  expect(inventory.hostLockHeld).toBe(true);
  expect(inventory.accounts).toHaveLength(2);
  expect(inventory.telegram).toEqual([{ file: `telegram-${"a".repeat(24)}.sqlite`, next: 42, rejected: 1, inbox: 0 }]);
  expect(inventory.transportHandoff).toContain("drop_pending_updates: false");
  expect(statSync(f.outputDir).mode & 0o777).toBe(0o700);
  for (const file of readdirSync(f.outputDir)) expect(statSync(join(f.outputDir, file)).mode & 0o777).toBe(0o600);
  for (const audit of inventory.accounts) {
    const bytes = readFileSync(join(f.outputDir, audit.file), "utf8");
    expect(sha(bytes)).toBe(audit.sha256); expect(Buffer.byteLength(bytes)).toBe(audit.bytes);
    const envelope = JSON.parse(bytes) as MigrationEnvelope;
    expect(envelope.id).toBe(audit.id); expect(envelope.threads).toHaveLength(3);
    expect(envelope.memory.scope).toBe(`aiko:${audit.account}`);
    for (const thread of envelope.threads) {
      expect(thread.events).toEqual(f.expected.get(thread.thread)!);
      const counts = audit.threads.find(item => item.thread === thread.thread)!;
      expect(counts.events).toBe(thread.events.length);
      expect(counts.sha256).toBe(sha(JSON.stringify(thread.events)));
    }
    const target = new Memory({ scope: envelope.memory.scope, storage: nodeStorage(":memory:") });
    try {
      target.importArchive(envelope.memory);
      expect(target.exportArchive()).toEqual(envelope.memory);
      if (audit.account === "123") {
        expect(envelope.memory).toEqual(beforeMemory);
        expect(target.get(first.id)).toBeNull(); expect(target.get(derived.id)).toBeNull();
        expect(target.sources().find(item => item.id === source.id)?.enabled).toBe(false);
      } else expect(target.get(first.id)).toBeNull();
    } finally { target.close(); }
  }
  const again = exportAikoCloudflare({ stateDir: f.stateDir, outputDir: `${f.outputDir}-again`, sourceOffline: true });
  expect(again).toEqual(inventory);
});

test("offline export refuses a running host and requires explicit operator offline assertion", async () => {
  const f = await fixture(["123"]);
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: false })).toThrow("explicit-source-offline-required");
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: true })).toThrow("source-host-is-running-or-locked");
  expect(existsSync(f.outputDir)).toBe(false);
});

test("pending Telegram inbox is not dropped or exported and immutable histories are never redacted", async () => {
  const f = await fixture(["123"]); await f.service.close();
  const path = poller(f.stateDir, true);
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: true })).toThrow("pending-telegram-inbox");
  expect(existsSync(f.outputDir)).toBe(false);
  const inbox = new DatabaseSync(path); inbox.exec("DELETE FROM inbox"); inbox.close();
  const db = new DatabaseSync(accountThreadDatabase(f.stateDir, "user-123"));
  const next = (db.prepare("SELECT MAX(seq) AS n FROM events").get()!.n as number) + 1;
  db.prepare("INSERT INTO events(seq,event) VALUES(?,?)").run(next, JSON.stringify({ type: "PrivateFixture", at: 1000, password: "private-credential-must-not-export" }));
  db.close();
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: true })).toThrow("sensitive-material-in-source");
  expect(existsSync(f.outputDir)).toBe(false);
});

test("no-drive preflight rejects unfinished effects and missing registered history", async () => {
  const f = await fixture(["123"]); await f.service.close();
  const db = new DatabaseSync(accountThreadDatabase(f.stateDir, "user-123"));
  const next = (db.prepare("SELECT MAX(seq) AS n FROM events").get()!.n as number) + 1;
  db.prepare("INSERT INTO events(seq,event) VALUES(?,?)").run(next, JSON.stringify({ type: "MessageReceived", id: "unfinished", text: "Do not execute this task", at: 1000 }));
  db.close();
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: true })).toThrow("unsettled-history");
  expect(existsSync(f.outputDir)).toBe(false);
  const directoryDb = new DatabaseSync(join(f.stateDir, "actor.sqlite"));
  directoryDb.exec("INSERT INTO thread_directory(thread) VALUES('user-999')"); directoryDb.close();
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: true })).toThrow("registered-history-missing");
});

test("read-only native storage exports identical verified archive and cannot mutate the source", () => {
  const path = join(directory(), "memory.sqlite");
  const original = new Memory({ scope: "aiko:local", storage: nodeStorage(path) });
  original.remember({ subject: "fact", title: "Fact", type: "fact", payload: "Durable" }, { key: "first", producer: { kind: "agent", reference: "test" } });
  const expected = original.exportArchive(); original.close();
  const bytes = sha(readFileSync(path));
  const readonly = new Memory({ scope: "aiko:local", storage: nodeStorage(path, { readonly: true }) });
  try {
    expect(readonly.exportArchive()).toEqual(expected);
    expect(() => readonly.remember({ subject: "other", title: "Other", type: "fact", payload: "Must not write" }, { key: "second", producer: { kind: "agent", reference: "test" } })).toThrow();
  } finally { readonly.close(); }
  expect(sha(readFileSync(path))).toBe(bytes);
});

test("export fails closed for foreign native scopes, oversized accounts, and wrong actor identity", async () => {
  const f = await fixture(["123"]); await f.service.close();
  const actor = new DatabaseSync(join(f.stateDir, "actor.sqlite"));
  actor.exec("UPDATE actor_identity SET instance='other'"); actor.close();
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: true })).toThrow("actor-identity-must-be-aiko-demo");
  const restoreActor = new DatabaseSync(join(f.stateDir, "actor.sqlite"));
  restoreActor.exec("UPDATE actor_identity SET instance='demo'"); restoreActor.close();
  const threadPath = accountThreadDatabase(f.stateDir, "user-123");
  const thread = new DatabaseSync(threadPath);
  const next = Number(thread.prepare("SELECT MAX(seq) AS n FROM events").get()!.n) + 1;
  thread.prepare("INSERT INTO events(seq,event) VALUES(?,?)").run(next, JSON.stringify({ type: "LargeFixture", data: "x".repeat(8_000_000) }));
  thread.close();
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: true })).toThrow("history-exceeds-import-limit");
  const restoreThread = new DatabaseSync(threadPath);
  restoreThread.prepare("DELETE FROM events WHERE seq=?").run(next); restoreThread.close();
  const ownerRoot = accountDirectory(f.stateDir, "123");
  const memoryPath = join(ownerRoot, "memory", `${sha("123")}.sqlite`);
  const foreign = new Memory({ scope: "aiko:456", storage: nodeStorage(memoryPath) });
  foreign.remember({ subject: "foreign", title: "Foreign", type: "fact", payload: "Isolated" }, { key: "foreign", producer: { kind: "agent", reference: "test" } });
  foreign.close();
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: true })).toThrow("native-source-verification-failed");
  expect(existsSync(f.outputDir)).toBe(false);
});

test("export refuses orphan memory stores instead of silently omitting an account", async () => {
  const f = await fixture(["123"]); await f.service.close();
  const known = join(accountDirectory(f.stateDir, "123"), "memory", `${sha("123")}.sqlite`);
  const orphan = join(accountDirectory(f.stateDir, "123"), "memory", `${sha("999")}.sqlite`);
  copyFileSync(known, orphan);
  expect(() => exportAikoCloudflare({ ...f, sourceOffline: true })).toThrow("orphan-memory-store");
  expect(existsSync(f.outputDir)).toBe(false);
});

test("a retained native source lease fences host restarts beyond export and releases explicitly", async () => {
  const f = await fixture(["123"]); await f.service.close();
  const lease = acquireOfflineSourceLease(f.stateDir);
  try {
    const inventory = exportAikoCloudflare({ ...f, sourceOffline: true, sourceLease: lease });
    expect(inventory.hostLockHeld).toBe(true);
    expect(() => acquireOfflineSourceLease(f.stateDir)).toThrow("source-host-is-running-or-locked");
    lease.assertHeld(f.stateDir);
    expect(() => lease.assertHeld(directory())).toThrow("invalid-source-lease");
  } finally { lease.release(); }
  expect(() => lease.assertHeld(f.stateDir)).toThrow("invalid-source-lease");
  const next = acquireOfflineSourceLease(f.stateDir); next.release();
});
