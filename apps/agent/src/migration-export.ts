import { createHash } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, realpathSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeStorage, validateNoSecrets, type MemoryArchive } from "entity-learn";
import { Memory } from "entity-learn/cloudflare";
import { bunThreadDatabasePath } from "tardie/bun/host";
import { actorThreadsOf } from "tardie/core/actor";
import type { Event } from "tardie/core/event";
import { restingActor } from "tardie/core/runtime";
import { threadCreatedOf, threadCreatedForDelivery } from "tardie/core/thread";
import { threadBinding } from "./account-binding.ts";
import { createAikoActor } from "./actor.ts";
import { createIndexerActor, createReflectionActor } from "./background.ts";
import { memoryScope, type MemoryBinding } from "./memory.ts";
import { createVoice } from "./voice.ts";
import { redactor } from "./security.ts";

const MAX_IMPORT_BYTES = 8_000_000;
const MAX_INVENTORY = 10_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export class MigrationExportError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MigrationExportError"; }
}
function fail(code: string): never { throw new MigrationExportError(code); }
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("invalid-source-integer");
  return value;
}
function privatePath(path: string, directory: boolean, strictlyPrivate = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.getuid && stat.uid !== process.getuid()) ||
    // Old native actor files can be 0644 inside their private 0700 directory.
    (stat.mode & (strictlyPrivate ? 0o077 : 0o022)) !== 0)
    fail("unsafe-source-permissions");
}
function entries(path: string): string[] {
  if (!existsSync(path)) return [];
  privatePath(path, true);
  const names = readdirSync(path).sort();
  if (names.length > MAX_INVENTORY) fail("inventory-limit");
  return names;
}
function guardedDatabase(path: string, readOnly = true): DatabaseSync {
  privatePath(dirname(path), true);
  privatePath(path, false);
  for (const suffix of ["-wal", "-shm"])
    if (existsSync(path + suffix)) privatePath(path + suffix, false);
  return new DatabaseSync(path, { readOnly });
}
function closeRead(db: DatabaseSync | undefined) {
  if (!db) return;
  // Bun's node:sqlite may defer finalizing prepared statements after close();
  // explicitly end the read snapshot so it cannot keep a lock until GC.
  try { db.exec("ROLLBACK"); } catch { /* No transaction was acquired. */ }
  db.close();
}
/** Host-owned lease, never a request argument. Retain across cutover to fence old-host restarts. */
export interface OfflineSourceLease {
  readonly hostLockHeld: boolean;
  assertHeld(stateDir: string): void;
  release(): void;
}
export function acquireOfflineSourceLease(stateDir: string): OfflineSourceLease {
  privatePath(stateDir, true, true);
  if (!isAbsolute(stateDir) || realpathSync(stateDir) !== stateDir) fail("absolute-canonical-path-required");
  let lock: DatabaseSync | undefined;
  const path = join(stateDir, "host-lock.sqlite");
  if (existsSync(path)) {
    try {
      // Only the coordination lock is write-capable; readOnly SQLite handles
      // can coexist and do not acquire this production writer exclusion fence.
      // No data/DDL is written or committed in this database.
      lock = guardedDatabase(path, false); lock.exec("BEGIN EXCLUSIVE");
      // The production host's uncommitted host_lock table may disappear on close.
      lock.prepare("SELECT COUNT(*) FROM sqlite_master").get();
    } catch { closeRead(lock); fail("source-host-is-running-or-locked"); }
  }
  let held = true;
  return {
    hostLockHeld: !!lock,
    assertHeld: directory => {
      if (!held || directory !== stateDir) fail("invalid-source-lease");
    },
    release: () => { if (held) { held = false; closeRead(lock); } },
  };
}
function secretCheck(value: unknown) {
  try { validateNoSecrets(value); } catch { fail("sensitive-material-in-source"); }
  const redact = redactor();
  const strings = (node: unknown): void => {
    if (typeof node === "string" && redact(node) !== node) fail("sensitive-material-in-source");
    if (Array.isArray(node)) node.forEach(strings);
    else if (node && typeof node === "object") Object.values(node).forEach(strings);
  };
  // Reuse the application boundary for Telegram/account token patterns too.
  // Never rewrite a committed event or retained memory to make migration pass.
  strings(value);
}
function readEvents(db: DatabaseSync, table: "actor_events" | "events"): Event[] {
  const size = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(event AS BLOB))),0) AS bytes FROM ${table}`).get()!;
  if (integer(size.n) > 100_000 || integer(size.bytes) > MAX_IMPORT_BYTES)
    fail("history-exceeds-import-limit");
  return db.prepare(`SELECT seq,event FROM ${table} ORDER BY seq`).all().map((row, index) => {
    if (integer(row.seq) !== index + 1 || typeof row.event !== "string") fail("noncontiguous-history");
    const value = JSON.parse(row.event);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.type !== "string" || !value.type.length ||
      (value.at !== undefined && (typeof value.at !== "number" || !Number.isFinite(value.at))))
      fail("invalid-native-event");
    secretCheck(value);
    return value as Event;
  });
}
function tables(db: DatabaseSync): Set<string> {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
}
function accountRoot(stateDir: string, owner: string) {
  return owner === "local" ? stateDir : join(stateDir, "accounts", sha(owner));
}
function currentThreadPath(stateDir: string, thread: string) {
  const binding = threadBinding(thread);
  if (!binding) return fail("unknown-thread-owner");
  const root = accountRoot(stateDir, binding.owner);
  return binding.role !== "foreground" ? join(root, "background", `${binding.role}.sqlite`)
    : binding.owner === "local" ? bunThreadDatabasePath(join(stateDir, "actor.sqlite"), thread)
      : join(root, "thread.sqlite");
}
function validateResting(owner: string, history: { thread: string; events: Event[] }) {
  const binding: MemoryBinding = {
    stateDir: "/no-migration-effects", owner, thread: history.thread,
    redact: text => text,
    readPage: async () => fail("migration-must-not-read-through-actor"),
    openMemory: () => fail("migration-must-not-run-memory-effects"),
  };
  const role = threadBinding(history.thread)!.role;
  const definition = role === "indexer" ? createIndexerActor(binding)
    : role === "reflection" ? createReflectionActor(binding)
      : createAikoActor({ owner, memory: binding, live: true, background: true,
        voice: createVoice({ persona: "offline-migration", enabled: false }),
        send: async () => fail("migration-must-not-send"),
      });
  if (!restingActor(definition, history.events)) fail("unsettled-history");
}

export interface MigrationEnvelope {
  id: string;
  threads: { thread: string; events: Event[] }[];
  memory: MemoryArchive;
}
export interface MigrationInventory {
  format: "aiko.offline-migration/v1";
  actor: "aiko";
  instance: "demo";
  sourceOffline: true;
  hostLockHeld: boolean;
  accounts: {
    account: string; file: string; id: string; bytes: number; sha256: string;
    memory: { root: string; journalRows: number; artifacts: number };
    threads: { thread: string; events: number; sha256: string; types: Record<string, number> }[];
  }[];
  actorRegistry: { file: string; sha256: string; events: number; directoryEntries: number };
  telegram: { file: string; next: number; rejected: number; inbox: 0 }[];
  transportHandoff: string;
}

/** Offline, no-drive migration. This does not stop a service or contact Telegram/Cloudflare. */
export function exportAikoCloudflare(options: {
  stateDir: string; outputDir: string; sourceOffline: boolean;
  sourceLease?: OfflineSourceLease;
}): MigrationInventory {
  if (options.sourceOffline !== true) fail("explicit-source-offline-required");
  const stateDir = resolve(options.stateDir), outputDir = resolve(options.outputDir);
  if (!isAbsolute(options.stateDir) || !isAbsolute(options.outputDir) ||
    realpathSync(stateDir) !== stateDir) fail("absolute-canonical-path-required");
  privatePath(stateDir, true, true);
  const outputRelative = relative(stateDir, outputDir);
  if (!(outputRelative === ".." || outputRelative.startsWith(`..${sep}`)) || existsSync(outputDir))
    fail("fresh-output-outside-source-required");
  if (realpathSync(dirname(outputDir)) !== dirname(outputDir)) fail("canonical-output-parent-required");

  let lease: OfflineSourceLease | undefined = options.sourceLease;
  let actorDb: DatabaseSync | undefined;
  try {
    lease ??= acquireOfflineSourceLease(stateDir);
    lease.assertHeld(stateDir);
    actorDb = guardedDatabase(join(stateDir, "actor.sqlite"));
    actorDb.exec("BEGIN");
    const identity = actorDb.prepare("SELECT actor,instance FROM actor_identity WHERE singleton=1").get();
    if (identity?.actor !== "aiko" || identity.instance !== "demo") fail("actor-identity-must-be-aiko-demo");
    const directory = actorDb.prepare("SELECT thread,parent_thread,depth,placement FROM thread_directory ORDER BY thread").all();
    if (directory.length > MAX_INVENTORY) fail("inventory-limit");
    const registry = readEvents(actorDb, "actor_events");
    if (registry.some(event => !["ThreadRequested", "ThreadRegistered"].includes(event.type)))
      fail("unsupported-actor-registry-event");
    const actorThreads = actorThreadsOf(registry);
    if (actorThreads.some(thread => thread.state !== "registered")) fail("unregistered-native-thread");

    const candidates = new Set<string>();
    const addSqlite = (path: string) => {
      for (const name of entries(path)) if (name.endsWith(".sqlite")) candidates.add(join(path, name));
    };
    addSqlite(join(stateDir, "actor.sqlite.threads"));
    addSqlite(join(stateDir, "background"));
    const accountDirs = entries(join(stateDir, "accounts")).map(name => {
      if (!/^[a-f0-9]{64}$/.test(name)) fail("unknown-account-directory");
      const path = join(stateDir, "accounts", name);
      privatePath(path, true);
      if (existsSync(join(path, "thread.sqlite"))) candidates.add(join(path, "thread.sqlite"));
      addSqlite(join(path, "background"));
      return path;
    });
    if (candidates.size > MAX_INVENTORY) fail("inventory-limit");
    const histories = new Map<string, { thread: string; events: Event[] }>();
    for (const path of [...candidates].sort()) {
      const db = guardedDatabase(path);
      try {
        db.exec("BEGIN");
        const names = tables(db);
        if (!names.has("thread_identity") || !names.has("events")) fail("unrecognized-thread-database");
        const identity = db.prepare("SELECT actor,instance,thread FROM thread_identity WHERE singleton=1").get();
        const events = readEvents(db, "events");
        if (!events.length && !identity) continue; // Native, never-created reserved file.
        if (!identity || identity.actor !== "aiko" || identity.instance !== "demo" || typeof identity.thread !== "string")
          fail("thread-identity-mismatch");
        const thread = identity.thread;
        if (!threadBinding(thread)) fail("unknown-thread-owner");
        const legacy = bunThreadDatabasePath(join(stateDir, "actor.sqlite"), thread);
        if (path !== currentThreadPath(stateDir, thread) && path !== legacy) fail("thread-store-owner-mismatch");
        if (histories.has(thread)) fail("duplicate-thread-stores");
        if (!threadCreatedOf(events)) fail("missing-native-thread-created");
        threadCreatedForDelivery(events, { actor: "aiko", instance: "demo", thread }, undefined);
        histories.set(thread, { thread, events });
      } finally { closeRead(db); }
    }
    for (const entry of [...directory, ...actorThreads])
      if (typeof entry.thread !== "string" || !histories.has(entry.thread)) fail("registered-history-missing");
    if (!histories.size) fail("no-native-history");
    // Keep the actual actor registry as an audit artifact; the destination derives
    // its thread directory from the unchanged ThreadCreated claims.
    const registryBody = JSON.stringify({ actor: "aiko", instance: "demo", directory, events: registry });
    secretCheck(JSON.parse(registryBody));
    const byOwner = new Map<string, { thread: string; events: Event[] }[]>();
    for (const history of histories.values()) {
      const owner = threadBinding(history.thread)!.owner;
      const created = threadCreatedOf(history.events)!;
      if (created.parent) {
        const parent = histories.get(created.parent.thread);
        const parentCreated = parent && threadCreatedOf(parent.events);
        if (created.parent.actor !== "aiko" || created.parent.instance !== "demo" ||
          threadBinding(created.parent.thread)?.owner !== owner || !parentCreated ||
          created.depth !== parentCreated.depth + 1 || created.placement === "independent")
          fail("invalid-account-thread-lineage");
      } else if (created.depth !== 0) fail("invalid-account-thread-lineage");
      validateResting(owner, history);
      const list = byOwner.get(owner) ?? [];
      list.push(history); byOwner.set(owner, list);
    }
    for (const [owner, threads] of byOwner)
      if (!threads.some(history => history.thread === `user-${owner}`)) fail("foreground-history-missing");

    const ownerByHash = new Map([...byOwner.keys()].map(owner => [sha(owner), owner]));
    const memoryFiles = new Map<string, string>();
    for (const root of [stateDir, ...accountDirs]) {
      for (const name of entries(join(root, "memory"))) {
        if (!name.endsWith(".sqlite")) continue;
        const owner = ownerByHash.get(name.slice(0, -7));
        if (!owner) fail("orphan-memory-store");
        if (root !== stateDir && root !== accountRoot(stateDir, owner)) fail("memory-store-owner-mismatch");
        if (memoryFiles.has(owner)) fail("duplicate-memory-stores");
        const path = join(root, "memory", name);
        const check = guardedDatabase(path); check.close();
        memoryFiles.set(owner, path);
      }
    }
    const telegram: MigrationInventory["telegram"] = [];
    for (const name of entries(stateDir)) {
      if (!/^telegram-[a-f0-9]{24}\.sqlite$/.test(name)) continue;
      const db = guardedDatabase(join(stateDir, name));
      try {
        db.exec("BEGIN");
        const pending = integer(db.prepare("SELECT COUNT(*) AS n FROM inbox").get()!.n);
        if (pending) fail("pending-telegram-inbox");
        const cursors = db.prepare("SELECT id,next FROM cursor").all();
        if (cursors.length !== 1 || cursors[0]!.id !== 1) fail("invalid-telegram-cursor");
        telegram.push({ file: name, next: integer(cursors[0]!.next),
          rejected: integer(db.prepare("SELECT COUNT(*) AS n FROM rejected").get()!.n), inbox: 0 });
      } finally { closeRead(db); }
    }
    const files: { file: string; body: string }[] = [];
    const accounts: MigrationInventory["accounts"] = [];
    for (const owner of [...byOwner.keys()].sort()) {
      const threads = byOwner.get(owner)!.sort((a, b) => a.thread.localeCompare(b.thread, "en"));
      const path = memoryFiles.get(owner);
      const memory = new Memory({ scope: memoryScope(owner), storage: nodeStorage(path ?? ":memory:", { readonly: !!path }) });
      let archive: MemoryArchive;
      try { archive = memory.exportArchive(); } finally { memory.close(); }
      for (const row of archive.journal) secretCheck(JSON.parse(row.body));
      for (const row of archive.artifacts) secretCheck(JSON.parse(row.body));
      const id = `offline-${sha(JSON.stringify(["aiko", "demo", owner, threads, archive]))}`;
      const envelope: MigrationEnvelope = { id, threads, memory: archive };
      const body = JSON.stringify(envelope);
      const bytes = Buffer.byteLength(body);
      if (bytes > MAX_IMPORT_BYTES) fail("account-exceeds-import-limit");
      const file = `${sha(owner)}.json`;
      files.push({ file, body });
      accounts.push({ account: owner, file, id, bytes, sha256: sha(body),
        memory: { root: archive.root, journalRows: archive.journal.length, artifacts: archive.artifacts.length },
        threads: threads.map(history => {
          const types: Record<string, number> = Object.create(null);
          for (const event of history.events) types[event.type] = (types[event.type] ?? 0) + 1;
          return { thread: history.thread, events: history.events.length, sha256: sha(JSON.stringify(history.events)), types };
        }),
      });
    }
    const inventory: MigrationInventory = {
      format: "aiko.offline-migration/v1", actor: "aiko", instance: "demo", sourceOffline: true,
      hostLockHeld: lease.hostLockHeld, accounts,
      actorRegistry: { file: "actor-registry.json", sha256: sha(registryBody), events: registry.length, directoryEntries: directory.length },
      telegram,
      transportHandoff: "Keep the local poller stopped. Before switching to webhook delivery, acknowledge each exported Telegram cursor with getUpdates(offset: next, timeout: 0). Do not drop pending updates or advance beyond that recorded offset. Newer updates returned by this call must remain pending. Then setWebhook(drop_pending_updates: false). Import does not restore the polling cursor or inbox; native telegram update IDs retained in histories deduplicate accepted updates. No export file may be sent as a chat attachment.",
    };
    // All validation precedes output creation. Exclusive files prevent overwrite;
    // inventory.json is the final durable completion marker, never a partial export.
    mkdirSync(outputDir, { mode: 0o700 });
    const save = (file: string, body: string) => {
      const fd = openSync(join(outputDir, file), "wx", 0o600);
      try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    };
    for (const file of files) save(file.file, file.body);
    save("actor-registry.json", registryBody);
    save("inventory.json", JSON.stringify(inventory, null, 2));
    const outputFd = openSync(outputDir, "r");
    try { fsyncSync(outputFd); } finally { closeSync(outputFd); }
    return inventory;
  } catch (error) {
    if (error instanceof MigrationExportError) throw error;
    // Native errors may contain arbitrary event fields. Keep CLI failures safe.
    throw new MigrationExportError("native-source-verification-failed");
  } finally {
    closeRead(actorDb);
    if (!options.sourceLease) lease?.release();
  }
}
