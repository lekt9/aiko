import { randomUUID } from "node:crypto";
import {
  connectionCreate,
  connectionMetadata,
  id,
  label,
  profileInput,
  sourceInput,
  z,
  type VaultConnection,
} from "@unlock/protocol";
import type { Database, Sql } from "./db.js";
import { VaultCipher, type Envelope } from "./crypto.js";
import { requireValue, VaultError } from "./errors.js";
export type ConnectionRow = Record<string, unknown> & {
  tenant: string;
  id: string;
  name: string;
  identity: string;
  website: string;
  domains: string[];
  secret: Envelope | null;
  source_id: string | null;
  source_ref: string | null;
  recipe: string | null;
  maintenance: boolean;
  version: number;
  deleted: boolean;
};
export type RuntimePrincipal = {
  tenant: string;
  profile: string;
  client: string;
  scope: string[];
  connections: string[];
};
export const context = (tenant: string, kind: string, id: string) =>
  `unlock:v1:${tenant}:${kind}:${id}`;
export const metadata = (c: ConnectionRow): VaultConnection =>
  connectionMetadata.parse({
    id: c.id,
    name: c.name,
    identity: c.identity,
    website: c.website,
    domains: c.domains,
    recipeId: c.recipe,
    maintenance: c.maintenance,
    version: c.version,
    sourceId: c.source_id,
    sourceReference: c.source_ref,
    hasPassword: !!c.secret,
    deleted: c.deleted,
  });
