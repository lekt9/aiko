import { open, readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { constants } from "node:fs";
import { PROJECT_FILE_MAX_BYTES, projectRelativePath, type ProjectSource } from "./project-instructions.ts";

/** Only this explicitly configured root is visible; global skill/plugin paths
 * and symlinks escaping the project are unavailable. No code is executed. */
export function projectFilesystemSource(root: string): ProjectSource {
  let rootPromise: Promise<string> | undefined;
  const configured = () => rootPromise ??= realpath(root);
  const locate = async (path: string, directory = false) => {
    projectRelativePath(path, directory);
    const base = await configured(), candidate = resolve(base, path);
    let actual: string;
    try { actual = await realpath(candidate); }
    catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
    if (actual !== base && !actual.startsWith(base + sep)) throw Error("Project symlink escapes the configured root");
    return actual;
  };
  return {
    read: async (path, signal) => {
      signal.throwIfAborted();
      const actual = await locate(path); if (!actual) return undefined;
      const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (process.platform === "linux") {
          const opened = await realpath(`/proc/self/fd/${file.fd}`), base = await configured();
          if (opened !== base && !opened.startsWith(base + sep)) throw Error("Project file escaped the configured root during open");
        }
        const info = await file.stat();
        if (!info.isFile() || info.size > PROJECT_FILE_MAX_BYTES) throw Error("Project file type or byte size exceeds bounds");
        const text = await file.readFile({ encoding: "utf8", signal });
        if (Buffer.byteLength(text) > PROJECT_FILE_MAX_BYTES) throw Error("Project file grew beyond its byte bound");
        signal.throwIfAborted(); return text;
      } finally { await file.close(); }
    },
    list: async (path, signal) => {
      signal.throwIfAborted();
      const actual = await locate(path, true); if (!actual) return [];
      const entries = await readdir(actual, { withFileTypes: true });
      if (entries.length > 2000) throw Error("Project directory exceeds 2000 entries");
      signal.throwIfAborted();
      return entries.filter(entry => !entry.isSymbolicLink() && entry.name.toLowerCase() !== ".git").map(entry => ({ name: entry.name, kind: entry.isDirectory() ? "directory" as const : "file" as const }));
    },
  };
}
