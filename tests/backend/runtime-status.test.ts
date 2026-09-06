import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { database, enabled, fixture, cookie } from "./helpers.js";

describe.runIf(enabled)(
  "principal-scoped runtime status and revocation",
  () => {
    let pg: Awaited<ReturnType<typeof database>>;
    beforeAll(async () => {
      pg = await database();
    });
    afterAll(async () => {
      await pg?.close();
    });
    async function published() {
      let now = Date.now();
      const f = await fixture(pg.db, { now: () => now });
      await f.runtime.importSession(f.tenant, f.connection.id, {
        profileId: f.profile.id,
        runtimeId: f.client.id,
        cookies: [cookie()],
      });
      return {
        ...f,
        advance: () => {
          now += 300_000;
        },
      };
    }
    it("returns exact metadata without decrypting, with false verification for expired/unverified sessions", async () => {
      const f = await published();
      const open = vi
        .spyOn(f.cipher, "open")
        .mockRejectedValue(new Error("must not decrypt"));
      const status = await f.runtime.status(f.principal, f.connection.id);
      expect(status).toEqual({
        tenantId: f.tenant,
        profileId: f.profile.id,
        runtimeId: f.client.id,
        connectionId: f.connection.id,
        allowedDomains: ["service.test"],
        verified: true,
        revision: 1,
        expiresAt: f.vault.now() + 300_000,
        renewable: false,
      });
      expect(open).not.toHaveBeenCalled();
      open.mockRestore();
      f.advance();
      await expect(
        f.runtime.status(f.principal, f.connection.id),
      ).resolves.toMatchObject({ verified: false, renewable: true });
      const other = await published();
      await pg.db.query("UPDATE sessions SET verified=false WHERE tenant=$1", [
        other.tenant,
      ]);
      await expect(
        other.runtime.status(other.principal, other.connection.id),
      ).resolves.toMatchObject({ verified: false });
    });
    it("authorizes pending metadata before creation and invalidates stale generations", async () => {
      const f = await fixture(pg.db);
      expect(await f.runtime.status(f.principal, f.connection.id)).toEqual({
        tenantId: f.tenant,
        profileId: f.profile.id,
        runtimeId: f.client.id,
        connectionId: f.connection.id,
        allowedDomains: ["service.test"],
        verified: false,
        revision: 0,
        expiresAt: 0,
        renewable: true,
      });
      await f.runtime.importSession(f.tenant, f.connection.id, {
        profileId: f.profile.id,
        runtimeId: f.client.id,
        cookies: [cookie()],
      });
      await pg.db.query(
        "UPDATE connections SET version=version+1 WHERE tenant=$1 AND id=$2",
        [f.tenant, f.connection.id],
      );
      expect(
        await f.runtime.status(f.principal, f.connection.id),
      ).toMatchObject({ verified: false, revision: 1, renewable: false });
      await pg.db.query("UPDATE sessions SET expires_at=-1 WHERE tenant=$1", [
        f.tenant,
      ]);
      expect(
        await f.runtime.status(f.principal, f.connection.id),
      ).toMatchObject({ verified: false, expiresAt: 0 });
    });
    it("enforces scopes, assignment and exact client without exposing another session", async () => {
      const f = await published();
      await expect(
        f.runtime.status(
          { ...f.principal, scope: ["sessions:write"] },
          f.connection.id,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        f.runtime.revoke(
          { ...f.principal, scope: ["sessions:read"] },
          f.connection.id,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        f.runtime.status({ ...f.principal, connections: [] }, f.connection.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const client = await f.vault.createClient(f.tenant, {
        name: "Second client",
        profileId: f.profile.id,
        connectionIds: [f.connection.id],
        redirectUris: ["http://127.0.0.1:4949/callback"],
      });
      await expect(
        f.runtime.status(
          { ...f.principal, client: client.id },
          f.connection.id,
        ),
      ).resolves.toMatchObject({
        runtimeId: client.id,
        verified: false,
        revision: 0,
        expiresAt: 0,
      });
      const foreign = await published();
      await expect(
        f.runtime.status(foreign.principal, f.connection.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it("revokes only the selected principal, fences old publication and prevents scheduled recreation", async () => {
      const f = await published();
      const client = await f.vault.createClient(f.tenant, {
        name: "Second client",
        profileId: f.profile.id,
        connectionIds: [f.connection.id],
        redirectUris: ["http://127.0.0.1:4949/callback"],
      });
      const other = { ...f.principal, client: client.id };
      await f.runtime.importSession(f.tenant, f.connection.id, {
        profileId: f.profile.id,
        runtimeId: client.id,
        cookies: [cookie()],
      });
      await f.worker.enqueue(f.principal, f.connection.id);
      await f.worker.enqueue(other, f.connection.id);
      await f.runtime.revoke(f.principal, f.connection.id);
      await expect(
        f.runtime.status(f.principal, f.connection.id),
      ).resolves.toMatchObject({ verified: false, renewable: false });
      await expect(
        f.runtime.retrieve(f.principal, f.connection.id),
      ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
      expect((await f.runtime.status(other, f.connection.id)).runtimeId).toBe(
        client.id,
      );
      const jobs = await f.worker.jobs(f.tenant);
      expect(jobs.find((j) => j.runtimeId === f.client.id)?.state).toBe(
        "cancelled",
      );
      expect(jobs.find((j) => j.runtimeId === client.id)?.state).toBe("queued");
      await expect(
        f.worker.enqueue(f.principal, f.connection.id),
      ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
      await f.worker.schedule();
      expect(
        (await f.worker.jobs(f.tenant)).filter(
          (j) => j.runtimeId === f.client.id && j.state === "queued",
        ),
      ).toHaveLength(0);
      const c = await f.vault.connection(pg.db, f.tenant, f.connection.id);
      await expect(
        pg.db.transaction((sql) =>
          f.runtime.publish(
            sql,
            f.principal,
            c,
            {
              identity: "alice",
              cookies: [cookie()],
              expiresAt: f.vault.now() + 300000,
            },
            1,
          ),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(c.maintenance).toBe(true);
      await f.runtime.revoke(f.principal, f.connection.id);
      expect((await f.runtime.status(other, f.connection.id)).runtimeId).toBe(
        client.id,
      );
    });
  },
);
