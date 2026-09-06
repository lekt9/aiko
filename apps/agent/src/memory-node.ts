import { lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Memory, MemoryError, type SourceRunner } from "entity-learn";

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
  return new Memory({ path, scope, adapters });
}
