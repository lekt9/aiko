import {
  browserLoginCommit,
  type BrowserLoginCommit,
  sessionWrite,
  type VaultCookie,
  type VaultSession,
  z,
} from "@unlock/protocol";
import {
  context,
  metadata,
  Vault,
  type ConnectionRow,
  type RuntimePrincipal,
} from "./vault.js";
import type { Envelope } from "./crypto.js";
import type { Sql } from "./db.js";
import { requireValue, VaultError } from "./errors.js";
import { SourceRegistry } from "./sources.js";
import {
  validateCookies,
  type AuthRecipe,
  type RecipeContext,
  type Verified,
} from "./recipes.js";
export type SessionRow = Record<string, unknown> & {
  secret: Envelope;
  revision: number;
  verified: boolean;
  expires_at: string;
  generation: number;
  status: string;
};
export const sessionKey = (p: RuntimePrincipal, connection: string) =>
  context(p.tenant, "session", `${connection}:${p.profile}:${p.client}`);
export class Runtime {
  constructor(
    public vault: Vault,
    public recipes: Map<string, AuthRecipe>,
    private sources: SourceRegistry,
    public runtimeId?: string,
  ) {}
  async stored(
    sql: Sql,
    p: RuntimePrincipal,
    connection: string,
    lock = false,
  ) {
    return (
      await sql.query<SessionRow>(
        `SELECT * FROM sessions WHERE tenant=$1 AND connection=$2 AND profile=$3 AND client=$4${lock ? " FOR UPDATE" : ""}`,
        [p.tenant, connection, p.profile, p.client],
      )
    ).rows[0];
  }
  async connections(p: RuntimePrincipal) {
    if (!p.scope.includes("sessions:read"))
      throw new VaultError("FORBIDDEN", 403);
    const rows = await this.vault.db.query<ConnectionRow>(
      `SELECT c.* FROM connections c JOIN assignments a ON a.tenant=c.tenant AND a.connection=c.id JOIN profiles p ON p.tenant=a.tenant AND p.id=a.profile JOIN clients cl ON cl.tenant=p.tenant AND cl.profile=p.id LEFT JOIN sources s ON s.tenant=c.tenant AND s.id=c.source_id WHERE c.tenant=$1 AND p.id=$2 AND cl.id=$3 AND p.enabled AND cl.enabled AND NOT c.deleted AND cl.connections ? c.id AND c.id=ANY($4::text[]) AND (c.source_id IS NULL OR (s.enabled AND s.refs ? c.source_ref)) ORDER BY c.name LIMIT 2000`,
      [p.tenant, p.profile, p.client, p.connections],
    );
    return rows.rows.map(metadata);
  }
  /** Metadata only: never decrypt session material for relay status checks. */
  async status(p: RuntimePrincipal, connection: string) {
    if (!p.scope.includes("sessions:read"))
      throw new VaultError("FORBIDDEN", 403);
    return this.vault.db.transaction(async (sql) => {
      const c = await this.vault.authorize(sql, p, connection, true);
      const session = await this.stored(sql, p, connection, true);
      const expiry = Number(session?.expires_at);
      const expiresAt = Number.isSafeInteger(expiry) && expiry > 0 ? expiry : 0;
      return {
        tenantId: p.tenant,
        profileId: p.profile,
        runtimeId: p.client,
        connectionId: connection,
        allowedDomains: c.domains,
        verified:
          !!session?.verified &&
          session.status === "ready" &&
          expiresAt > this.vault.now() &&
          session.generation === c.version,
        revision: session?.revision ?? 0,
        expiresAt,
        // Ordinary maintenance may create an initial session or refresh an expired ready jar.
        // Revoked/stale/failed rows require explicit owner recovery and are never auto-renewed.
        renewable:
          !session ||
          (session.status === "ready" &&
            session.generation === c.version &&
            expiresAt <= this.vault.now()),
      };
    });
  }
  /** Preserve a revision tombstone so in-flight publishers cannot recreate revoked access. */
  async revoke(p: RuntimePrincipal, connection: string) {
    if (!p.scope.includes("sessions:write"))
      throw new VaultError("FORBIDDEN", 403);
    return this.vault.db.transaction(async (sql) => {
      const c = await this.vault.authorize(sql, p, connection, true);
      const session = await this.stored(sql, p, connection, true);
      const secret = await this.vault.cipher.seal(sessionKey(p, connection), {
        cookies: [],
      });
      await sql.query(
        "INSERT INTO sessions(tenant,connection,profile,client,revision,secret,verified,expires_at,generation,status) VALUES($1,$2,$3,$4,$5,$6,false,$7,$8,'revoked') ON CONFLICT(tenant,connection,profile,client) DO UPDATE SET revision=EXCLUDED.revision,secret=EXCLUDED.secret,verified=false,expires_at=EXCLUDED.expires_at,status='revoked'",
        [
          p.tenant,
          connection,
          p.profile,
          p.client,
          (session?.revision ?? 0) + 1,
          JSON.stringify(secret),
          this.vault.now(),
          c.version,
        ],
      );
      await sql.query(
        "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND connection=$2 AND profile=$3 AND client=$4 AND state IN ('queued','running')",
        [p.tenant, connection, p.profile, p.client],
      );
      await this.vault.audit(
        sql,
        p.tenant,
        p.client,
        "session.revoked",
        connection,
        { profile: p.profile, client: p.client },
      );
    });
  }
  async retrieve(
    p: RuntimePrincipal,
    connection: string,
  ): Promise<VaultSession> {
    if (!p.scope.includes("sessions:read"))
      throw new VaultError("FORBIDDEN", 403);
    return this.vault.db.transaction(async (sql) => {
      const c = await this.vault.authorize(sql, p, connection, true),
        s = await this.stored(sql, p, connection, true);
      if (
        !s?.verified ||
        s.status !== "ready" ||
        s.generation !== c.version ||
        Number(s.expires_at) <= this.vault.now()
      )
        throw new VaultError("REAUTH_REQUIRED", 409);
      const material = await this.vault.cipher.open<{ cookies: VaultCookie[] }>(
          sessionKey(p, connection),
          s.secret,
        ),
        cookies = validateCookies(material.cookies, c.domains);
      await this.vault.audit(
        sql,
        p.tenant,
        p.client,
        "session.retrieved",
        connection,
        { revision: s.revision },
      );
      return {
        connectionId: connection,
        profileId: p.profile,
        runtimeId: p.client,
        revision: s.revision,
        allowedDomains: c.domains,
        expiresAt: Number(s.expires_at),
        cookies,
      };
    });
  }
  async recipeContext(
    p: RuntimePrincipal,
    c: ConnectionRow,
    cookies: VaultCookie[],
    signal: AbortSignal,
    fence?: (sql: Sql) => Promise<void>,
  ): Promise<RecipeContext> {
    return {
      identity: c.identity,
      website: c.website,
      domains: c.domains,
      cookies,
      signal,
      password: async () => {
        if (c.secret)
          return (
            await this.vault.cipher.open<{ password: string }>(
              context(p.tenant, "credential", c.id),
              c.secret,
            )
          ).password;
        if (!c.source_id) return undefined;
        const s = requireValue(
          (
            await this.vault.db.query<{
              kind: string;
              secret: Envelope;
              refs: string[];
            }>(
              "SELECT kind,secret,refs FROM sources WHERE tenant=$1 AND id=$2 AND enabled",
              [p.tenant, c.source_id],
            )
          ).rows[0],
          "SOURCE_UNAVAILABLE",
        );
        if (!c.source_ref || !s.refs.includes(c.source_ref))
          throw new VaultError("FORBIDDEN", 403);
        const { token } = await this.vault.cipher.open<{ token: string }>(
          context(p.tenant, "source", c.source_id),
          s.secret,
        );
        return this.sources.resolve(s.kind, token, c.source_ref);
      },
      sso: async () => {
        const parent = (
          await this.vault.db.query<{
            id: string;
            identity: string;
            runtime: string;
            secret: Envelope;
            version: number;
          }>(
            "SELECT s.* FROM sso_contexts s JOIN connection_sso l ON l.tenant=s.tenant AND l.parent=s.id WHERE l.tenant=$1 AND l.connection=$2 AND s.enabled",
            [p.tenant, c.id],
          )
        ).rows[0];
        if (!parent) return undefined;
        if (parent.runtime !== this.runtimeId)
          throw new VaultError("RUNTIME_UNAVAILABLE", 409);
        const material = await this.vault.cipher.open<{
          cookies: VaultCookie[];
          domains: string[];
        }>(context(p.tenant, "sso", parent.id), parent.secret);
        let revision = parent.version;
        return {
          identity: parent.identity,
          ...material,
          revision,
          checkpoint: async (cookies: VaultCookie[]) =>
            this.vault.db.transaction(async (sql) => {
              const current = await this.vault.authorize(sql, p, c.id, true);
              if (current.version !== c.version)
                throw new VaultError("CONFLICT", 409);
              await fence?.(sql);
              const secret = await this.vault.cipher.seal(
                context(p.tenant, "sso", parent.id),
                {
                  ...material,
                  cookies: validateCookies(cookies, material.domains),
                },
              );
              if (signal.aborted) throw new VaultError("UNAVAILABLE", 503);
              const saved = await sql.query(
                "UPDATE sso_contexts SET secret=$4,version=version+1 WHERE tenant=$1 AND id=$2 AND version=$3 AND enabled RETURNING version",
                [p.tenant, parent.id, revision, JSON.stringify(secret)],
              );
              if (!saved.rows.length) throw new VaultError("CONFLICT", 409);
              revision++;
              return { revision };
            }),
        };
      },
    };
  }
  async verify(
    p: RuntimePrincipal,
    c: ConnectionRow,
    cookies: VaultCookie[],
    renew = false,
    fence?: (sql: Sql) => Promise<void>,
  ): Promise<Verified> {
    const recipe = c.recipe ? this.recipes.get(c.recipe) : undefined;
    if (!recipe) throw new VaultError("UNSUPPORTED_PROVIDER", 409);
    if (recipe.runtimeId && recipe.runtimeId !== this.runtimeId)
      throw new VaultError("RUNTIME_UNAVAILABLE", 409);
    const ctx = await this.recipeContext(
      p,
      c,
      validateCookies(cookies, c.domains),
      AbortSignal.timeout(25_000),
      fence,
    );
    let verified: Verified,
      abort: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      abort = () => reject(new VaultError("UNAVAILABLE", 503));
      ctx.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      verified = await Promise.race([
        renew ? recipe.renew(ctx) : recipe.verify(ctx),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("UNAVAILABLE", 503);
    } finally {
      ctx.signal.removeEventListener("abort", abort);
    }
    if (
      verified.identity !== c.identity ||
      !Number.isFinite(verified.expiresAt) ||
      verified.expiresAt <= this.vault.now() ||
      verified.expiresAt > this.vault.now() + 30 * 86400_000
    )
      throw new VaultError("REAUTH_REQUIRED", 409);
    verified.cookies = validateCookies(verified.cookies, c.domains);
    if (!verified.cookies.length) throw new VaultError("REAUTH_REQUIRED", 409);
    return verified;
  }
  async publish(
    sql: Sql,
    p: RuntimePrincipal,
    c: ConnectionRow,
    value: Verified,
    expectedRevision: number | null,
  ) {
    const current = await this.vault.authorize(sql, p, c.id, true);
    if (current.version !== c.version) throw new VaultError("CONFLICT", 409);
    const previous = await this.stored(sql, p, c.id, true);
    if ((previous?.revision ?? null) !== expectedRevision)
      throw new VaultError("CONFLICT", 409);
    const revision = (previous?.revision ?? 0) + 1,
      secret = await this.vault.cipher.seal(sessionKey(p, c.id), {
        cookies: validateCookies(value.cookies, c.domains),
      });
    await sql.query(
      "INSERT INTO sessions(tenant,connection,profile,client,revision,secret,verified,expires_at,generation,status) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,'ready') ON CONFLICT(tenant,connection,profile,client) DO UPDATE SET revision=EXCLUDED.revision,secret=EXCLUDED.secret,verified=true,expires_at=EXCLUDED.expires_at,generation=EXCLUDED.generation,status='ready'",
      [
        p.tenant,
        c.id,
        p.profile,
        p.client,
        revision,
        JSON.stringify(secret),
        value.expiresAt,
        c.version,
      ],
    );
    await this.vault.audit(sql, p.tenant, p.client, "session.published", c.id, {
      revision,
    });
    return { revision, expiresAt: value.expiresAt };
  }
  async sync(p: RuntimePrincipal, connection: string, body: unknown) {
    if (!p.scope.includes("sessions:write"))
      throw new VaultError("FORBIDDEN", 403);
    const input = sessionWrite.parse(body);
    const snapshot = await this.vault.db.transaction(async (sql) => {
      const c = await this.vault.authorize(sql, p, connection, true),
        s = await this.stored(sql, p, connection, true);
      if (!s || s.revision !== input.revision)
        throw new VaultError("CONFLICT", 409);
      const version = (
        await sql.query<{ version: number }>(
          "SELECT version FROM profiles WHERE tenant=$1 AND id=$2",
          [p.tenant, p.profile],
        )
      ).rows[0].version;
      return { c, version };
    });
    if (input.cookies.length === 0)
      return this.vault.db.transaction(async (sql) => {
        const c = await this.vault.authorize(sql, p, connection, true),
          s = await this.stored(sql, p, connection, true);
        if (c.version !== snapshot.c.version || s?.revision !== input.revision)
          throw new VaultError("CONFLICT", 409);
        const secret = await this.vault.cipher.seal(sessionKey(p, connection), {
            cookies: [],
          }),
          revision = s.revision + 1;
        await sql.query(
          "UPDATE sessions SET secret=$5,verified=false,expires_at=$6,revision=$7,status='signed_out' WHERE tenant=$1 AND connection=$2 AND profile=$3 AND client=$4",
          [
            p.tenant,
            connection,
            p.profile,
            p.client,
            JSON.stringify(secret),
            this.vault.now(),
            revision,
          ],
        );
        await sql.query(
          "UPDATE connections SET maintenance=false,version=version+1 WHERE tenant=$1 AND id=$2",
          [p.tenant, connection],
        );
        await sql.query(
          "UPDATE jobs SET state='cancelled',claim=NULL WHERE tenant=$1 AND connection=$2 AND state IN ('queued','running')",
          [p.tenant, connection],
        );
        await this.vault.audit(
          sql,
          p.tenant,
          p.client,
          "session.signed_out",
          connection,
        );
        return { revision, expiresAt: this.vault.now() };
      });
    const checked = await this.verify(p, snapshot.c, input.cookies);
    return this.vault.db.transaction(async (sql) => {
      await this.vault.lock(sql, p.tenant);
      const version = (
        await sql.query<{ version: number }>(
          "SELECT version FROM profiles WHERE tenant=$1 AND id=$2 FOR SHARE",
          [p.tenant, p.profile],
        )
      ).rows[0]?.version;
      if (version !== snapshot.version) throw new VaultError("CONFLICT", 409);
      return this.publish(sql, p, snapshot.c, checked, input.revision);
    });
  }
  async importSession(tenant: string, connection: string, body: unknown) {
    const input = z
      .object({
        profileId: z.string().uuid(),
        runtimeId: z.string().uuid(),
        cookies: z.unknown(),
      })
      .strict()
      .parse(body);
    return this.importVerifiedSession(tenant, connection, input);
  }
  /** Owner-authorized only: runtime bearer tokens cannot write passwords. */
  async completeBrowserLogin(
    tenant: string,
    connection: string,
    body: unknown,
  ) {
    const input = browserLoginCommit.parse(body);
    return this.importVerifiedSession(tenant, connection, input, input);
  }
  private async importVerifiedSession(
    tenant: string,
    connection: string,
    input: { profileId: string; runtimeId: string; cookies?: unknown },
    login?: BrowserLoginCommit,
  ) {
    const client = requireValue(
      (
        await this.vault.db.query<{ profile: string; connections: string[] }>(
          "SELECT profile,connections FROM clients WHERE tenant=$1 AND id=$2 AND enabled",
          [tenant, input.runtimeId],
        )
      ).rows[0],
    );
    if (client.profile !== input.profileId)
      throw new VaultError("FORBIDDEN", 403);
    const p: RuntimePrincipal = {
      tenant,
      profile: input.profileId,
      client: input.runtimeId,
      connections: client.connections,
      scope: ["sessions:write"],
    };
    const snapshot = await this.vault.db.transaction(async (sql) => {
      await this.vault.lock(sql, tenant);
      const c = await this.vault.authorize(sql, p, connection, true);
      if (
        login &&
        (c.version !== login.version || c.identity !== login.identity)
      )
        throw new VaultError("CONFLICT", 409);
      if (login && c.source_id) throw new VaultError("FORBIDDEN", 403);
      const previous = await this.stored(sql, p, connection);
      const profile = requireValue(
        (
          await sql.query<{ version: number }>(
            "SELECT version FROM profiles WHERE tenant=$1 AND id=$2",
            [tenant, p.profile],
          )
        ).rows[0],
      );
      return { c, previous, profileVersion: profile.version };
    });
    const { c, previous } = snapshot;
    const checked = await this.verify(
      p,
      c,
      validateCookies(input.cookies, c.domains),
    );
    return this.vault.db.transaction(async (sql) => {
      await this.vault.lock(sql, tenant);
      // Reauthorize after the network verification; never resurrect revoked assignments.
      await this.vault.authorize(sql, p, connection, true);
      const profile = requireValue(
        (
          await sql.query<{ version: number }>(
            "SELECT version FROM profiles WHERE tenant=$1 AND id=$2 FOR SHARE",
            [tenant, p.profile],
          )
        ).rows[0],
      );
      if (
        profile.version !== snapshot.profileVersion ||
        checked.expiresAt <= this.vault.now()
      )
        throw new VaultError("CONFLICT", 409);
      let version = c.version;
      if (login) {
        await this.vault.setPasswordInTransaction(
          sql,
          tenant,
          connection,
          login.credential.password,
          version,
        );
        version++;
      }
      const result = await this.publish(
        sql,
        p,
        { ...c, version },
        checked,
        previous?.revision ?? null,
      );
      return login ? { ...result, version } : result;
    });
  }
}
