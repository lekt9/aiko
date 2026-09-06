import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryStorage } from "./storage.js";

/** Node/Bun owns the private local file and its WAL; never use this on a network filesystem. */
export function nodeStorage(path: string, options: { readonly?: boolean } = {}): MemoryStorage {
  if (!options.readonly && path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { readOnly: options.readonly ?? false });
  try {
    if (!options.readonly) {
      if (path !== ":memory:") chmodSync(path, 0o600);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    }
  } catch (error) { db.close(); throw error; }
  const transaction = <T>(begin: string, run: () => T): T => {
    db.exec(begin);
    try { const result = run(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return {
    exec: sql => db.exec(sql),
    prepare: sql => db.prepare(sql),
    transaction: run => transaction("BEGIN IMMEDIATE", run),
    read: run => transaction("BEGIN", run),
    close: () => db.close(),
  };
}
