import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database, enabled, fixture, secret, cookie } from "./helpers.js";
import { freePort, signingKeys } from "./http-helpers.js";
import { OwnerAuth } from "../../apps/server/src/owner-auth.js";
import { Vault } from "../../apps/server/src/vault.js";
import { LocalKeyring, VaultCipher } from "../../apps/server/src/crypto.js";
import { rewrapVault } from "../../apps/server/src/rewrap.js";
import { Imports } from "../../apps/server/src/imports.js";
import { oidcAdapter } from "../../apps/server/src/oidc-adapter.js";
import { configSchema } from "../../apps/server/src/config.js";
import { postgres } from "../../apps/server/src/db.js";
import { registerUnlockMetadataTools } from "../../packages/sdk/src/tools.js";
import type { VaultAgent } from "../../packages/sdk/src/agent.js";
const root = process.cwd();
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}
describe("operator and CLI safety", () => {
  it("provides JSON help/schema/dry-run without credentials and rejects agent-triggered auth UI", () => {
    for (const args of [
      ["help"],
      ["schema", "logins"],
      ["logins", "--dry-run"],
    ]) {
      const result = spawnSync(
        process.execPath,
        ["packages/sdk/dist/cli.js", ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            UNLOCK_AGENT_CONFIG: "",
            UNLOCK_ALLOW_AUTH_UI: "0",
          },
        },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
    }
    const blocked = spawnSync(
      process.execPath,
      ["packages/sdk/dist/cli.js", "login"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          UNLOCK_AGENT_CONFIG: "",
          UNLOCK_ALLOW_AUTH_UI: "0",
        },
      },
    );
    expect(blocked.status).toBe(2);
    expect(JSON.parse(blocked.stdout).error.code).toBe("AUTH_UI_REQUIRED");
  });
  it("generates private operator keys without overwriting files or creating an auth bypass", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unlock-init-")),
      path = join(directory, "server.json");
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/init-backend.mjs", path],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const initial = await readFile(path, "utf8");
      expect(JSON.parse(initial)).not.toHaveProperty("owner");
      expect(result.stdout).not.toContain(
        JSON.parse(initial).encryption.keys.initial,
      );
      expect(
        spawnSync(process.execPath, ["scripts/init-backend.mjs", path], {
          cwd: root,
          encoding: "utf8",
        }).status,
      ).toBe(1);
      expect(await readFile(path, "utf8")).toBe(initial);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("disallows public HTTP, URL-based TLS bypass and unrecognized configuration", () => {
    const valid = {
      origin: "https://vault.test",
      databaseUrl: "postgresql://unused@127.0.0.1/unlock",
      encryption: {
        kind: "local",
        active: "test",
        keys: { test: randomBytes(32).toString("base64") },
      },
      oauth: {
        jwks: { keys: [signingKeys().privateJwk] },
        cookieKeys: ["x".repeat(32)],
      },
    };
    expect(configSchema.safeParse(valid).success).toBe(true);
    expect(
      configSchema.safeParse({ ...valid, origin: "http://public.test" })
        .success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ ...valid, unexpected: "not-accepted" }).success,
    ).toBe(false);
    expect(() =>
      postgres("postgresql://user@database.test/vault?sslmode=no-verify"),
    ).toThrow();
  });
  it("registers only model-safe MCP metadata, never session or credential tools", async () => {
    const registered = new Map<
        string,
        (args: Record<string, unknown>) => Promise<any>
      >(),
      agent = {
        connections: async () => [
          {
            id: "record",
            name: "Name",
            identity: "alice",
            website: "https://service.test",
            sourceReference: "private-source-metadata",
          },
        ],
      } as unknown as VaultAgent;
    registerUnlockMetadataTools(
      {
        registerTool(name, _config, handler) {
          registered.set(name, handler);
        },
      },
      agent,
    );
    expect([...registered.keys()]).toEqual(["unlock_logins"]);
    const result = await registered.get("unlock_logins")!({});
    expect(JSON.parse(result.content[0].text)).toEqual([
      {
        id: "record",
        name: "Name",
        identity: "alice",
        website: "https://service.test",
      },
    ]);
    expect(
      (await registered.get("unlock_logins")!({ password: secret })).isError,
    ).toBe(true);
  });
});
describe.runIf(enabled)("cold process restart and key rotation", () => {
  let pg: Awaited<ReturnType<typeof database>>;
  beforeAll(async () => {
    pg = await database();
  });
  afterAll(async () => {
    await pg?.close();
  });
  it("runs the compiled server and retains data across actual process termination/restart", async () => {
    const f = await fixture(pg.db),
      url = await freePort(),
      origin = url.origin,
      directory = await mkdtemp(join(tmpdir(), "unlock-process-")),
      path = join(directory, "server.json"),
      owner = new OwnerAuth(f.vault, origin),
      session = await owner.createSession("https://identity.test", f.subject);
    await writeFile(
      path,
      JSON.stringify({
        origin,
        port: Number(url.port),
        localDevelopment: true,
        databaseUrl: pg.url,
        encryption: { kind: "local", active: "test", keys: { test: f.key } },
        oauth: {
          jwks: { keys: [signingKeys().privateJwk] },
          cookieKeys: [randomBytes(32).toString("hex")],
        },
        recipes: [],
      }),
      { mode: 0o600 },
    );
    let log = "";
    try {
      for (let run = 0; run < 2; run++) {
        const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
          cwd: root,
          env: { ...process.env, UNLOCK_CONFIG: path },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout!.on("data", (chunk) => (log += chunk));
        child.stderr!.on("data", (chunk) => (log += chunk));
        try {
          let ready = false;
          for (let i = 0; i < 100; i++) {
            try {
              ready = (await fetch(origin + "/ready")).ok;
            } catch {}
            if (ready) break;
            if (child.exitCode !== null) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(ready).toBe(true);
          const response = await fetch(origin + "/v1/connections", {
            headers: { Cookie: "unlock_owner=" + session.token },
          });
          expect(response.status).toBe(200);
          expect((await response.json())[0].id).toBe(f.connection.id);
        } finally {
          await stop(child);
        }
      }
      expect(log).not.toContain(secret);
      expect(log).not.toContain(f.key);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20000);
  it("rewraps credentials, sessions, CSV stages and OAuth payloads for a new key and verifies restored reads", async () => {
    const f = await fixture(pg.db);
    await f.runtime.importSession(f.tenant, f.connection.id, {
      profileId: f.profile.id,
      runtimeId: f.client.id,
      cookies: [cookie()],
    });
    const imports = new Imports(f.vault),
      preview = await imports.preview(f.tenant, {
        csv: "name,url,username,password\nSaved,https://saved.test,a,SYNTHETIC-CSV",
      }),
      Adapter = oidcAdapter(f.vault),
      adapter = new Adapter("AccessToken");
    await adapter.upsert("synthetic-access", { jti: "synthetic-access" }, 60);
    const next = randomBytes(32).toString("base64"),
      keys = { test: f.key, next },
      rotating = new Vault(
        pg.db,
        new VaultCipher(new LocalKeyring("next", keys)),
      );
    const result = await rewrapVault(rotating);
    expect(result.rewrapped).toBeGreaterThanOrEqual(4);
    const restored = new Vault(
      pg.db,
      new VaultCipher(new LocalKeyring("next", { next })),
    );
    expect(await restored.reveal(f.tenant, f.connection.id)).toEqual({
      password: secret,
    });
    expect(
      (await new Imports(restored).commit(f.tenant, preview.id, { rows: [2] }))
        .imported,
    ).toBe(1);
    await expect(f.vault.reveal(f.tenant, f.connection.id)).rejects.toThrow();
    expect(
      await new (oidcAdapter(restored))("AccessToken").find("synthetic-access"),
    ).toHaveProperty("jti", "synthetic-access");
  }, 20000);
});
