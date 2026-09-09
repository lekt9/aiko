import { Database } from "bun:sqlite";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig, type AikoConfig } from "./config.ts";
import { privateDatabaseFile, privateDirectory } from "./accounts.ts";

const SQLITE_SIDECAR = /(?:-wal|-shm|-journal)$/;

function vanishedSqliteSidecar(error: unknown, path: string): boolean {
  return (
    SQLITE_SIDECAR.test(path) &&
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function copyPrivateTree(
  source: string,
  from: string,
  to: string,
  files: { path: string; sha256: string; bytes: number }[],
): Promise<void> {
  const path = relative(source, from);
  if (
    path === "backup-manifest.json" ||
    /^host-lock\.sqlite(?:-wal|-shm|-journal)?$/.test(path)
  )
    return;
  let stat;
  try {
    stat = await lstat(from);
  } catch (error) {
    if (vanishedSqliteSidecar(error, path)) return;
    throw error;
  }
  if (
    stat.isSymbolicLink() ||
    (!stat.isFile() && !stat.isDirectory()) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Unsafe backup source");
  if (stat.isDirectory()) {
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const name of await readdir(from))
      await copyPrivateTree(source, join(from, name), join(to, name), files);
    return;
  }
  try {
    const data = await readFile(from);
    files.push({
      path,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
    });
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await writeFile(to, data, { mode: 0o600 });
  } catch (error) {
    if (vanishedSqliteSidecar(error, path)) return;
    throw error;
  }
}

/** Offline consistent snapshot of all durable stores. Refuses an active host or symlinked state. */
export async function backupState(config: AikoConfig, destination: string) {
  const source = resolve(config.stateDir),
    target = resolve(destination);
  if (
    !isAbsolute(destination) ||
    target === source ||
    target.startsWith(source + "/")
  )
    throw new Error(
      "Backup must use a new absolute path outside the state directory",
    );
  privateDirectory(source);
  privateDirectory(dirname(target));
  if (!(await lstat(join(source, "actor.sqlite"))).isFile())
    throw new Error("No actor database to back up");
  const lock = new Database(
    privateDatabaseFile(join(source, "host-lock.sqlite")),
  );
  let created = false;
  const files: { path: string; sha256: string; bytes: number }[] = [];
  try {
    lock.exec("BEGIN EXCLUSIVE"); // Same lock as createService; never copies a running host's independent WAL stores.
    await mkdir(target, { mode: 0o700 });
    created = true;
    // Walk ourselves so a SQLite WAL/SHM that checkpointed away after listing
    // cannot abort an otherwise consistent exclusive-lock snapshot.
    for (const name of await readdir(source))
      await copyPrivateTree(source, join(source, name), join(target, name), files);
    const manifest = {
      version: 1,
      at: new Date().toISOString(),
      instanceId: config.instanceId ?? config.mode,
      mode: config.mode,
      files,
    };
    await writeFile(
      join(target, "backup-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return manifest;
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    lock.close();
  }
}
if (import.meta.main) {
  process.umask(0o077);
  try {
    const config = await loadConfig();
    const target = process.argv[2];
    if (!target) throw new Error("Destination required");
    const backup = await backupState(config, target);
    console.info(
      `Backed up ${backup.files.length} state files to ${target}. Keep this plaintext backup private; see docs/aiko-production.md.`,
    );
  } catch {
    console.error(
      "Backup failed. Stop the Aiko service first and use a new private destination outside its state directory.",
    );
    process.exitCode = 1;
  }
}
