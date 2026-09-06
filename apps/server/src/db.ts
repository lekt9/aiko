import pg from "pg";
export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function postgres(url: string): Database {
  const parsed = new URL(url),
    host = parsed.hostname;
  if (
    [...parsed.searchParams.keys()].some((key) =>
      key.toLowerCase().startsWith("ssl"),
    )
  )
    throw new Error(
      "Configure verified PostgreSQL TLS through the system CA trust, not URL SSL overrides.",
    );
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    statement_timeout: 15_000,
    connectionTimeoutMillis: 10_000,
    ssl: ["localhost", "127.0.0.1", "[::1]"].includes(host)
      ? false
      : { rejectUnauthorized: true },
  });
  pool.on("error", () => {
    /* Request/worker health reflects failures; never log connection strings. */
  });
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
export async function migrate(db: Database) {
  await db.transaction(async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(819731)");
    await sql.query(
      "CREATE TABLE IF NOT EXISTS unlock_schema(version integer PRIMARY KEY)",
    );
    const version = (
      await sql.query<{ version: number | null }>(
        "SELECT max(version) AS version FROM unlock_schema",
      )
    ).rows[0].version;
    if (version !== null && version !== 1)
      throw new Error("Unsupported database schema version");
    if (version === 1) return;
    await sql.query(`
      CREATE TABLE IF NOT EXISTS unlock_schema(version integer PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS vaults(id text PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL, created_at bigint NOT NULL, UNIQUE(issuer,subject));
      CREATE TABLE IF NOT EXISTS profiles(tenant text NOT NULL REFERENCES vaults(id), id text NOT NULL, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS sources(tenant text NOT NULL REFERENCES vaults(id), id text NOT NULL, name text NOT NULL, kind text NOT NULL, enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, secret jsonb NOT NULL, refs jsonb NOT NULL, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS connections(tenant text NOT NULL REFERENCES vaults(id), id text NOT NULL, name text NOT NULL, identity text NOT NULL, domains jsonb NOT NULL, website text NOT NULL, secret jsonb, source_id text, source_ref text, recipe text, maintenance boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false, created_at bigint NOT NULL, PRIMARY KEY(tenant,id), FOREIGN KEY(tenant,source_id) REFERENCES sources(tenant,id));
      CREATE TABLE IF NOT EXISTS assignments(tenant text NOT NULL, profile text NOT NULL, connection text NOT NULL, PRIMARY KEY(tenant,profile,connection), FOREIGN KEY(tenant,profile) REFERENCES profiles(tenant,id) ON DELETE CASCADE, FOREIGN KEY(tenant,connection) REFERENCES connections(tenant,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS clients(tenant text NOT NULL, id text PRIMARY KEY, profile text NOT NULL, name text NOT NULL, redirects jsonb NOT NULL, connections jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, FOREIGN KEY(tenant,profile) REFERENCES profiles(tenant,id));
      CREATE TABLE IF NOT EXISTS sessions(tenant text NOT NULL, connection text NOT NULL, profile text NOT NULL, client text NOT NULL REFERENCES clients(id), revision integer NOT NULL DEFAULT 1, secret jsonb NOT NULL, verified boolean NOT NULL DEFAULT false, expires_at bigint NOT NULL, generation integer NOT NULL, status text NOT NULL DEFAULT 'unverified', PRIMARY KEY(tenant,connection,profile,client), FOREIGN KEY(tenant,connection) REFERENCES connections(tenant,id) ON DELETE CASCADE, FOREIGN KEY(tenant,profile) REFERENCES profiles(tenant,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS jobs(id text PRIMARY KEY, tenant text NOT NULL, connection text NOT NULL, profile text NOT NULL, client text NOT NULL REFERENCES clients(id), generation integer NOT NULL, reason text NOT NULL, state text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, due bigint NOT NULL, claim text, lease_until bigint, error text, FOREIGN KEY(tenant,connection) REFERENCES connections(tenant,id) ON DELETE CASCADE, FOREIGN KEY(tenant,profile) REFERENCES profiles(tenant,id) ON DELETE CASCADE);
      CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs(tenant,connection,profile,client) WHERE state IN ('queued','running');
      CREATE INDEX IF NOT EXISTS due_jobs ON jobs(due) WHERE state='queued';
      CREATE TABLE IF NOT EXISTS account_locks(tenant text NOT NULL, connection text NOT NULL, claim text NOT NULL, lease_until bigint NOT NULL, PRIMARY KEY(tenant,connection));
      CREATE TABLE IF NOT EXISTS sso_contexts(tenant text NOT NULL REFERENCES vaults(id), id text NOT NULL, identity text NOT NULL, runtime text NOT NULL, secret jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS connection_sso(tenant text NOT NULL, connection text NOT NULL, parent text NOT NULL, PRIMARY KEY(tenant,connection), FOREIGN KEY(tenant,connection) REFERENCES connections(tenant,id) ON DELETE CASCADE, FOREIGN KEY(tenant,parent) REFERENCES sso_contexts(tenant,id));
      CREATE TABLE IF NOT EXISTS audit(id text PRIMARY KEY, tenant text NOT NULL REFERENCES vaults(id), at bigint NOT NULL, actor text NOT NULL, action text NOT NULL, target text NOT NULL, detail jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_tenant_at ON audit(tenant,at DESC);
      CREATE TABLE IF NOT EXISTS owner_sessions(hash text PRIMARY KEY, tenant text NOT NULL REFERENCES vaults(id), csrf text NOT NULL, expires_at bigint NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_states(hash text PRIMARY KEY, secret jsonb NOT NULL, expires_at bigint NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(tenant text NOT NULL REFERENCES vaults(id), id text NOT NULL, secret jsonb NOT NULL, expires_at bigint NOT NULL, committed boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS oidc_objects(model text NOT NULL,id text NOT NULL,secret jsonb NOT NULL,expires_at bigint NOT NULL,consumed bigint,grant_id text,user_code text,uid text,PRIMARY KEY(model,id));
      CREATE INDEX IF NOT EXISTS oidc_grants ON oidc_objects(grant_id);
      CREATE TABLE IF NOT EXISTS rate_limits(key text PRIMARY KEY,count integer NOT NULL,expires_at bigint NOT NULL);
      INSERT INTO unlock_schema(version) VALUES (1) ON CONFLICT DO NOTHING;
    `);
  });
}
