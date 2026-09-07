/** Real R2 round trip with synthetic data. Deletes only this run's objects. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import {
  CloudBackups,
  type BackupBucket,
} from "../apps/agent/src/cloud-backup.ts";
const bucket = "aiko-state-backups",
  directory = await mkdtemp("/tmp/unlock-r2-witness-");
const written = new Set<string>();
let sequence = 0;
async function wrangler(args: string[]) {
  const child = Bun.spawn(
    [
      "pnpm",
      "--filter",
      "@unlock/agent",
      "exec",
      "wrangler",
      "r2",
      "object",
      ...args,
      "--remote",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw Error("R2 witness operation failed");
}
const storage: BackupBucket = {
  put: async (key, value) => {
    const path = `${directory}/${++sequence}`;
    await writeFile(path, value, { mode: 0o600 });
    written.add(key);
    await wrangler(["put", `${bucket}/${key}`, "--file", path]);
    await rm(path);
  },
  get: async (key) => {
    const path = `${directory}/${++sequence}`;
    await wrangler(["get", `${bucket}/${key}`, "--file", path]);
    const value = await readFile(path);
    await rm(path);
    return { arrayBuffer: async () => new Uint8Array(value).buffer };
  },
  delete: async (key) => {
    await wrangler(["delete", `${bucket}/${key}`]);
    written.delete(key);
  },
};
try {
  const bytes = new TextEncoder().encode(
    "synthetic-backup-fixture\n".repeat(10000),
  );
  const backups = new CloudBackups(storage, randomBytes(32).toString("base64"));
  const manifest = await backups.save("verification", {
    files: [
      {
        path: "fixture.txt",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
    read: async (_path, offset, length) => bytes.slice(offset, offset + length),
  });
  const restored = new Uint8Array(bytes.length);
  let committed = false;
  await backups.restore("verification", manifest.id, {
    write: async (_path, offset, value) => {
      restored.set(value, offset);
    },
    commit: async () => {
      committed = true;
    },
    abort: async () => {},
  });
  if (!committed || Buffer.compare(Buffer.from(bytes), Buffer.from(restored)))
    throw Error("R2 recovery mismatch");
  await mkdir("artifacts/backups", { recursive: true });
  await writeFile(
    "artifacts/backups/cloud-roundtrip.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        bucket,
        verified: true,
        bytes: bytes.length,
        encrypted: true,
        productionData: false,
      },
      null,
      2,
    ),
  );
  console.log("Real R2 encrypted backup and recovery verified");
} finally {
  for (const key of [...written]) await storage.delete(key);
  await rm(directory, { recursive: true, force: true });
}
