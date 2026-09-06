import { Database } from "bun:sqlite";
import { cp, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig, type AikoConfig } from "./config.ts";
import { privateDatabaseFile, privateDirectory } from "./accounts.ts";

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
    await cp(source, target, {
      recursive: true,
      // The destination was exclusively created above and is empty/private.
      force: true,
      filter: async (from) => {
        const path = relative(source, from);
        if (
          path === "backup-manifest.json" ||
          /^host-lock\.sqlite(?:-wal|-shm|-journal)?$/.test(path)
        )
          return false;
        const stat = await lstat(from);
        if (
          stat.isSymbolicLink() ||
          (!stat.isFile() && !stat.isDirectory()) ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new Error("Unsafe backup source");
        if (stat.isFile()) {
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(from)) hash.update(chunk);
          files.push({ path, sha256: hash.digest("hex"), bytes: stat.size });
        }
        return true;
      },
    });
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
