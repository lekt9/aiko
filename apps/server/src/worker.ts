import { randomUUID } from "node:crypto";
import type { Sql } from "./db.js";
import type { Verified } from "./recipes.js";
import type { VaultCookie } from "@unlock/protocol";
import type { RuntimePrincipal } from "./vault.js";
import { Runtime, sessionKey } from "./runtime.js";
import { VaultError } from "./errors.js";
type Job = Record<string, unknown> & {
  id: string;
  tenant: string;
  connection: string;
  profile: string;
  client: string;
  generation: number;
  reason: string;
  state: string;
  attempts: number;
  claim: string;
  due: string;
  error: string | null;
};
export class Maintainer {
  constructor(public runtime: Runtime) {}
  async enqueue(
    p: RuntimePrincipal,
    connection: string,
    reason = "auth_failed",
  ) {
    if (!p.scope.includes("maintenance:request"))
      throw new VaultError("FORBIDDEN", 403);
    const v = this.runtime.vault;
    return v.db.transaction(async (sql) => {
      const c = await v.authorize(sql, p, connection, true);
      if (
        !c.maintenance ||
        (await this.runtime.stored(sql, p, connection, true))?.status ===
          "revoked"
      )
        throw new VaultError("REAUTH_REQUIRED", 409);
      const result = await sql.query<{ id: string }>(
        "INSERT INTO jobs(id,tenant,connection,profile,client,generation,reason,due) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant,connection,profile,client) WHERE state IN ('queued','running') DO UPDATE SET due=LEAST(jobs.due,EXCLUDED.due) RETURNING id",
        [
          randomUUID(),
          p.tenant,
          connection,
          p.profile,
          p.client,
          c.version,
          reason,
          v.now() +
            (reason === "scheduled" ? Math.floor(Math.random() * 10000) : 0),
        ],
      );
      return { id: result.rows[0].id };
    });
  }
  async jobs(tenant: string) {
    return (
      await this.runtime.vault.db.query<Job>(
        "SELECT * FROM jobs WHERE tenant=$1 ORDER BY due DESC LIMIT 250",
        [tenant],
      )
    ).rows.map((j) => ({
      id: j.id,
      connectionId: j.connection,
      profileId: j.profile,
      runtimeId: j.client,
      state: j.state,
      attempts: j.attempts,
      reason: j.reason,
      error: j.error,
      due: Number(j.due),
    }));
  }
  async schedule() {
    const v = this.runtime.vault,
      now = v.now();
    const eligible = await v.db.query<{
      tenant: string;
      connection: string;
      profile: string;
      client: string;
      connections: string[];
    }>(
      `SELECT c.tenant,c.id AS connection,p.id AS profile,cl.id AS client,cl.connections FROM connections c JOIN assignments a ON a.tenant=c.tenant AND a.connection=c.id JOIN profiles p ON p.tenant=a.tenant AND p.id=a.profile JOIN clients cl ON cl.tenant=p.tenant AND cl.profile=p.id LEFT JOIN sessions s ON s.tenant=c.tenant AND s.connection=c.id AND s.profile=p.id AND s.client=cl.id WHERE c.maintenance AND NOT c.deleted AND p.enabled AND cl.enabled AND cl.connections ? c.id AND (s.status IS NULL OR s.status <> 'revoked') AND (s.expires_at IS NULL OR s.expires_at <= $1) LIMIT 100`,
      [now + 60_000],
    );
    for (const row of eligible.rows) {
      try {
        await this.enqueue(
          { ...row, scope: ["maintenance:request"] },
          row.connection,
          "scheduled",
        );
      } catch (error) {
        if (!(error instanceof VaultError)) throw error;
      }
    }
    await v.db.query("DELETE FROM imports WHERE expires_at<$1", [now]);
    await v.db.query("DELETE FROM auth_states WHERE expires_at<$1", [now]);
    await v.db.query("DELETE FROM owner_sessions WHERE expires_at<$1", [now]);
    await v.db.query("DELETE FROM oidc_objects WHERE expires_at<$1", [now]);
    await v.db.query("DELETE FROM rate_limits WHERE expires_at<$1", [now]);
    await v.db.query("DELETE FROM audit WHERE at<$1", [now - 90 * 86400_000]);
    await v.db.query(
      "DELETE FROM jobs WHERE state NOT IN ('running','queued') AND due<$1",
      [now - 30 * 86400_000],
    );
  }
  async tick() {
    const v = this.runtime.vault,
      now = v.now();
    const job = await v.db.transaction(async (sql) => {
      await sql.query(
        "UPDATE jobs SET state='queued',claim=NULL WHERE state='running' AND lease_until<=$1",
        [now],
      );
      const j = (
        await sql.query<Job>(
          "SELECT j.* FROM jobs j WHERE j.state='queued' AND j.due<=$1 AND NOT EXISTS(SELECT 1 FROM account_locks l WHERE l.tenant=j.tenant AND (l.connection=j.connection OR l.connection=(SELECT 'sso:'||parent FROM connection_sso WHERE tenant=j.tenant AND connection=j.connection)) AND l.lease_until>$1) ORDER BY due FOR UPDATE OF j SKIP LOCKED LIMIT 1",
          [now],
        )
      ).rows[0];
      if (!j) return undefined;
      const claim = randomUUID(),
        parent = (
          await sql.query<{ parent: string }>(
            "SELECT parent FROM connection_sso WHERE tenant=$1 AND connection=$2",
            [j.tenant, j.connection],
          )
        ).rows[0];
      for (const key of [
        j.connection,
        ...(parent ? ["sso:" + parent.parent] : []),
      ]) {
        const lock = await sql.query(
          "INSERT INTO account_locks(tenant,connection,claim,lease_until) VALUES($1,$2,$3,$4) ON CONFLICT(tenant,connection) DO UPDATE SET claim=EXCLUDED.claim,lease_until=EXCLUDED.lease_until WHERE account_locks.lease_until<=$5 RETURNING claim",
          [j.tenant, key, claim, now + 60_000, now],
        );
        if (!lock.rows.length) {
          await sql.query(
            "DELETE FROM account_locks WHERE tenant=$1 AND claim=$2",
            [j.tenant, claim],
          );
          return undefined;
        }
      }
      await sql.query(
        "UPDATE jobs SET state='running',claim=$2,lease_until=$3,attempts=attempts+1 WHERE id=$1",
        [j.id, claim, now + 60_000],
      );
      return { ...j, claim, attempts: j.attempts + 1 };
    });
    if (!job) return false;
    try {
      const client = (
        await v.db.query<{ connections: string[] }>(
          "SELECT connections FROM clients WHERE tenant=$1 AND id=$2 AND enabled",
          [job.tenant, job.client],
        )
      ).rows[0];
      if (!client) throw new VaultError("REVOKED", 403);
      const p: RuntimePrincipal = {
        tenant: job.tenant,
        profile: job.profile,
        client: job.client,
        connections: client.connections,
        scope: ["sessions:read", "sessions:write"],
      };
      const snapshot = await v.db.transaction(async (sql) => {
        const c = await v.authorize(sql, p, job.connection, true);
        if (!c.maintenance || c.version !== job.generation)
          throw new VaultError("REVOKED", 403);
        const s = await this.runtime.stored(sql, p, c.id);
        if (s?.status === "revoked") throw new VaultError("REVOKED", 403);
        const profile = (
          await sql.query<{ version: number }>(
            "SELECT version FROM profiles WHERE tenant=$1 AND id=$2",
            [p.tenant, p.profile],
          )
        ).rows[0];
        return { c, s, profileVersion: profile.version };
      });
      const cookies = snapshot.s
        ? (
            await v.cipher.open<{ cookies: VaultCookie[] }>(
              sessionKey(p, job.connection),
              snapshot.s.secret,
            )
          ).cookies
        : [];
      const fence = async (sql: Sql) => {
        if (
          !(
            await sql.query(
              "SELECT id FROM jobs WHERE id=$1 AND claim=$2 AND state='running' AND lease_until>$3 FOR UPDATE",
              [job.id, job.claim, v.now()],
            )
          ).rows.length
        )
          throw new VaultError("CONFLICT", 409);
      };
      let checked: Verified | undefined;
      if (cookies.length) {
        try {
          checked = await this.runtime.verify(
            p,
            snapshot.c,
            cookies,
            false,
            fence,
          );
        } catch (error) {
          if (
            !(error instanceof VaultError) ||
            error.code !== "REAUTH_REQUIRED"
          )
            throw error;
        }
      }
      if (!checked || checked.expiresAt <= v.now() + 60000)
        checked = await this.runtime.verify(
          p,
          snapshot.c,
          cookies,
          true,
          fence,
        );
      await v.db.transaction(async (sql) => {
        await v.lock(sql, job.tenant);
        const active = (
          await sql.query(
            "SELECT id FROM jobs WHERE id=$1 AND claim=$2 AND state='running' AND lease_until>$3 FOR UPDATE",
            [job.id, job.claim, v.now()],
          )
        ).rows[0];
        if (!active) throw new VaultError("CONFLICT", 409);
        const profile = (
          await sql.query<{ version: number }>(
            "SELECT version FROM profiles WHERE tenant=$1 AND id=$2 FOR SHARE",
            [p.tenant, p.profile],
          )
        ).rows[0];
        if (profile?.version !== snapshot.profileVersion)
          throw new VaultError("CONFLICT", 409);
        await this.runtime.publish(
          sql,
          p,
          snapshot.c,
          checked,
          snapshot.s?.revision ?? null,
        );
        await sql.query(
          "UPDATE jobs SET state='done',claim=NULL,error=NULL WHERE id=$1 AND claim=$2",
          [job.id, job.claim],
        );
      });
    } catch (error) {
      const code = error instanceof VaultError ? error.code : "UNAVAILABLE",
        retry =
          [
            "UNAVAILABLE",
            "RUNTIME_UNAVAILABLE",
            "SOURCE_UNAVAILABLE",
            "RATE_LIMITED",
          ].includes(code) && job.attempts < 3;
      await v.db.transaction(async (sql) => {
        await v.lock(sql, job.tenant);
        const active = (
          await sql.query(
            "SELECT id FROM jobs WHERE id=$1 AND claim=$2 AND state='running' FOR UPDATE",
            [job.id, job.claim],
          )
        ).rows[0];
        if (!active) return;
        await sql.query(
          "UPDATE jobs SET state=$3,error=$4,due=$5,claim=NULL WHERE id=$1 AND claim=$2",
          [
            job.id,
            job.claim,
            retry ? "queued" : code === "CONFLICT" ? "superseded" : "challenge",
            code,
            v.now() +
              5000 * 2 ** job.attempts +
              Math.floor(Math.random() * 1000),
          ],
        );
        if (!retry && code !== "CONFLICT")
          await sql.query(
            "UPDATE connections SET maintenance=false,version=version+1 WHERE tenant=$1 AND id=$2 AND version=$3",
            [job.tenant, job.connection, job.generation],
          );
        await v.audit(
          sql,
          job.tenant,
          "maintainer",
          retry ? "renewal.retry" : "renewal.stopped",
          job.connection,
          { code, attempt: job.attempts },
        );
      });
    } finally {
      await v.db.query(
        "DELETE FROM account_locks WHERE tenant=$1 AND claim=$2",
        [job.tenant, job.claim],
      );
    }
    return true;
  }
}
