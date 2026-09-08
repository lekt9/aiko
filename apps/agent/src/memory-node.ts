import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryError, nodeStorage, readFileSource, type Memory, type SourceRunner } from "entity-learn";

import { openGuardedMemory } from "./memory-restore.ts";

/** Local host only. Worker package conditions exclude this module and its filesystem imports. */
export function openHostMemory(path: string, scope: string, adapters: Record<string, SourceRunner>): Memory {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o077) !== 0 ||
      (process.getuid && directoryStat.uid !== process.getuid()))
    throw new MemoryError("unsafe_store", "Memory directory must be private");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const stat = lstatSync(path + suffix);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid()))
        throw new MemoryError("unsafe_store", "Unsafe memory file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const native = nodeStorage(path);
  // The helper reads its fence inside a native write transaction. Node SQLite
  // cannot BEGIN a second transaction; nested reads share that same snapshot.
  let depth = 0;
  const inside = <T>(run: () => T): T => { depth++; try { return run(); } finally { depth--; } };
  const storage = { ...native,
    transaction: <T>(run: () => T): T => native.transaction(() => inside(run)),
    read: <T>(run: () => T): T => depth ? run() : native.read(() => inside(run)),
  };
  try {
    return openGuardedMemory({ storage, scope, adapters, files: { canonicalPath: realpathSync, read: readFileSource } });
  } catch (error) { storage.close(); throw error; }
}
