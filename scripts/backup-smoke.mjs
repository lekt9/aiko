import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { postgres, migrate } from "../apps/server/dist/db.js";
import { Vault } from "../apps/server/dist/vault.js";
import { VaultCipher, LocalKeyring } from "../apps/server/dist/crypto.js";
import { Runtime } from "../apps/server/dist/runtime.js";
import assert from "node:assert/strict";
async function main() {
  const value = process.env.UNLOCK_TEST_DATABASE_URL,
    container = process.env.UNLOCK_TEST_PG_CONTAINER;
  if (!value || !container)
    throw new Error("Dedicated test database and container required");
  const base = new URL(value);
  if (base.hostname !== "127.0.0.1")
    throw new Error("Loopback test database required");
  const suffix = randomUUID().replaceAll("-", ""),
    schema = "unlock_backup_" + suffix,
    restoreName = "unlock_restore_" + suffix,
    admin = postgres(value);
  let db,
    restored,
    created = false;
  const docker = (args, input) => {
    const result = spawnSync(
      "docker",
      ["exec", ...(input ? ["-i"] : []), container, ...args],
      { input, maxBuffer: 20 * 1024 * 1024 },
    );
    if (result.status !== 0)
      throw new Error("PostgreSQL backup/restore command failed");
    return result.stdout;
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(value);
    url.searchParams.set("options", `-c search_path=${schema}`);
    db = postgres(url.href);
    await migrate(db);
    const cipher = new VaultCipher(
        new LocalKeyring("fixture", {
          fixture: randomBytes(32).toString("base64"),
        }),
      ),
      vault = new Vault(db, cipher),
      tenant = await vault.owner("https://identity.test", "backup-fixture"),
      password = "SYNTHETIC-BACKUP-PASSWORD",
      cookieValue = "SYNTHETIC-BACKUP-COOKIE";
    const c = await vault.add(tenant, {
        name: "Backup fixture",
        identity: "alice",
        website: "https://backup.test",
        domains: ["backup.test"],
        credential: { password },
        recipeId: "fixture",
      }),
      profile = await vault.saveProfile(tenant, { name: "Backup agent" });
    await vault.assign(tenant, profile.id, [c.id]);
    const client = await vault.createClient(tenant, {
      name: "Backup runtime",
      profileId: profile.id,
      connectionIds: [c.id],
      redirectUris: ["http://127.0.0.1:4949/callback"],
    });
    const verify = async (ctx) => ({
        identity: ctx.identity,
        cookies: ctx.cookies,
        expiresAt: Date.now() + 300000,
      }),
      recipes = new Map([
        ["fixture", { id: "fixture", verify, renew: verify }],
      ]),
      source = {
        async resolve() {
          throw new Error("Not used");
        },
      },
      runtime = new Runtime(vault, recipes, source),
      cookies = [
        {
          name: "sid",
          value: cookieValue,
          domain: "backup.test",
          path: "/",
          expires: -1,
          hostOnly: true,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ];
    await runtime.importSession(tenant, c.id, {
      profileId: profile.id,
      runtimeId: client.id,
      cookies,
    });
    const dump = docker([
      "pg_dump",
      "-U",
      decodeURIComponent(base.username),
      "-d",
      base.pathname.slice(1),
      "--no-owner",
      "--no-acl",
      "--schema",
      schema,
    ]);
    assert.equal(dump.includes(Buffer.from(password)), false);
    assert.equal(dump.includes(Buffer.from(cookieValue)), false);
    await admin.query(`CREATE DATABASE ${restoreName}`);
    created = true;
    docker(
      [
        "psql",
        "-U",
        decodeURIComponent(base.username),
        "-d",
        restoreName,
        "-v",
        "ON_ERROR_STOP=1",
      ],
      dump,
    );
    url.pathname = "/" + restoreName;
    restored = postgres(url.href);
    await migrate(restored);
    const restoredVault = new Vault(restored, cipher),
      restoredRuntime = new Runtime(restoredVault, recipes, source);
    assert.deepEqual(await restoredVault.reveal(tenant, c.id), { password });
    const principal = {
      tenant,
      profile: profile.id,
      client: client.id,
      connections: [c.id],
      scope: ["sessions:read"],
    };
    assert.deepEqual(
      (await restoredRuntime.retrieve(principal, c.id)).cookies,
      cookies,
    );
    await mkdir("artifacts/backend-qa", { recursive: true });
    await writeFile(
      "artifacts/backend-qa/backup-results.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          checks: [
            {
              check:
                "Real pg_dump omits plaintext password and cookie canaries",
              passed: true,
            },
            {
              check:
                "Restore into a separate database retains decryptable credentials, assignments and scoped sessions",
              passed: true,
            },
          ],
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS: encrypted PostgreSQL dump and separate-database restore. No credentials or dump contents printed.",
    );
  } finally {
    await restored?.close();
    await db?.close();
    if (created) await admin.query(`DROP DATABASE ${restoreName}`);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close();
  }
}
main().catch(() => {
  console.error(
    "Backup smoke test failed. It requires a dedicated local PostgreSQL container matching UNLOCK_TEST_DATABASE_URL. No connection strings or dump contents were logged.",
  );
  process.exitCode = 1;
});
