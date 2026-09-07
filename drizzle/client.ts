import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";
import supabaseCa from "../apps/server/certs/supabase-prod-ca-2021.crt" with { type: "text" };

export {
  users,
  vaults,
  profiles,
  sources,
  connections,
  sessions,
  jobs,
  connectorRecords,
  VAULT_TABLES,
} from "./schema.ts";
export * as schema from "./schema.ts";

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
}

const globalForDb = globalThis as unknown as {
  unlockSql?: ReturnType<typeof postgres>;
};

export function sql() {
  return (globalForDb.unlockSql ??= postgres(connectionString(), {
    prepare: false,
    max: 5,
    ssl: { rejectUnauthorized: true, ca: supabaseCa },
  }));
}

export function db() {
  return drizzle(sql(), { schema });
}
