import { context, Vault } from "./vault.js";
import type { Envelope } from "./crypto.js";
/** Offline maintenance only: stop every writer before running and retain old keys until restore testing. */
export async function rewrapVault(vault: Vault) {
  const tables: {
    table: string;
    keys: string[];
    aad: (row: Record<string, string>) => string;
  }[] = [
    {
      table: "connections",
      keys: ["tenant", "id"],
      aad: (r) => context(r.tenant, "credential", r.id),
    },
    {
      table: "sources",
      keys: ["tenant", "id"],
      aad: (r) => context(r.tenant, "source", r.id),
    },
    {
      table: "sessions",
      keys: ["tenant", "connection", "profile", "client"],
      aad: (r) =>
        context(
          r.tenant,
          "session",
          `${r.connection}:${r.profile}:${r.client}`,
        ),
    },
    {
      table: "sso_contexts",
      keys: ["tenant", "id"],
      aad: (r) => context(r.tenant, "sso", r.id),
    },
    {
      table: "imports",
      keys: ["tenant", "id"],
      aad: (r) => context(r.tenant, "import", r.id),
    },
    {
      table: "oidc_objects",
      keys: ["model", "id"],
      aad: (r) => `unlock:v1:oidc:${r.model}:${r.id}`,
    },
    {
      table: "auth_states",
      keys: ["hash"],
      aad: (r) => `unlock:v1:auth-state:${r.hash}`,
    },
  ];
  let rewrapped = 0;
  for (const spec of tables) {
    let offset = 0;
    while (true) {
      const count = await vault.db.transaction(async (sql) => {
        const rows = await sql.query<
          Record<string, unknown> & { secret: Envelope }
        >(
          `SELECT * FROM ${spec.table} WHERE secret IS NOT NULL ORDER BY ${spec.keys.join(",")} LIMIT 25 OFFSET $1 FOR UPDATE`,
          [offset],
        );
        for (const row of rows.rows) {
          const value = await vault.cipher.rewrap(
            spec.aad(row as unknown as Record<string, string>),
            row.secret,
          );
          await sql.query(
            `UPDATE ${spec.table} SET secret=$1 WHERE ${spec.keys.map((key, i) => `${key}=$${i + 2}`).join(" AND ")}`,
            [JSON.stringify(value), ...spec.keys.map((key) => row[key])],
          );
        }
        return rows.rows.length;
      });
      rewrapped += count;
      offset += count;
      if (count < 25) break;
    }
  }
  return { rewrapped };
}
