import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { database, enabled, fixture, cookie, secret } from "./helpers.js";

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
    it.each(["revoked", "generation", "signed_out", "failed", "unverified"])(
      "requires owner recovery before syncing a %s session, even with its current revision",
      async change => {
        const f = await published();
        const original = await f.runtime.retrieve(f.principal, f.connection.id);
        if (change === "revoked") await f.runtime.revoke(f.principal, f.connection.id);
        else if (change === "generation") await f.vault.setPassword(f.tenant, f.connection.id, secret, f.connection.version);
        else if (change === "signed_out") await f.runtime.sync(f.principal, f.connection.id, { revision: original.revision, cookies: [] });
        else await pg.db.query("UPDATE sessions SET status=$2,verified=$3 WHERE tenant=$1", [f.tenant, change === "failed" ? "failed" : "ready", change === "failed"]);
        const status = await f.runtime.status(f.principal, f.connection.id);
        const verify = vi.spyOn(f.runtime, "verify");
        for (const cookies of [original.cookies, []]) {
          await expect(f.runtime.sync(f.principal, f.connection.id, { revision: status.revision, cookies })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
        }
        expect(verify).not.toHaveBeenCalled();
        expect((await f.runtime.status(f.principal, f.connection.id)).revision).toBe(status.revision);
        // Recovery remains a supported owner operation, followed by ordinary runtime sync.
        const recovered = await f.runtime.importSession(f.tenant, f.connection.id, { profileId: f.profile.id, runtimeId: f.client.id, cookies: original.cookies });
        const synced = await f.runtime.sync(f.principal, f.connection.id, { revision: recovered.revision, cookies: original.cookies });
        expect((await f.runtime.retrieve(f.principal, f.connection.id)).revision).toBe(synced.revision);
      },
    );
    it.each(["revoked", "generation", "failed", "unverified"])(
      "fences a %s session change while cookie verification is in flight",
      async change => {
        const f = await published();
        let release!: () => void, entered!: () => void;
        const resumed = new Promise<void>(resolve => { release = resolve; });
        const verifying = new Promise<void>(resolve => { entered = resolve; });
        const originalVerify = f.runtime.verify.bind(f.runtime);
        vi.spyOn(f.runtime, "verify").mockImplementationOnce(async (...args) => {
          const checked = await originalVerify(...args);
          entered();
          await resumed;
          return checked;
        });
        const pending = f.runtime.sync(f.principal, f.connection.id, { revision: 1, cookies: [cookie()] });
        const check = expect(pending).rejects.toMatchObject({ code: change === "revoked" ? "CONFLICT" : "REAUTH_REQUIRED" });
        await verifying;
        try {
          if (change === "revoked") await f.runtime.revoke(f.principal, f.connection.id);
          else if (change === "generation") await f.vault.setPassword(f.tenant, f.connection.id, secret, f.connection.version);
          else await pg.db.query("UPDATE sessions SET status=$2,verified=$3 WHERE tenant=$1", [f.tenant, change === "failed" ? "failed" : "ready", change === "failed"]);
        } finally { release(); }
        await check;
        expect((await f.runtime.status(f.principal, f.connection.id)).verified).toBe(false);
        await expect(f.runtime.retrieve(f.principal, f.connection.id)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
      },
    );
    it.each(["signed_out", "replacement", "expired"])(
      "rejects publication after %s wins the post-verification race",
      async change => {
        const f = await published();
        let release!: () => void, entered!: () => void;
        const resumed = new Promise<void>(resolve => { release = resolve; });
        const verifying = new Promise<void>(resolve => { entered = resolve; });
        const originalVerify = f.runtime.verify.bind(f.runtime);
        vi.spyOn(f.runtime, "verify").mockImplementationOnce(async (...args) => {
          const checked = await originalVerify(...args);
          entered();
          await resumed;
          return checked;
        });
        const pending = f.runtime.sync(f.principal, f.connection.id, { revision: 1, cookies: [cookie()] });
        const check = expect(pending).rejects.toMatchObject({ code: change === "expired" ? "REAUTH_REQUIRED" : "CONFLICT" });
        await verifying;
        try {
          if (change === "expired") f.advance();
          else await f.runtime.sync(f.principal, f.connection.id, { revision: 1, cookies: change === "signed_out" ? [] : [cookie()] });
        } finally { release(); }
        await check;
        expect(await f.runtime.status(f.principal, f.connection.id)).toMatchObject({
          revision: change === "expired" ? 1 : 2,
          verified: change === "replacement",
        });
        if (change === "replacement") expect((await f.runtime.retrieve(f.principal, f.connection.id)).revision).toBe(2);
        else await expect(f.runtime.retrieve(f.principal, f.connection.id)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
      },
    );
    it("rechecks a tombstone before publishing an empty-cookie sign-out", async () => {
      const f = await published();
      const transaction = pg.db.transaction.bind(pg.db);
      let release!: () => void, entered!: () => void, transactions = 0;
      const resumed = new Promise<void>(resolve => { release = resolve; });
      const snapshotRead = new Promise<void>(resolve => { entered = resolve; });
      const spy = vi.spyOn(pg.db, "transaction").mockImplementation(async fn => {
        if (++transactions === 2) { entered(); await resumed; }
        return transaction(fn);
      });
      const pending = f.runtime.sync(f.principal, f.connection.id, { revision: 1, cookies: [] });
      const check = expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
      await snapshotRead;
      try { await f.runtime.revoke(f.principal, f.connection.id); }
      finally { release(); }
      try {
        await check;
        expect(await f.runtime.status(f.principal, f.connection.id)).toMatchObject({ revision: 2, verified: false, renewable: false });
        expect((await f.runtime.stored(pg.db, f.principal, f.connection.id))?.status).toBe("revoked");
      } finally { spy.mockRestore(); }
    });
    it("still verifies an expired ready jar from the current generation", async () => {
      const f = await published();
      f.advance();
      expect((await f.runtime.status(f.principal, f.connection.id)).verified).toBe(false);
      await f.runtime.sync(f.principal, f.connection.id, { revision: 1, cookies: [cookie()] });
      expect((await f.runtime.status(f.principal, f.connection.id)).verified).toBe(true);
    });
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
