import { randomUUID } from "node:crypto";
import { cookieJar, domains, id, identity, z } from "@unlock/protocol";
import { context, Vault } from "./vault.js";
import { requireValue, VaultError } from "./errors.js";
import { validateCookies } from "./recipes.js";
const input = z
  .object({
    identity,
    runtimeId: id,
    domains,
    cookies: cookieJar.refine((c) => c.length > 0),
  })
  .strict();
export class SsoContexts {
  constructor(private vault: Vault) {}
  async list(tenant: string) {
    return (
      await this.vault.db.query<{
        id: string;
        identity: string;
        runtime: string;
        enabled: boolean;
        version: number;
      }>(
        "SELECT id,identity,runtime,enabled,version FROM sso_contexts WHERE tenant=$1",
        [tenant],
      )
    ).rows.map((s) => ({
      id: s.id,
      identity: s.identity,
      runtimeId: s.runtime,
      enabled: s.enabled,
      version: s.version,
    }));
  }
  async save(tenant: string, body: unknown, parentId?: string) {
    const value = (
        parentId
          ? input.extend({ version: z.number().int().positive() })
          : input
      ).parse(body),
      parent = parentId ?? randomUUID();
    const secret = await this.vault.cipher.seal(
      context(tenant, "sso", parent),
      {
        domains: value.domains,
        cookies: validateCookies(value.cookies, value.domains),
      },
    );
    return this.vault.db.transaction(async (sql) => {
      await this.vault.lock(sql, tenant);
      if (parentId) {
        const children = await sql.query<{ domains: string[] }>(
          "SELECT c.domains FROM connections c JOIN connection_sso s ON s.tenant=c.tenant AND s.connection=c.id WHERE s.tenant=$1 AND s.parent=$2",
          [tenant, parent],
        );
        if (
          children.rows.some((c) =>
            c.domains.some((d) => value.domains.includes(d)),
          )
        )
          throw new VaultError("FORBIDDEN", 403);
        const saved = await sql.query(
          "UPDATE sso_contexts SET identity=$3,runtime=$4,secret=$5,enabled=true,version=version+1 WHERE tenant=$1 AND id=$2 AND version=$6 RETURNING id",
          [
            tenant,
            parent,
            value.identity,
            value.runtimeId,
            JSON.stringify(secret),
            "version" in value ? value.version : 0,
          ],
        );
        if (!saved.rows.length) throw new VaultError("CONFLICT", 409);
        await sql.query(
          "UPDATE connections SET version=version+1 WHERE tenant=$1 AND id IN(SELECT connection FROM connection_sso WHERE tenant=$1 AND parent=$2)",
          [tenant, parent],
        );
        await sql.query(
          "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND connection IN(SELECT connection FROM connection_sso WHERE tenant=$1 AND parent=$2) AND state IN ('queued','running')",
          [tenant, parent],
        );
      } else {
        if (
          (
            await sql.query("SELECT id FROM sso_contexts WHERE tenant=$1", [
              tenant,
            ])
          ).rows.length >= 20
        )
          throw new VaultError("CAPACITY", 409);
        await sql.query(
          "INSERT INTO sso_contexts(tenant,id,identity,runtime,secret) VALUES($1,$2,$3,$4,$5)",
          [
            tenant,
            parent,
            value.identity,
            value.runtimeId,
            JSON.stringify(secret),
          ],
        );
      }
      await this.vault.audit(
        sql,
        tenant,
        "owner",
        parentId ? "sso.reconnected" : "sso.created",
        parent,
      );
      return { id: parent };
    });
  }
  async disable(tenant: string, parent: string) {
    return this.vault.db.transaction(async (sql) => {
      await this.vault.lock(sql, tenant);
      const secret = await this.vault.cipher.seal(
        context(tenant, "sso", parent),
        { cookies: [], domains: [] },
      );
      requireValue(
        (
          await sql.query(
            "UPDATE sso_contexts SET enabled=false,secret=$3,version=version+1 WHERE tenant=$1 AND id=$2 RETURNING id",
            [tenant, parent, JSON.stringify(secret)],
          )
        ).rows[0],
      );
      await sql.query(
        "UPDATE connections SET version=version+1,maintenance=false WHERE tenant=$1 AND id IN(SELECT connection FROM connection_sso WHERE tenant=$1 AND parent=$2)",
        [tenant, parent],
      );
      await sql.query(
        "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND connection IN(SELECT connection FROM connection_sso WHERE tenant=$1 AND parent=$2) AND state IN ('queued','running')",
        [tenant, parent],
      );
      await this.vault.audit(sql, tenant, "owner", "sso.disabled", parent, {
        destinationCookiesMayRemain: true,
      });
      return { ok: true as const };
    });
  }
}
