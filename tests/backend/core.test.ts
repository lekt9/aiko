import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { LocalKeyring, VaultCipher } from "../../apps/server/src/crypto.js";
import { Vault } from "../../apps/server/src/vault.js";
import { postgres, migrate } from "../../apps/server/src/db.js";
import { Imports } from "../../apps/server/src/imports.js";
import { VaultError } from "../../apps/server/src/errors.js";
import { validateCookies } from "../../apps/server/src/recipes.js";
import {
  database,
  fixture,
  enabled,
  input,
  secret,
  cookie,
} from "./helpers.js";
describe("envelope encryption and cookie validation", () => {
  it("authenticates tenant/record purpose and rejects tampering", async () => {
    const c = new VaultCipher(
        new LocalKeyring("a", { a: randomBytes(32).toString("base64") }),
      ),
      sealed = await c.seal("tenant:a:credential:1", { password: secret });
    expect(JSON.stringify(sealed)).not.toContain(secret);
    expect(await c.open("tenant:a:credential:1", sealed)).toEqual({
      password: secret,
    });
    await expect(c.open("tenant:b:credential:1", sealed)).rejects.toThrow();
    await expect(c.open("tenant:a:session:1", sealed)).rejects.toThrow();
    await expect(
      c.open("tenant:a:credential:1", { ...sealed, data: "AAAA" }),
    ).rejects.toThrow();
  });
  it("rewraps data keys without changing ciphertext and can retire old master keys", async () => {
    const a = randomBytes(32).toString("base64"),
      b = randomBytes(32).toString("base64"),
      old = new VaultCipher(new LocalKeyring("a", { a })),
      next = new VaultCipher(new LocalKeyring("b", { a, b })),
      value = await old.seal("record", secret),
      rotated = await next.rewrap("record", value);
    expect(rotated.data).toBe(value.data);
    expect(
      await new VaultCipher(new LocalKeyring("b", { b })).open(
        "record",
        rotated,
      ),
    ).toBe(secret);
    await expect(old.open("record", rotated)).rejects.toThrow();
  });
  it("enforces exact domains, host-only semantics, Secure, prefixes and partitions", () => {
    expect(validateCookies([cookie()], ["service.test"])).toHaveLength(1);
    for (const c of [
      cookie("x", "evil.test"),
      { ...cookie(), domain: ".service.test" },
      { ...cookie(), secure: false },
      { ...cookie(), name: "__Host-sid", path: "/other" },
      {
        ...cookie(),
        partitionKey: {
          topLevelSite: "http://evil.test",
          hasCrossSiteAncestor: false,
        },
      },
    ])
      expect(() => validateCookies([c], ["service.test"])).toThrow();
    expect(() =>
      validateCookies([cookie(), cookie()], ["service.test"]),
    ).toThrow();
  });
});
describe.runIf(enabled)("real PostgreSQL vault and runtime", () => {
  let pg: Awaited<ReturnType<typeof database>>;
  beforeAll(async () => {
    pg = await database();
  }, 20000);
  afterAll(async () => {
    await pg?.close();
  });
  it("persists encrypted credentials across connection pools and idempotent migrations", async () => {
    const f = await fixture(pg.db),
      second = postgres(pg.url);
    try {
      await migrate(second);
      const v = new Vault(second, f.cipher);
      expect(await v.reveal(f.tenant, f.connection.id)).toEqual({
        password: secret,
      });
      const row = (
        await second.query("SELECT * FROM connections WHERE tenant=$1", [
          f.tenant,
        ])
      ).rows[0];
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(JSON.stringify(await v.list(f.tenant))).not.toContain(secret);
    } finally {
      await second.close();
    }
  });
  it("isolates tenants and validates assignments atomically", async () => {
    const a = await fixture(pg.db),
      b = await fixture(pg.db);
    await expect(
      a.vault.reveal(b.tenant, a.connection.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      a.vault.assign(a.tenant, a.profile.id, [
        a.connection.id,
        b.connection.id,
      ]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await a.vault.profiles(a.tenant))[0].connectionIds).toEqual([
      a.connection.id,
    ]);
    await expect(
      a.runtime.retrieve({ ...a.principal, tenant: b.tenant }, a.connection.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("uses standing access, encrypts destination cookies and never returns passwords in metadata", async () => {
    const f = await fixture(pg.db);
    await expect(
      f.runtime.retrieve(f.principal, f.connection.id),
    ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await f.worker.enqueue(f.principal, f.connection.id);
    expect(await f.worker.tick()).toBe(true);
    const result = await f.runtime.retrieve(f.principal, f.connection.id);
    expect(result.cookies).toEqual([cookie()]);
    expect(result.profileId).toBe(f.profile.id);
    const rows = await pg.db.query("SELECT * FROM sessions WHERE tenant=$1", [
      f.tenant,
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain("verified-alice");
    expect(JSON.stringify(await f.vault.events(f.tenant))).not.toContain(
      secret,
    );
    expect(f.renewals()).toBe(1);
  });
  it("rejects wrong identity and arbitrary cookies before publication", async () => {
    const f = await fixture(pg.db);
    await expect(
      f.runtime.importSession(f.tenant, f.connection.id, {
        profileId: f.profile.id,
        runtimeId: f.client.id,
        cookies: [cookie("wrong-user")],
      }),
    ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(
      (await pg.db.query("SELECT * FROM sessions WHERE tenant=$1", [f.tenant]))
        .rows,
    ).toHaveLength(0);
    await expect(
      f.runtime.importSession(f.tenant, f.connection.id, {
        profileId: f.profile.id,
        runtimeId: f.client.id,
        cookies: [cookie("verified-alice", "evil.test")],
      }),
    ).rejects.toThrow();
  });
  it("performs compare-and-swap with one winner and handles cookie deletions/logout", async () => {
    const f = await fixture(pg.db);
    await f.runtime.importSession(f.tenant, f.connection.id, {
      profileId: f.profile.id,
      runtimeId: f.client.id,
      cookies: [cookie()],
    });
    const results = await Promise.allSettled([
      f.runtime.sync(f.principal, f.connection.id, {
        revision: 1,
        cookies: [cookie()],
      }),
      f.runtime.sync(f.principal, f.connection.id, {
        revision: 1,
        cookies: [cookie()],
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")[0]).toMatchObject({
      reason: { code: "CONFLICT" },
    });
    expect(
      await f.runtime.sync(f.principal, f.connection.id, {
        revision: 2,
        cookies: [],
      }),
    ).toMatchObject({ revision: 3 });
    await expect(
      f.runtime.retrieve(f.principal, f.connection.id),
    ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect((await f.vault.list(f.tenant))[0].maintenance).toBe(false);
  });
  it("blocks disabled profiles, revoked clients, missing scopes and removed assignments", async () => {
    for (const change of ["profile", "client", "assignment", "scope"]) {
      const f = await fixture(pg.db);
      await f.runtime.importSession(f.tenant, f.connection.id, {
        profileId: f.profile.id,
        runtimeId: f.client.id,
        cookies: [cookie()],
      });
      if (change === "profile")
        await f.vault.saveProfile(
          f.tenant,
          { name: "Agent", enabled: false },
          f.profile.id,
        );
      if (change === "client")
        await f.vault.revokeClient(f.tenant, f.client.id);
      if (change === "assignment")
        await f.vault.assign(f.tenant, f.profile.id, []);
      await expect(
        f.runtime.retrieve(
          change === "scope" ? { ...f.principal, scope: [] } : f.principal,
          f.connection.id,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
  it("keeps one login shared by multiple profiles without duplicating credentials", async () => {
    const f = await fixture(pg.db),
      p = await f.vault.saveProfile(f.tenant, { name: "Second agent" });
    await f.vault.assign(f.tenant, p.id, [f.connection.id]);
    expect(await f.vault.list(f.tenant)).toHaveLength(1);
    await f.vault.assign(f.tenant, f.profile.id, []);
    expect(
      (await f.vault.profiles(f.tenant)).find((x) => x.id === p.id)
        ?.connectionIds,
    ).toEqual([f.connection.id]);
    await f.vault.remove(f.tenant, f.connection.id);
    expect(
      (await f.vault.profiles(f.tenant)).every(
        (p) => p.connectionIds.length === 0,
      ),
    ).toBe(true);
    expect(
      (
        await pg.db.query("SELECT secret FROM connections WHERE tenant=$1", [
          f.tenant,
        ])
      ).rows[0].secret,
    ).toBeNull();
  });
  it("resolves selected 1Password references privately and refuses native overwrite", async () => {
    let calls = 0;
    const f = await fixture(pg.db, {
      source: {
        async resolve(token, reference) {
          expect(token).toBe("synthetic-source-token");
          expect(reference).toBe("op://vault/item/password");
          calls++;
          return secret;
        },
      },
    });
    const source = await f.vault.addSource(f.tenant, {
        name: "1Password",
        kind: "onepassword",
        token: "synthetic-source-token",
        references: ["op://vault/item/password"],
      }),
      c = await f.vault.add(f.tenant, {
        ...input,
        credential: undefined,
        sourceId: source.id,
        sourceReference: "op://vault/item/password",
      });
    await f.vault.assign(f.tenant, f.profile.id, [c.id]);
    await f.vault.updateClient(f.tenant, f.client.id, {
      connectionIds: [c.id],
    });
    const p = { ...f.principal, connections: [c.id] };
    await f.worker.enqueue(p, c.id);
    await f.worker.tick();
    expect(calls).toBe(1);
    expect(
      (await f.vault.list(f.tenant)).find((x) => x.id === c.id)?.hasPassword,
    ).toBe(false);
    await expect(
      f.vault.setPassword(f.tenant, c.id, secret, 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await f.vault.disconnectSource(f.tenant, source.id);
    await expect(f.runtime.retrieve(p, c.id)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(
      JSON.stringify(
        (
          await pg.db.query("SELECT secret FROM sources WHERE tenant=$1", [
            f.tenant,
          ])
        ).rows,
      ),
    ).not.toContain("synthetic-source-token");
  });
  it("supports encrypted CSV preview, selection, idempotent commit and independent snapshots", async () => {
    const f = await fixture(pg.db),
      imports = new Imports(f.vault),
      csv = `name,url,username,password\r\nOne,https://one.test/path,alice,${secret}\r\nTwo,https://two.test,bob,${secret}`;
    const preview = await imports.preview(f.tenant, { csv });
    expect(JSON.stringify(preview)).not.toContain(secret);
    expect(preview.rows.map((r) => r.status)).toEqual(["ready", "ready"]);
    expect(
      JSON.stringify(
        (
          await pg.db.query("SELECT secret FROM imports WHERE tenant=$1", [
            f.tenant,
          ])
        ).rows,
      ),
    ).not.toContain(secret);
    const result = await imports.commit(f.tenant, preview.id, { rows: [2] });
    expect(result.imported).toBe(1);
    expect(await imports.commit(f.tenant, preview.id, { rows: [2] })).toEqual(
      result,
    );
    await expect(
      imports.commit(f.tenant, preview.id, { rows: [3] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.vault.reveal(f.tenant, result.connectionIds[0])).toEqual({
      password: secret,
    });
    expect((await f.vault.profiles(f.tenant))[0].connectionIds).toEqual([
      f.connection.id,
    ]);
    const receipt = (
      await pg.db.query<{ secret: any }>(
        "SELECT secret FROM imports WHERE tenant=$1 AND id=$2",
        [f.tenant, preview.id],
      )
    ).rows[0];
    expect(
      await f.cipher.open(
        `unlock:v1:${f.tenant}:import:${preview.id}`,
        receipt.secret,
      ),
    ).not.toHaveProperty("rows");
  });
  it("imports all 1,000 CSV rows atomically, preserving multiple usernames per website", async () => {
    const f = await fixture(pg.db),
      imports = new Imports(f.vault),
      csv =
        "name,url,username,password\n" +
        Array.from(
          { length: 1000 },
          (_, i) => `Login ${i},https://bulk.test,user${i},${secret}`,
        ).join("\n"),
      p = await imports.preview(f.tenant, { csv }),
      result = await imports.commit(f.tenant, p.id, {
        rows: p.rows.map((r) => r.row),
      });
    expect(result.imported).toBe(1000);
    expect(await f.vault.list(f.tenant)).toHaveLength(1001);
    const again = await imports.preview(f.tenant, { csv });
    expect(again.rows.every((r) => r.status === "duplicate")).toBe(true);
  }, 30000);
  it("bounds CSVs, blocks malformed quoting and reports invalid/non-login rows without secret echoes", async () => {
    const f = await fixture(pg.db),
      imports = new Imports(f.vault);
    await expect(
      imports.preview(f.tenant, { csv: 'name,url,username,password\n"broken' }),
    ).rejects.toThrow();
    await expect(
      imports.preview(f.tenant, { csv: "x".repeat(1_048_577) }),
    ).rejects.toThrow();
    const p = await imports.preview(f.tenant, {
      csv: `name,url,username,password,type\nBad,http://insecure.test,a,${secret},login\nNote,https://note.test,b,${secret},note`,
    });
    expect(p.rows.map((r) => r.status)).toEqual(["invalid", "unsupported"]);
    expect(JSON.stringify(p)).not.toContain(secret);
  });
  it("fences an in-flight renewal when owner access changes", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const f = await fixture(pg.db, {
      recipe: {
        id: "fixture",
        async verify() {
          throw new VaultError("REAUTH_REQUIRED", 409);
        },
        async renew(ctx) {
          entered();
          await gate;
          return {
            identity: ctx.identity,
            cookies: [cookie()],
            expiresAt: Date.now() + 300_000,
          };
        },
      },
    });
    await f.worker.enqueue(f.principal, f.connection.id);
    const ticking = f.worker.tick();
    await started;
    await f.vault.assign(f.tenant, f.profile.id, []);
    release();
    await ticking;
    expect(
      (await pg.db.query("SELECT * FROM sessions WHERE tenant=$1", [f.tenant]))
        .rows,
    ).toHaveLength(0);
    expect((await f.worker.jobs(f.tenant))[0].state).toBe("cancelled");
  });
  it("recovers expired job claims but never lets the old worker publish over the new result", async () => {
    let now = Date.now(),
      entered!: () => void,
      release!: () => void,
      calls = 0;
    const started = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const f = await fixture(pg.db, {
      now: () => now,
      recipe: {
        id: "fixture",
        async verify() {
          throw new Error();
        },
        async renew(ctx) {
          calls++;
          if (calls === 1) {
            entered();
            await gate;
          }
          return {
            identity: ctx.identity,
            cookies: [cookie()],
            expiresAt: now + 300_000,
          };
        },
      },
    });
    await f.worker.enqueue(f.principal, f.connection.id);
    const old = f.worker.tick();
    await started;
    now += 61000;
    expect(await f.worker.tick()).toBe(true);
    release();
    await old;
    expect(
      (await f.runtime.retrieve(f.principal, f.connection.id)).revision,
    ).toBe(1);
    expect((await f.worker.jobs(f.tenant))[0].state).toBe("done");
  });
  it("stops repeated challenges and retries transient errors only three times", async () => {
    let now = Date.now(),
      calls = 0;
    const f = await fixture(pg.db, {
      now: () => now,
      recipe: {
        id: "fixture",
        async verify() {
          throw new Error();
        },
        async renew() {
          calls++;
          throw new VaultError("UNAVAILABLE", 503);
        },
      },
    });
    await Promise.all([
      f.worker.enqueue(f.principal, f.connection.id),
      f.worker.enqueue(f.principal, f.connection.id),
    ]);
    expect(await f.worker.jobs(f.tenant)).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      expect(await f.worker.tick()).toBe(true);
      now += 60000;
    }
    expect(calls).toBe(3);
    expect((await f.worker.jobs(f.tenant))[0]).toMatchObject({
      state: "challenge",
      attempts: 3,
    });
    await expect(
      f.worker.enqueue(f.principal, f.connection.id),
    ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
  });
});
