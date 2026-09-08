import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { backupApi, type AccountBackup } from "../src/backup-api.ts";
import {
  CloudBackups,
  BACKUP_CHUNK_BYTES,
  type BackupBucket,
} from "../src/cloud-backup.ts";
import {
  snapshotVm,
  readVmSnapshot,
  writeVmRestore,
  verifyVmRestore,
  publishVmRestore,
} from "../src/vm-backup.ts";

class Bucket implements BackupBucket {
  objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array) {
    this.objects.set(key, value.slice());
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
const source = () => {
  const bytes = new TextEncoder().encode("private-backup-value".repeat(20000));
  return {
    bytes,
    files: [
      {
        path: "account.json",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
    read: async (_path: string, offset: number, length: number) =>
      bytes.slice(offset, offset + length),
  };
};

test("backup API retains the control-plane archive and restores only current VM grants", async () => {
  const bucket = new Bucket(),
    backups = new CloudBackups(bucket, randomBytes(32).toString("base64"));
  const ownerBytes = new TextEncoder().encode(
    JSON.stringify({ owner: "owner" }),
  );
  let archived: unknown, allowed: unknown;
  const account: AccountBackup = {
    version: 1,
    owner: "owner",
    threads: [],
    memory: { root: "fixture" },
    state: [],
  };
  const sandbox = {
    busy: false,
    backup: async (consume: any) =>
      consume({
        files: [
          {
            path: "owner.json",
            bytes: ownerBytes.length,
            sha256: createHash("sha256").update(ownerBytes).digest("hex"),
          },
        ],
        read: async () => ownerBytes,
      }),
    restore: async (produce: any, bindings: any) =>
      produce({
        write: async () => {},
        abort: async () => {},
        commit: async (manifest: any) => {
          archived = manifest;
          allowed = structuredClone(bindings);
        },
      }),
  };
  let recorded: any;
  const options = {
    owner: "owner",
    backups,
    sandbox: sandbox as any,
    resting: async () => true,
    authorizeRestore: async (_id: string, archive: AccountBackup) => {
      expect(archive.owner).toBe("owner");
      return {
        check: async () => {
          expect(account.owner).toBe("owner");
        },
      };
    },
    account: async () => structuredClone(account),
    record: async (manifest: any) => {
      recorded = manifest;
    },
    list: async () => [recorded],
  };
  const saved = await backupApi(
    new Request("https://owner.test/api/control/backup", { method: "POST" }),
    options,
  );
  expect(saved.status).toBe(201);
  expect(recorded.files.map((file: any) => file.path)).toEqual([
    "owner.json",
    "account.json",
  ]);
  account.state = [
    [
      "connection",
      {
        owner: "owner",
        id: "current",
        provider: "browser",
        connectorId: "browser:service.net",
        status: "connected",
        browserVerification: { revision: 4 },
      },
    ],
  ];
  const restored = await backupApi(
    new Request("https://owner.test/api/control/restore", {
      method: "POST",
      body: JSON.stringify({ id: recorded.id, mode: "vm" }),
    }),
    options,
  );
  expect(restored.status).toBe(200);
  expect((archived as any).files.map((file: any) => file.path)).toEqual([
    "owner.json",
  ]);
  expect(allowed).toEqual([
    { id: "current", domain: "service.net", revision: 4 },
  ]);
  expect(account.state).toHaveLength(1);
});
test("cloud backup stores encrypted chunks and verifies complete recovery before publication", async () => {
  const bucket = new Bucket(),
    backups = new CloudBackups(bucket, randomBytes(32).toString("base64")),
    input = source();
  const manifest = await backups.save("owner", input);
  expect(bucket.objects.size).toBeGreaterThan(2);
  expect(
    [...bucket.objects.values()].some((value) =>
      Buffer.from(value).includes("private-backup-value"),
    ),
  ).toBe(false);
  const output = new Uint8Array(input.bytes.length);
  let committed = false;
  await backups.restore("owner", manifest.id, {
    write: async (_path, offset, bytes) => {
      output.set(bytes, offset);
    },
    commit: async () => {
      committed = true;
    },
    abort: async () => {
      throw Error("Unexpected abort");
    },
  });
  expect(committed).toBe(true);
  expect(output).toEqual(input.bytes);
  await expect(backups.manifest("other", manifest.id)).rejects.toThrow();
  const block = [...bucket.objects.keys()].find((key) => key.endsWith("/0/0"))!;
  bucket.objects.get(block)![20] ^= 1;
  let aborted = false;
  committed = false;
  await expect(
    backups.restore("owner", manifest.id, {
      write: async () => {},
      commit: async () => {
        committed = true;
      },
      abort: async () => {
        aborted = true;
      },
    }),
  ).rejects.toThrow();
  expect(aborted).toBe(true);
  expect(committed).toBe(false);
});
test("source changes and corrupted readbacks never publish a complete backup", async () => {
  const bucket = new Bucket(),
    backups = new CloudBackups(bucket, randomBytes(32).toString("base64"));
  await expect(
    backups.save("owner", {
      ...source(),
      validate: async () => {
        throw Error("Account changed");
      },
    }),
  ).rejects.toThrow("changed");
  expect(bucket.objects.size).toBe(0);
  const put = bucket.put.bind(bucket);
  bucket.put = async (key, value) => {
    await put(key, new Uint8Array(value.length));
  };
  await expect(backups.save("owner", source())).rejects.toThrow();
  expect(bucket.objects.size).toBe(0);
});
test("VM snapshots include committed WAL state and restore only currently authorized credentials", async () => {
  const root = await mkdtemp("/tmp/unlock-vm-backup-"),
    target = await mkdtemp("/tmp/unlock-vm-restore-");
  const id = crypto.randomUUID();
  try {
    await mkdir(`${root}/browser`, { mode: 0o700 });
    await writeFile(`${root}/owner.json`, JSON.stringify({ owner: "owner" }), {
      mode: 0o600,
    });
    await writeFile(
      `${target}/owner.json`,
      JSON.stringify({ owner: "owner" }),
      { mode: 0o600 },
    );
    const db = new Database(`${root}/browser/request-evidence.sqlite`);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE native_login(id TEXT PRIMARY KEY,state TEXT); CREATE TABLE native_vault(id TEXT PRIMARY KEY,envelope TEXT); CREATE TABLE evidence(value BLOB)",
    );
    db.query("INSERT INTO native_login VALUES(?,?)").run(
      "connection",
      JSON.stringify({
        domain: "service.net",
        status: "connected",
        revision: 2,
      }),
    );
    db.query("INSERT INTO native_vault VALUES(?,?)").run(
      "connection",
      "encrypted-credential",
    );
    db.query("INSERT INTO evidence VALUES(?)").run(
      new Uint8Array(BACKUP_CHUNK_BYTES * 2 + 37),
    );
    await writeFile(`${root}/browser/unlock-vault.key`, randomBytes(32), {
      mode: 0o600,
    });
    const snapshot = await snapshotVm(root, id);
    db.close();
    const bucket = new Bucket(),
      backups = new CloudBackups(bucket, randomBytes(32).toString("base64"));
    const manifest = await backups.save("owner", {
      files: snapshot.files,
      read: async (path, offset, length) =>
        new Uint8Array(
          Buffer.from(
            await readVmSnapshot(root, id, path, offset, length),
            "base64",
          ),
        ),
    });
    await backups.restore("owner", manifest.id, {
      write: (path, offset, bytes) =>
        writeVmRestore(
          target,
          id,
          path,
          offset,
          Buffer.from(bytes).toString("base64"),
        ),
      commit: async (manifest) => {
        await verifyVmRestore(target, id, "owner", manifest.files);
      },
      abort: async () => {},
    });
    await publishVmRestore(target, id, "owner", []);
    const restored = new Database(`${target}/browser/request-evidence.sqlite`);
    expect(
      restored.query("SELECT length(value) AS bytes FROM evidence").get(),
    ).toEqual({ bytes: BACKUP_CHUNK_BYTES * 2 + 37 });
    expect(restored.query("SELECT * FROM native_login").all()).toEqual([]);
    expect(restored.query("SELECT * FROM native_vault").all()).toEqual([]);
    restored.close();
    expect((await readFile(`${target}/browser/unlock-vault.key`)).length).toBe(
      32,
    );
    await expect(
      writeVmRestore(target, id, "../outside", 0, "YQ=="),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

async function restoreAuthorityFixture() {
  const bucket = new Bucket(),
    backups = new CloudBackups(bucket, randomBytes(32).toString("base64"));
  const archive: AccountBackup = {
    version: 1,
    owner: "owner",
    threads: [],
    memory: {},
    state: [],
  };
  const values = new Map([
    ["vm.bin", new Uint8Array([1, 2, 3])],
    ["account.json", new TextEncoder().encode(JSON.stringify(archive))],
  ]);
  const manifest = await backups.save("owner", {
    files: [...values].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
    read: async (path, offset, length) =>
      values.get(path)!.slice(offset, offset + length),
  });
  const effects: string[] = [];
  let current = true,
    authorizations = 0;
  const options: Parameters<typeof backupApi>[1] = {
    owner: "owner",
    backups,
    sandbox: {
      busy: false,
      restore: async (produce: any) => {
        effects.push("stage");
        await produce({
          write: async () => {
            effects.push("write");
          },
          abort: async () => {
            effects.push("abort");
          },
          commit: async () => {
            effects.push("commit");
          },
        });
      },
    } as any,
    resting: async () => true,
    account: async () => {
      effects.push("account");
      return archive;
    },
    importAccount: async () => {
      effects.push("import");
    },
    record: async () => {},
    list: async () => [],
    authorizeRestore: async (id, value, mode) => {
      authorizations++;
      expect(id).toBe(manifest.id);
      expect(value).toEqual(archive);
      expect(["vm", "account"]).toContain(mode);
      return {
        check: async () => {
          if (!current) throw Error("restore revoked");
        },
      };
    },
  };
  return {
    bucket,
    backups,
    manifest,
    archive,
    effects,
    options,
    revoke: () => {
      current = false;
    },
    count: () => authorizations,
    run: (mode: "vm" | "account" = "account") =>
      backupApi(
        new Request("https://owner.test/api/control/restore", {
          method: "POST",
          body: JSON.stringify({ id: manifest.id, mode }),
        }),
        options,
      ),
  };
}
for (const denial of ["missing", "denied", "stale", "invalid"] as const)
  test(`restore ${denial} authorization performs no VM staging or account effects`, async () => {
    const f = await restoreAuthorityFixture();
    if (denial === "missing") delete f.options.authorizeRestore;
    if (denial === "denied")
      f.options.authorizeRestore = async () => {
        throw Error("not authorized");
      };
    if (denial === "stale") f.revoke();
    if (denial === "invalid")
      f.options.authorizeRestore = async () => ({}) as any;
    await expect(f.run()).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
test("VM-only and exact imported retries always reauthorize", async () => {
  const f = await restoreAuthorityFixture();
  expect((await f.run("vm")).status).toBe(200);
  expect(f.effects).not.toContain("import");
  expect((await f.run()).status).toBe(200);
  expect((await f.run()).status).toBe(200);
  expect(f.count()).toBe(3);
  const before = f.effects.slice();
  f.revoke();
  await expect(f.run()).rejects.toThrow("restore revoked");
  expect(f.effects).toEqual(before);
  expect(f.count()).toBe(4);
});
for (const boundary of ["write", "import", "account"] as const)
  test(`revocation during ${boundary} aborts staged restore before publication`, async () => {
    const f = await restoreAuthorityFixture();
    if (boundary === "write")
      f.options.sandbox = {
        busy: false,
        restore: async (produce: any) =>
          produce({
            write: async () => {
              f.effects.push("write");
              f.revoke();
            },
            abort: async () => {
              f.effects.push("abort");
            },
            commit: async () => {
              f.effects.push("commit");
            },
          }),
      } as any;
    if (boundary === "import")
      f.options.importAccount = async () => {
        f.effects.push("import");
        f.revoke();
      };
    if (boundary === "account")
      f.options.account = async () => {
        f.effects.push("account");
        f.revoke();
        return f.archive;
      };
    await expect(f.run()).rejects.toThrow("restore revoked");
    expect(f.effects).toContain("abort");
    expect(f.effects).not.toContain("commit");
    if (boundary === "write") expect(f.effects).not.toContain("import");
    if (boundary === "import") expect(f.effects).not.toContain("account");
  });
test("authenticated single-file read rejects limits and tampering before restore staging", async () => {
  const f = await restoreAuthorityFixture();
  await expect(
    f.backups.readFile("owner", f.manifest.id, "account.json", 1),
  ).rejects.toThrow();
  await expect(
    f.backups.readFile("other", f.manifest.id, "account.json", 1024),
  ).rejects.toThrow();
  const key = [...f.bucket.objects.keys()].find((k) => k.endsWith("/1/0"))!;
  f.bucket.objects.get(key)![0] ^= 1;
  await expect(f.run()).rejects.toThrow();
  expect(f.effects).toEqual([]);
  expect(f.count()).toBe(0);
});

test("restore pins the authorized manifest and aborts if the inventory changes", async () => {
  const f = await restoreAuthorityFixture();
  const read = await f.backups.readFile(
    "owner",
    f.manifest.id,
    "account.json",
    1024,
  );
  const expected = structuredClone(read.manifest);
  expected.files[0]!.sha256 = "0".repeat(64);
  const calls: string[] = [];
  await expect(
    f.backups.restore(
      "owner",
      f.manifest.id,
      {
        write: async () => {
          calls.push("write");
        },
        commit: async () => {
          calls.push("commit");
        },
        abort: async () => {
          calls.push("abort");
        },
      },
      expected,
    ),
  ).rejects.toThrow("Backup manifest changed");
  expect(calls).toEqual(["abort"]);
  delete f.options.authorizeRestore;
  expect(
    (
      await backupApi(
        new Request("https://owner.test/api/control/backups"),
        f.options,
      )
    ).status,
  ).toBe(200);
});
