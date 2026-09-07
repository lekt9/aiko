import { postgres, migrate } from "../apps/server/src/db.ts";
import { sql, VAULT_TABLES } from "../drizzle/client.ts";

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DIRECT_URL or DATABASE_URL is required");
const tables = [...VAULT_TABLES, "connector_records"];
if (tables.some((name) => !/^[a-z_]+$/.test(name)))
  throw new Error("Unexpected table name");
const db = postgres(url);
const client = sql();
try {
  await migrate(db);
  for (const name of tables) {
    await client.unsafe(`alter table if exists ${name} enable row level security`);
    await client.unsafe(
      `revoke all on table ${name} from anon, authenticated`,
    );
  }
  console.log("unlock schema migrated");
} finally {
  await db.close();
  await client.end({ timeout: 5 });
}
