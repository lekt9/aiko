import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { bunThreadDatabasePath } from "tardie/bun/host";
import { safeUserId } from "./security.ts";
import { threadBinding } from "./account-binding.ts";
export { threadBinding, backgroundThread, type ThreadRole } from "./account-binding.ts";

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Account directory must be private and owned by the host");
  return path;
}
export function accountDirectory(stateDir: string, owner: string) {
  if (!safeUserId(owner)) throw new Error("Invalid account binding");
  // Preserve the existing operator console's logs and memory in place.
  if (owner === "local") return stateDir;
  const root = privateDirectory(join(stateDir, "accounts"));
  return privateDirectory(
    join(root, createHash("sha256").update(owner).digest("hex")),
  );
}
export function accountThreadDatabase(stateDir: string, thread: string) {
  const binding = threadBinding(thread);
  if (!binding) throw new Error("Invalid thread binding");
  const { owner, role } = binding;
  const directory = accountDirectory(stateDir, owner);
  if (role !== "foreground")
    return privateDatabaseFile(
      join(privateDirectory(join(directory, "background")), `${role}.sqlite`),
    );
  const legacy = bunThreadDatabasePath(join(stateDir, "actor.sqlite"), thread);
  if (owner === "local") return legacy;
  // Never silently replace an older user's history with an empty sandbox.
  if (existsSync(legacy))
    throw new Error(
      "Legacy account requires offline migration; see docs/aiko-gateway.md",
    );
  return privateDatabaseFile(join(directory, "thread.sqlite"));
}

export function privateDatabaseFile(path: string) {
  privateDirectory(dirname(path));
  if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  for (const suffix of ["", "-wal", "-shm"]) {
    if (!existsSync(path + suffix)) continue;
    const stat = lstatSync(path + suffix);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe account database");
  }
  return path;
}
