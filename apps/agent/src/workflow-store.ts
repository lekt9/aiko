import type { Database } from "bun:sqlite";
import type { WorkflowKV } from "./workflow-host.ts";

/** The caller owns the private database lifecycle; unique keys atomically fence repeated runs. */
export function sqliteWorkflowKV(db: Database): WorkflowKV {
  db.exec(
    "CREATE TABLE IF NOT EXISTS workflow_records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  return {
    get: async (key) => {
      const row = db
        .query("SELECT value FROM workflow_records WHERE key=?")
        .get(key) as { value: string } | null;
      return row ? JSON.parse(row.value) : undefined;
    },
    put: async (key, value) => {
      db.query(
        "INSERT INTO workflow_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(key, JSON.stringify(value));
    },
    list: async (prefix) =>
      (
        db
          .query(
            "SELECT value FROM workflow_records WHERE substr(key,1,?)=? ORDER BY key",
          )
          .all(prefix.length, prefix) as { value: string }[]
      ).map((row) => JSON.parse(row.value)),
    claim: async (key, value) =>
      db
        .query("INSERT OR IGNORE INTO workflow_records(key,value) VALUES(?,?)")
        .run(key, JSON.stringify(value)).changes === 1,
    update: async (key, change) => {
      db.transaction(() => {
        const row = db
          .query("SELECT value FROM workflow_records WHERE key=?")
          .get(key) as { value: string } | null;
        const next = change(row ? JSON.parse(row.value) : undefined);
        db.query(
          "INSERT INTO workflow_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(key, JSON.stringify(next));
      })();
    },
  };
}
