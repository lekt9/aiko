import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateDirectory } from "./accounts.ts";
import { holdRestoredBrowserWatches } from "./browser-watch-restore.ts";
import {
  BACKUP_CHUNK_BYTES,
  validateBackupFiles,
  type BackupFile,
} from "./cloud-backup.ts";

/** Rebuildable binaries/models and browser caches are excluded. Cookies and
 * saved credentials recover from the native vault; observations and pointers
 * recover from their SQLite stores. Call only while the runner is stopped. */
const files = [
  "owner.json",
  "runner.sqlite",
  "browser/request-evidence.sqlite",
  "browser/request-memory.sqlite",
  "browser/unlock-vault.key",
] as const;
const safePath = (path: string) => {
  if (!(files as readonly string[]).includes(path))
    throw Error("Invalid VM backup path");
  return path;
};
const operationId = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid VM snapshot identity");
  return id;
};
async function privateBytes(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error("Unsafe VM state file");
    return await fd.readFile();
  } finally {
    await fd.close();
  }
}
async function syncFile(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fd = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export async function snapshotVm(root: string, id: string) {
  privateDirectory(root);
  const target = join(root, "backups", operationId(id));
  await mkdir(join(root, "backups"), { mode: 0o700, recursive: true });
  await mkdir(target, { mode: 0o700 });
  const inventory: BackupFile[] = [];
  try {
    for (const path of files) {
      let bytes: Uint8Array;
      try {
        bytes = await privateBytes(join(root, path));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          path !== "owner.json"
        )
          continue;
        throw error;
      }
      if (path.endsWith(".sqlite")) {
        const db = new Database(join(root, path), { readonly: true });
        try {
          bytes = db.serialize();
        } finally {
          db.close();
        }
      }
      await syncFile(join(target, path), bytes);
      inventory.push({
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const owner = JSON.parse(
      await readFile(join(target, "owner.json"), "utf8"),
    ).owner;
    validateBackupFiles(inventory);
    await syncFile(
      join(target, "manifest.json"),
      new TextEncoder().encode(
        JSON.stringify({ version: 1, owner, files: inventory }),
      ),
    );
    return { version: 1 as const, owner, files: inventory };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
export async function readVmSnapshot(
  root: string,
  id: string,
  path: string,
  offset: number,
  length: number,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > BACKUP_CHUNK_BYTES
  )
    throw Error("Invalid snapshot range");
  const target = join(root, "backups", operationId(id), safePath(path));
  const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = new Uint8Array(length);
    const result = await fd.read(bytes, 0, length, offset);
    if (result.bytesRead !== length) throw Error("Incomplete snapshot range");
    return Buffer.from(bytes).toString("base64");
  } finally {
    await fd.close();
  }
}
export async function discardVmSnapshot(root: string, id: string) {
  await rm(join(root, "backups", operationId(id)), {
    recursive: true,
    force: true,
  });
}

/** Stage into a new private directory. Publishing is a separate offline step,
 * after both cloud and VM hash verification; live state is never overwritten. */
export async function writeVmRestore(
  root: string,
  id: string,
  path: string,
  offset: number,
  base64: string,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof base64 !== "string" ||
    base64.length > 4 * Math.ceil(BACKUP_CHUNK_BYTES / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  )
    throw Error("Invalid restore chunk");
  const target = join(root, "backups", operationId(id), safePath(path));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const fd = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if ((await fd.stat()).size !== offset)
      throw Error("Restore offset changed");
    await fd.writeFile(Buffer.from(base64, "base64"));
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export async function verifyVmRestore(
  root: string,
  id: string,
  owner: string,
  inventory: BackupFile[],
) {
  validateBackupFiles(inventory);
  if (!inventory.some((file) => file.path === "owner.json"))
    throw Error("Snapshot owner missing");
  const target = join(root, "backups", operationId(id));
  for (const file of inventory) {
    const bytes = await privateBytes(join(target, safePath(file.path)));
    if (
      bytes.length !== file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw Error("VM snapshot integrity mismatch");
  }
  if (
    JSON.parse(await readFile(join(target, "owner.json"), "utf8")).owner !==
    owner
  )
    throw Error("VM snapshot owner mismatch");
  await syncFile(
    join(target, "verified.json"),
    new TextEncoder().encode(
      JSON.stringify({ version: 1, owner, files: inventory }),
    ),
  );
  return { verified: true as const };
}

export async function publishVmRestore(
  root: string,
  id: string,
  owner: string,
  allowed: { id: string; domain: string; revision: number }[],
) {
  const target = join(root, "backups", operationId(id));
  const verified = JSON.parse(
    await privateBytes(join(target, "verified.json")).then((bytes) =>
      bytes.toString("utf8"),
    ),
  ) as { owner: string; files: BackupFile[] };
  if (
    verified.owner !== owner ||
    JSON.parse(
      await privateBytes(join(root, "owner.json")).then((bytes) =>
        bytes.toString("utf8"),
      ),
    ).owner !== owner
  )
    throw Error("VM restore owner mismatch");
  validateBackupFiles(verified.files);
  // The live control plane remains the authority. An older backup must never
  // restore a revoked or replaced credential generation.
  const evidence = join(target, "browser/request-evidence.sqlite");
  if (
    verified.files.some(
      (file) => file.path === "browser/request-evidence.sqlite",
    )
  ) {
    const db = new Database(evidence);
    try {
      // Commit before the directory becomes visible to a new runner. Current
      // sign-in revisions alone cannot authorize leases recovered from backup.
      holdRestoredBrowserWatches(db, owner);
      const hasLogin = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='native_login'",
        )
        .get();
      if (hasLogin)
        for (const row of db
          .query("SELECT id,state FROM native_login")
          .all() as { id: string; state: string }[]) {
          const state = JSON.parse(row.state);
          if (
            !allowed.some(
              (binding) =>
                binding.id === row.id &&
                binding.domain === state.domain &&
                binding.revision === state.revision &&
                state.status === "connected",
            )
          ) {
            db.query("DELETE FROM native_login WHERE id=?").run(row.id);
            if (
              db
                .query(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name='native_vault'",
                )
                .get()
            )
              db.query("DELETE FROM native_vault WHERE id=?").run(row.id);
          }
        }
    } finally {
      db.close();
    }
  }
  const browser = join(root, "browser");
  // Refuse to replace an existing browser store. Restore targets are fresh VMs;
  // a populated VM can retain the verified snapshot for an explicit migration.
  try {
    const existing = new Database(join(browser, "request-evidence.sqlite"), {
      readonly: true,
    });
    try {
      for (const table of ["native_login", "evidence"])
        if (
          existing
            .query(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table) &&
          existing.query(`SELECT 1 FROM ${table} LIMIT 1`).get()
        )
          throw Error("VM restore requires an empty browser store");
    } finally {
      existing.close();
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(
        error instanceof Error &&
        error.message.includes("unable to open database")
      )
    )
      throw error;
  }
  // One directory rename publishes every native store and its wrapping key.
  // A displaced empty scaffold is kept until publication succeeds.
  const previous = join(root, `browser-before-${operationId(id)}`);
  let displaced = false;
  try {
    await rename(browser, previous);
    displaced = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(join(target, "browser"), browser);
  } catch (error) {
    if (displaced) await rename(previous, browser);
    throw error;
  }
  if (displaced) await rm(previous, { recursive: true, force: true });
  return { restored: true as const };
}
