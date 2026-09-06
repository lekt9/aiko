import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { database, enabled, fixture, input, cookie } from "./helpers.js";
import { SsoContexts } from "../../apps/server/src/sso.js";
import { context } from "../../apps/server/src/vault.js";
import { Imports } from "../../apps/server/src/imports.js";
describe.runIf(enabled)(
  "maintenance, private SSO and failure boundaries",
  () => {
    let pg: Awaited<ReturnType<typeof database>>;
    beforeAll(async () => {
      pg = await database();
    });
    afterAll(async () => {
      await pg?.close();
    });
    it("schedules unattended renewal with jitter and does not renew a fresh session unnecessarily", async () => {
      let now = Date.now();
      const f = await fixture(pg.db, { now: () => now });
      await f.worker.schedule();
      const job = (await f.worker.jobs(f.tenant))[0];
      expect(job.due).toBeGreaterThanOrEqual(now);
      expect(job.due).toBeLessThan(now + 10000);
      now += 11000;
      await f.worker.tick();
      expect(f.renewals()).toBe(1);
      await f.worker.enqueue(f.principal, f.connection.id);
      await f.worker.tick();
      expect(f.renewals()).toBe(1);
      await f.worker.schedule();
      expect(
        (await f.worker.jobs(f.tenant)).filter((j) => j.state === "queued"),
      ).toHaveLength(0);
    });
    it("returns unsupported-provider challenges instead of synthetic authentication success", async () => {
      const f = await fixture(pg.db);
      await f.vault.update(f.tenant, f.connection.id, {
        version: 1,
        recipeId: "not-installed",
      });
      await f.worker.enqueue(f.principal, f.connection.id);
      await f.worker.tick();
      expect((await f.worker.jobs(f.tenant))[0]).toMatchObject({
        state: "challenge",
        error: "UNSUPPORTED_PROVIDER",
      });
      await expect(
        f.runtime.retrieve(f.principal, f.connection.id),
      ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    });
    it("keeps parent IdP cookies private, checkpoints them with CAS, and hands off only destination sessions", async () => {
      const runtimeId = randomUUID(),
        parentCookie = cookie("SYNTHETIC-PRIVATE-IDP", "identity.test");
      let parentUsed = false;
      const f = await fixture(pg.db, {
        runtimeId,
        recipe: {
          id: "fixture",
          async verify(ctx) {
            return {
              identity: ctx.identity,
              cookies: ctx.cookies,
              expiresAt: Date.now() + 300000,
            };
          },
          async renew(ctx) {
            const parent = await ctx.sso();
            expect(parent?.cookies).toEqual([parentCookie]);
            parentUsed = true;
            await parent!.checkpoint([
              { ...parentCookie, value: "SYNTHETIC-ROTATED-IDP" },
            ]);
            return {
              identity: ctx.identity,
              cookies: [cookie()],
              expiresAt: Date.now() + 300000,
            };
          },
        },
      });
      const sso = new SsoContexts(f.vault),
        parent = await sso.save(f.tenant, {
          identity: "owner@identity.test",
          runtimeId,
          domains: ["identity.test"],
          cookies: [parentCookie],
        }),
        child = await f.vault.add(f.tenant, {
          ...input,
          credential: undefined,
          ssoContextId: parent.id,
        });
      await f.vault.assign(f.tenant, f.profile.id, [child.id]);
      await f.vault.updateClient(f.tenant, f.client.id, {
        connectionIds: [child.id],
      });
      const p = { ...f.principal, connections: [child.id] };
      await f.worker.enqueue(p, child.id);
      await f.worker.tick();
      expect(parentUsed).toBe(true);
      const delivered = await f.runtime.retrieve(p, child.id);
      expect(delivered.cookies).toEqual([cookie()]);
      expect(JSON.stringify(delivered)).not.toContain("IDP");
      expect((await sso.list(f.tenant))[0].version).toBe(2);
      const record = await f.vault.connection(pg.db, f.tenant, child.id),
        ctx = await f.runtime.recipeContext(
          p,
          record,
          [],
          AbortSignal.timeout(1000),
        ),
        first = await ctx.sso(),
        second = await ctx.sso();
      await first!.checkpoint([parentCookie]);
      await expect(second!.checkpoint([parentCookie])).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(
        f.vault.add(f.tenant, {
          ...input,
          website: "https://identity.test",
          domains: ["identity.test"],
          ssoContextId: parent.id,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await sso.disable(f.tenant, parent.id);
      const stored = (
        await pg.db.query<{ secret: any }>(
          "SELECT secret FROM sso_contexts WHERE tenant=$1 AND id=$2",
          [f.tenant, parent.id],
        )
      ).rows[0];
      expect(
        await f.cipher.open(context(f.tenant, "sso", parent.id), stored.secret),
      ).toEqual({ cookies: [], domains: [] });
    });
    it("serializes different destination renewals sharing a private SSO parent", async () => {
      const runtimeId = randomUUID();
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((r) => (entered = r)),
        gate = new Promise<void>((r) => (release = r));
      let calls = 0;
      const f = await fixture(pg.db, {
          runtimeId,
          recipe: {
            id: "fixture",
            async verify(ctx) {
              return {
                identity: ctx.identity,
                cookies: ctx.cookies,
                expiresAt: Date.now() + 300000,
              };
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
                expiresAt: Date.now() + 300000,
              };
            },
          },
        }),
        sso = new SsoContexts(f.vault),
        parent = await sso.save(f.tenant, {
          identity: "owner",
          runtimeId,
          domains: ["identity.test"],
          cookies: [cookie("parent", "identity.test")],
        });
      const a = await f.vault.add(f.tenant, {
          ...input,
          ssoContextId: parent.id,
        }),
        b = await f.vault.add(f.tenant, {
          ...input,
          name: "Second destination",
          ssoContextId: parent.id,
        });
      await f.vault.assign(f.tenant, f.profile.id, [a.id, b.id]);
      await f.vault.updateClient(f.tenant, f.client.id, {
        connectionIds: [a.id, b.id],
      });
      const p = { ...f.principal, connections: [a.id, b.id] };
      await f.worker.enqueue(p, a.id);
      await f.worker.enqueue(p, b.id);
      const first = f.worker.tick();
      await started;
      expect(await f.worker.tick()).toBe(false);
      release();
      await first;
      expect(await f.worker.tick()).toBe(true);
      expect(calls).toBe(2);
    });
    it("fences mismatched private runtimes rather than exporting a parent context", async () => {
      const f = await fixture(pg.db, { runtimeId: randomUUID() }),
        sso = new SsoContexts(f.vault),
        parent = await sso.save(f.tenant, {
          identity: "owner",
          runtimeId: randomUUID(),
          domains: ["identity.test"],
          cookies: [cookie("private", "identity.test")],
        }),
        c = await f.vault.add(f.tenant, { ...input, ssoContextId: parent.id });
      await f.vault.assign(f.tenant, f.profile.id, [c.id]);
      await f.vault.updateClient(f.tenant, f.client.id, {
        connectionIds: [c.id],
      });
      const ctx = await f.runtime.recipeContext(
        { ...f.principal, connections: [c.id] },
        await f.vault.connection(pg.db, f.tenant, c.id),
        [],
        AbortSignal.timeout(1000),
      );
      await expect(ctx.sso()).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
    });
    it("rolls back an entire CSV commit on capacity failure and rechecks concurrent duplicates", async () => {
      const f = await fixture(pg.db),
        imports = new Imports(f.vault),
        p = await imports.preview(f.tenant, {
          csv: "name,url,username,password\nOne,https://one.test,a,x\nTwo,https://two.test,b,y",
        });
      await pg.db.query(
        "INSERT INTO connections(tenant,id,name,identity,website,domains,created_at) SELECT $1,gen_random_uuid()::text,'Filler','filler','https://filler.test','[\"filler.test\"]'::jsonb,0 FROM generate_series(1,1998)",
        [f.tenant],
      );
      await expect(
        imports.commit(f.tenant, p.id, { rows: [2, 3] }),
      ).rejects.toMatchObject({ code: "CAPACITY" });
      expect(
        (
          await pg.db.query(
            "SELECT id FROM connections WHERE tenant=$1 AND identity IN ('a','b')",
            [f.tenant],
          )
        ).rows,
      ).toHaveLength(0);
      await pg.db.query(
        "DELETE FROM connections WHERE tenant=$1 AND name='Filler'",
        [f.tenant],
      );
      await f.vault.add(f.tenant, {
        name: "Manual",
        identity: "a",
        website: "https://one.test",
        domains: ["one.test"],
      });
      expect(
        await imports.commit(f.tenant, p.id, { rows: [2, 3] }),
      ).toMatchObject({ imported: 1, duplicates: 1 });
    });
    it("expires encrypted CSV staging and validates credential revisions before updates", async () => {
      let now = Date.now();
      const f = await fixture(pg.db, { now: () => now }),
        imports = new Imports(f.vault),
        p = await imports.preview(f.tenant, {
          csv: "name,url,username,password\nOne,https://one.test,a,x",
        });
      now += 600001;
      await expect(
        imports.commit(f.tenant, p.id, { rows: [2] }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await f.vault.setPassword(
        f.tenant,
        f.connection.id,
        "SYNTHETIC-NEW-PASSWORD",
        1,
      );
      await expect(
        f.vault.setPassword(f.tenant, f.connection.id, "stale", 1),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await f.vault.reveal(f.tenant, f.connection.id)).toEqual({
        password: "SYNTHETIC-NEW-PASSWORD",
      });
    });
  },
);
