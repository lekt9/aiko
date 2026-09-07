import { sql, VAULT_TABLES } from "../drizzle/client.ts";

const client = sql();
try {
  const ping = await client`select current_database() as database, current_user as user`;
  const database = ping[0]?.database;
  const user = ping[0]?.user;
  if (
    database !== "postgres" ||
    typeof user !== "string" ||
    !user.startsWith("postgres")
  )
    throw new Error("Unexpected Supabase session");

  const rows = await client<{ name: string }[]>`
    select tablename as name
    from pg_tables
    where schemaname = 'public'
  `;
  const found = new Set(Array.from(rows, (row) => row.name));
  const missing = VAULT_TABLES.filter((name) => !found.has(name));
  if (missing.length)
    throw new Error(`Missing vault tables: ${missing.join(",")}`);

  const version = await client<{ version: number | null }[]>`
    select max(version) as version from unlock_schema
  `;
  if (version[0]?.version !== 1)
    throw new Error("unlock_schema version is not 1");

  console.log(
    `supabase ok database=${database} user=${user.split(".")[0]} vault_tables=${VAULT_TABLES.length}`,
  );
} finally {
  await client.end({ timeout: 5 });
}