export class Vault {
  constructor(
    public db: Database,
    public cipher: VaultCipher,
    public now: () => number = Date.now,
  ) {}
  async audit(
    sql: Sql,
    tenant: string,
    actor: string,
    action: string,
    target: string,
    detail: Record<string, string | number | boolean> = {},
  ) {
    await sql.query(
      "INSERT INTO audit(id,tenant,at,actor,action,target,detail) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        tenant,
        this.now(),
        actor,
        action,
        target,
        JSON.stringify(detail),
      ],
    );
  }
  async owner(issuer: string, subject: string) {
    const result = await this.db.query<{ id: string }>(
      "INSERT INTO vaults(id,issuer,subject,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject) DO UPDATE SET issuer=EXCLUDED.issuer RETURNING id",
      [randomUUID(), issuer, subject, this.now()],
    );
    return result.rows[0].id;
  }
  async lock(sql: Sql, tenant: string) {
    requireValue(
      (
        await sql.query("SELECT id FROM vaults WHERE id=$1 FOR UPDATE", [
          tenant,
        ])
      ).rows[0],
    );
  }
  async connection(sql: Sql, tenant: string, connection: string, lock = false) {
    if (lock) await this.lock(sql, tenant);
    return requireValue(
      (
        await sql.query<ConnectionRow>(
          `SELECT * FROM connections WHERE tenant=$1 AND id=$2 AND deleted=false${lock ? " FOR UPDATE" : ""}`,
          [tenant, connection],
        )
      ).rows[0],
    );
  }
  async authorize(
    sql: Sql,
    p: RuntimePrincipal,
    connection: string,
    lock = false,
  ) {
    const c = await this.connection(sql, p.tenant, connection, lock);
    const allowed = await sql.query(
      `SELECT 1 FROM assignments a JOIN profiles p ON p.tenant=a.tenant AND p.id=a.profile JOIN clients cl ON cl.tenant=p.tenant AND cl.profile=p.id WHERE a.tenant=$1 AND a.connection=$2 AND a.profile=$3 AND cl.id=$4 AND p.enabled AND cl.enabled AND cl.connections ? $2`,
      [p.tenant, connection, p.profile, p.client],
    );
    if (!allowed.rows.length || !p.connections.includes(connection))
      throw new VaultError("FORBIDDEN", 403);
    if (c.source_id) {
      const source = await sql.query(
        "SELECT 1 FROM sources WHERE tenant=$1 AND id=$2 AND enabled AND refs ? $3",
        [p.tenant, c.source_id, c.source_ref],
      );
      if (!source.rows.length) throw new VaultError("SOURCE_UNAVAILABLE", 409);
    }
    return c;
  }
  async list(tenant: string) {
    return (
      await this.db.query<ConnectionRow>(
        "SELECT * FROM connections WHERE tenant=$1 AND NOT deleted ORDER BY created_at DESC LIMIT 2000",
        [tenant],
      )
    ).rows.map(metadata);
  }
  async add(tenant: string, body: unknown, sql?: Sql) {
    const value = connectionCreate.parse(body),
      connectionId = randomUUID();
    const work = async (tx: Sql) => {
      await tx.query("SELECT id FROM vaults WHERE id=$1 FOR UPDATE", [tenant]);
      const count = await tx.query<{ count: string }>(
        "SELECT count(*) FROM connections WHERE tenant=$1 AND NOT deleted",
        [tenant],
      );
      if (Number(count.rows[0].count) >= 2000)
        throw new VaultError("CAPACITY", 409);
      if (value.sourceId) {
        const source = requireValue(
          (
            await tx.query<{ refs: string[] }>(
              "SELECT refs FROM sources WHERE tenant=$1 AND id=$2 AND enabled",
              [tenant, value.sourceId],
            )
          ).rows[0],
        );
        if (!source.refs.includes(value.sourceReference!))
          throw new VaultError("FORBIDDEN", 403);
      }
      if (value.ssoContextId) {
        const parent = requireValue(
          (
            await tx.query<{ secret: Envelope }>(
              "SELECT secret FROM sso_contexts WHERE tenant=$1 AND id=$2 AND enabled",
              [tenant, value.ssoContextId],
            )
          ).rows[0],
        );
        const material = await this.cipher.open<{ domains: string[] }>(
          context(tenant, "sso", value.ssoContextId),
          parent.secret,
        );
        if (value.domains.some((d) => material.domains.includes(d)))
          throw new VaultError("FORBIDDEN", 403);
      }
      const secret = value.credential
        ? await this.cipher.seal(
            context(tenant, "credential", connectionId),
            value.credential,
          )
        : null;
      const result = await tx.query<ConnectionRow>(
        "INSERT INTO connections(tenant,id,name,identity,website,domains,secret,source_id,source_ref,recipe,maintenance,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
        [
          tenant,
          connectionId,
          value.name,
          value.identity,
          value.website,
          JSON.stringify(value.domains),
          secret ? JSON.stringify(secret) : null,
          value.sourceId ?? null,
          value.sourceReference ?? null,
          value.recipeId ?? null,
          value.maintenance,
          this.now(),
        ],
      );
      if (value.ssoContextId)
        await tx.query(
          "INSERT INTO connection_sso(tenant,connection,parent) VALUES($1,$2,$3)",
          [tenant, connectionId, value.ssoContextId],
        );
      await this.audit(
        tx,
        tenant,
        "owner",
        "connection.created",
        connectionId,
        { hasCredential: !!secret, external: !!value.sourceId },
      );
      return metadata(result.rows[0]);
    };
    return sql ? work(sql) : this.db.transaction(work);
  }
  async update(tenant: string, connectionId: string, body: unknown) {
    const input = z
      .object({
        version: z.number().int(),
        name: label.optional(),
        maintenance: z.boolean().optional(),
        recipeId: label.nullable().optional(),
      })
      .strict()
      .parse(body);
    return this.db.transaction(async (sql) => {
      const c = await this.connection(sql, tenant, connectionId, true);
      if (c.version !== input.version) throw new VaultError("CONFLICT", 409);
      const row = (
        await sql.query<ConnectionRow>(
          "UPDATE connections SET name=$3,maintenance=$4,recipe=$5,version=version+1 WHERE tenant=$1 AND id=$2 RETURNING *",
          [
            tenant,
            connectionId,
            input.name ?? c.name,
            input.maintenance ?? c.maintenance,
            input.recipeId === undefined ? c.recipe : input.recipeId,
          ],
        )
      ).rows[0];
      await sql.query(
        "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND connection=$2 AND state IN ('queued','running')",
        [tenant, connectionId],
      );
      await this.audit(
        sql,
        tenant,
        "owner",
        "connection.updated",
        connectionId,
      );
      return metadata(row);
    });
  }
  async setPassword(
    tenant: string,
    connectionId: string,
    password: string,
    version: number,
  ) {
    return this.db.transaction((sql) =>
      this.setPasswordInTransaction(
        sql,
        tenant,
        connectionId,
        password,
        version,
      ),
    );
  }
  /** Trusted owner operations only. Allows a verified session and credential to commit together. */
  async setPasswordInTransaction(
    sql: Sql,
    tenant: string,
    connectionId: string,
    password: string,
    version: number,
  ) {
    const value = z.string().min(1).max(16384).parse(password);
    const c = await this.connection(sql, tenant, connectionId, true);
    if (c.source_id) throw new VaultError("FORBIDDEN", 403);
    if (c.version !== version) throw new VaultError("CONFLICT", 409);
    const secret = await this.cipher.seal(
      context(tenant, "credential", connectionId),
      { password: value },
    );
    await sql.query(
      "UPDATE connections SET secret=$3,version=version+1 WHERE tenant=$1 AND id=$2",
      [tenant, connectionId, JSON.stringify(secret)],
    );
    await sql.query(
      "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND connection=$2 AND state IN ('queued','running')",
      [tenant, connectionId],
    );
    await this.audit(sql, tenant, "owner", "credential.updated", connectionId);
    return { ok: true as const };
  }
  async reveal(tenant: string, connectionId: string) {
    return this.db.transaction(async (sql) => {
      const c = await this.connection(sql, tenant, connectionId, true);
      if (!c.secret) throw new VaultError("NOT_FOUND", 404);
      const value = await this.cipher.open<{ password: string }>(
        context(tenant, "credential", connectionId),
        c.secret,
      );
      await this.audit(
        sql,
        tenant,
        "owner",
        "credential.revealed",
        connectionId,
      );
      return value;
    });
  }
  async remove(tenant: string, connectionId: string) {
    return this.db.transaction(async (sql) => {
      await this.connection(sql, tenant, connectionId, true);
      await sql.query(
        "UPDATE connections SET deleted=true,secret=NULL,maintenance=false,version=version+1 WHERE tenant=$1 AND id=$2",
        [tenant, connectionId],
      );
      await sql.query(
        "DELETE FROM sessions WHERE tenant=$1 AND connection=$2",
        [tenant, connectionId],
      );
      await sql.query(
        "DELETE FROM assignments WHERE tenant=$1 AND connection=$2",
        [tenant, connectionId],
      );
      await sql.query("DELETE FROM jobs WHERE tenant=$1 AND connection=$2", [
        tenant,
        connectionId,
      ]);
      await this.audit(
        sql,
        tenant,
        "owner",
        "connection.deleted",
        connectionId,
        { deliveredCookiesMayRemain: true },
      );
      return { ok: true as const };
    });
  }
  async profiles(tenant: string) {
    const rows = await this.db.query<{
      id: string;
      name: string;
      enabled: boolean;
      version: number;
      connection_ids: string[];
    }>(
      "SELECT p.*,COALESCE((SELECT jsonb_agg(a.connection) FROM assignments a WHERE a.tenant=p.tenant AND a.profile=p.id),'[]'::jsonb) AS connection_ids FROM profiles p WHERE tenant=$1 ORDER BY name",
      [tenant],
    );
    return rows.rows.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      version: p.version,
      connectionIds: p.connection_ids,
    }));
  }
  async saveProfile(tenant: string, body: unknown, profileId?: string) {
    const value = profileInput.parse(body);
    return this.db.transaction(async (sql) => {
      await sql.query("SELECT id FROM vaults WHERE id=$1 FOR UPDATE", [tenant]);
      if (profileId) {
        requireValue(
          (
            await sql.query(
              "UPDATE profiles SET name=$3,enabled=COALESCE($4,enabled),version=version+1 WHERE tenant=$1 AND id=$2 RETURNING id",
              [tenant, profileId, value.name, value.enabled ?? null],
            )
          ).rows[0],
        );
        await sql.query(
          "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND profile=$2 AND state IN ('queued','running')",
          [tenant, profileId],
        );
      } else {
        if (
          (await sql.query("SELECT id FROM profiles WHERE tenant=$1", [tenant]))
            .rows.length >= 100
        )
          throw new VaultError("CAPACITY", 409);
        profileId = randomUUID();
        await sql.query(
          "INSERT INTO profiles(tenant,id,name,enabled) VALUES($1,$2,$3,$4)",
          [tenant, profileId, value.name, value.enabled ?? true],
        );
      }
      await this.audit(sql, tenant, "owner", "profile.saved", profileId);
      return { id: profileId };
    });
  }
  async assign(tenant: string, profileId: string, connectionIds: string[]) {
    const selected = z.array(id).max(2000).parse(connectionIds);
    return this.db.transaction(async (sql) => {
      await this.lock(sql, tenant);
      requireValue(
        (
          await sql.query(
            "SELECT id FROM profiles WHERE tenant=$1 AND id=$2 FOR UPDATE",
            [tenant, profileId],
          )
        ).rows[0],
      );
      for (const connection of selected)
        await this.connection(sql, tenant, connection);
      await sql.query(
        "DELETE FROM assignments WHERE tenant=$1 AND profile=$2",
        [tenant, profileId],
      );
      for (const c of new Set(selected))
        await sql.query(
          "INSERT INTO assignments(tenant,profile,connection) VALUES($1,$2,$3)",
          [tenant, profileId, c],
        );
      await sql.query(
        "UPDATE profiles SET version=version+1 WHERE tenant=$1 AND id=$2",
        [tenant, profileId],
      );
      await sql.query(
        "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND profile=$2 AND state IN ('queued','running')",
        [tenant, profileId],
      );
      await this.audit(sql, tenant, "owner", "profile.assignments", profileId, {
        count: selected.length,
      });
      return { ok: true as const };
    });
  }
  async sources(tenant: string) {
    return (
      await this.db.query<{
        id: string;
        name: string;
        kind: string;
        enabled: boolean;
        version: number;
        refs: string[];
      }>(
        "SELECT id,name,kind,enabled,version,refs FROM sources WHERE tenant=$1",
        [tenant],
      )
    ).rows.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      enabled: s.enabled,
      version: s.version,
      references: s.refs,
    }));
  }
  async addSource(tenant: string, body: unknown) {
    const value = sourceInput.parse(body),
      sourceId = randomUUID(),
      secret = await this.cipher.seal(context(tenant, "source", sourceId), {
        token: value.token,
      });
    return this.db.transaction(async (sql) => {
      await sql.query("SELECT id FROM vaults WHERE id=$1 FOR UPDATE", [tenant]);
      if (
        (await sql.query("SELECT id FROM sources WHERE tenant=$1", [tenant]))
          .rows.length >= 100
      )
        throw new VaultError("CAPACITY", 409);
      await sql.query(
        "INSERT INTO sources(tenant,id,name,kind,secret,refs) VALUES($1,$2,$3,$4,$5,$6)",
        [
          tenant,
          sourceId,
          value.name,
          value.kind,
          JSON.stringify(secret),
          JSON.stringify(value.references),
        ],
      );
      await this.audit(sql, tenant, "owner", "source.created", sourceId);
      return { id: sourceId };
    });
  }
  async disconnectSource(tenant: string, sourceId: string) {
    return this.db.transaction(async (sql) => {
      await this.lock(sql, tenant);
      const secret = await this.cipher.seal(
        context(tenant, "source", sourceId),
        { token: "" },
      );
      requireValue(
        (
          await sql.query(
            "UPDATE sources SET enabled=false,secret=$3,version=version+1 WHERE tenant=$1 AND id=$2 RETURNING id",
            [tenant, sourceId, JSON.stringify(secret)],
          )
        ).rows[0],
      );
      await sql.query(
        "UPDATE connections SET maintenance=false,version=version+1 WHERE tenant=$1 AND source_id=$2",
        [tenant, sourceId],
      );
      await sql.query(
        "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND connection IN (SELECT id FROM connections WHERE tenant=$1 AND source_id=$2) AND state IN ('queued','running')",
        [tenant, sourceId],
      );
      await this.audit(sql, tenant, "owner", "source.disconnected", sourceId, {
        deliveredCookiesMayRemain: true,
      });
      return { ok: true as const };
    });
  }
  async clients(tenant: string) {
    return (
      await this.db.query<{
        id: string;
        name: string;
        profile: string;
        redirects: string[];
        connections: string[];
        enabled: boolean;
      }>(
        "SELECT id,name,profile,redirects,connections,enabled FROM clients WHERE tenant=$1",
        [tenant],
      )
    ).rows.map((c) => ({
      id: c.id,
      name: c.name,
      profileId: c.profile,
      redirectUris: c.redirects,
      connectionIds: c.connections,
      enabled: c.enabled,
    }));
  }
  async createClient(tenant: string, body: unknown) {
    const value = z
      .object({
        name: label,
        profileId: id,
        connectionIds: z.array(id).min(1).max(2000),
        redirectUris: z.array(z.url()).min(1).max(5),
      })
      .strict()
      .parse(body);
    for (const uri of value.redirectUris) {
      const u = new URL(uri);
      if (
        u.hash ||
        u.username ||
        u.password ||
        u.search ||
        !(
          u.protocol === "https:" ||
          (u.protocol === "http:" && u.hostname === "127.0.0.1")
        )
      )
        throw new VaultError("INVALID_INPUT");
    }
    return this.db.transaction(async (sql) => {
      await this.lock(sql, tenant);
      requireValue(
        (
          await sql.query(
            "SELECT id FROM profiles WHERE tenant=$1 AND id=$2 AND enabled FOR UPDATE",
            [tenant, value.profileId],
          )
        ).rows[0],
      );
      for (const connection of value.connectionIds) {
        requireValue(
          (
            await sql.query(
              "SELECT connection FROM assignments WHERE tenant=$1 AND profile=$2 AND connection=$3",
              [tenant, value.profileId, connection],
            )
          ).rows[0],
        );
      }
      if (
        (await sql.query("SELECT id FROM clients WHERE tenant=$1", [tenant]))
          .rows.length >= 100
      )
        throw new VaultError("CAPACITY", 409);
      const clientId = randomUUID();
      await sql.query(
        "INSERT INTO clients(tenant,id,profile,name,redirects,connections) VALUES($1,$2,$3,$4,$5,$6)",
        [
          tenant,
          clientId,
          value.profileId,
          value.name,
          JSON.stringify(value.redirectUris),
          JSON.stringify([...new Set(value.connectionIds)]),
        ],
      );
      await this.audit(sql, tenant, "owner", "client.created", clientId);
      return { id: clientId };
    });
  }
  async revokeClient(tenant: string, clientId: string) {
    return this.db.transaction(async (sql) => {
      await this.lock(sql, tenant);
      requireValue(
        (
          await sql.query(
            "UPDATE clients SET enabled=false WHERE tenant=$1 AND id=$2 RETURNING id",
            [tenant, clientId],
          )
        ).rows[0],
      );
      await sql.query(
        "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND client=$2 AND state IN ('queued','running')",
        [tenant, clientId],
      );
      await this.audit(sql, tenant, "owner", "client.revoked", clientId);
      return { ok: true as const };
    });
  }
  async reconnectSource(tenant: string, sourceId: string, body: unknown) {
    const input = sourceInput.parse(body);
    return this.db.transaction(async (sql) => {
      await this.lock(sql, tenant);
      requireValue(
        (
          await sql.query("SELECT id FROM sources WHERE tenant=$1 AND id=$2", [
            tenant,
            sourceId,
          ])
        ).rows[0],
      );
      const secret = await this.cipher.seal(
        context(tenant, "source", sourceId),
        { token: input.token },
      );
      await sql.query(
        "UPDATE sources SET name=$3,secret=$4,refs=$5,enabled=true,version=version+1 WHERE tenant=$1 AND id=$2",
        [
          tenant,
          sourceId,
          input.name,
          JSON.stringify(secret),
          JSON.stringify(input.references),
        ],
      );
      await sql.query(
        "UPDATE connections SET version=version+1 WHERE tenant=$1 AND source_id=$2",
        [tenant, sourceId],
      );
      await sql.query(
        "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND connection IN(SELECT id FROM connections WHERE tenant=$1 AND source_id=$2) AND state IN ('queued','running')",
        [tenant, sourceId],
      );
      await this.audit(sql, tenant, "owner", "source.reconnected", sourceId);
      return { ok: true as const };
    });
  }
  async updateClient(tenant: string, clientId: string, body: unknown) {
    const input = z
      .object({ connectionIds: z.array(id).max(2000) })
      .strict()
      .parse(body);
    return this.db.transaction(async (sql) => {
      await this.lock(sql, tenant);
      const c = requireValue(
        (
          await sql.query<{ profile: string }>(
            "SELECT profile FROM clients WHERE tenant=$1 AND id=$2 AND enabled",
            [tenant, clientId],
          )
        ).rows[0],
      );
      for (const connection of input.connectionIds)
        requireValue(
          (
            await sql.query(
              "SELECT connection FROM assignments WHERE tenant=$1 AND profile=$2 AND connection=$3",
              [tenant, c.profile, connection],
            )
          ).rows[0],
        );
      await sql.query(
        "UPDATE clients SET connections=$3 WHERE tenant=$1 AND id=$2",
        [tenant, clientId, JSON.stringify([...new Set(input.connectionIds)])],
      );
      await sql.query(
        "UPDATE profiles SET version=version+1 WHERE tenant=$1 AND id=$2",
        [tenant, c.profile],
      );
      await sql.query(
        "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND client=$2 AND state IN ('queued','running')",
        [tenant, clientId],
      );
      await this.audit(sql, tenant, "owner", "client.access", clientId, {
        count: input.connectionIds.length,
      });
      return { ok: true as const };
    });
  }
  async events(tenant: string) {
    return (
      await this.db.query<{
        id: string;
        at: string;
        actor: string;
        action: string;
        target: string;
        detail: Record<string, string | number | boolean>;
      }>(
        "SELECT id,at,actor,action,target,detail FROM audit WHERE tenant=$1 ORDER BY at DESC LIMIT 250",
        [tenant],
      )
    ).rows.map((e) => ({ ...e, at: Number(e.at) }));
  }
}
