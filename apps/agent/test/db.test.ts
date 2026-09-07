import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import {
  users,
  vaults,
  connections,
  sessions,
  jobs,
  VAULT_TABLES,
} from "../src/db.ts";

describe("drizzle schema", () => {
  test("users table is named users", () => {
    expect(getTableName(users)).toBe("users");
  });

  test("vault tables cover the unlock migrate() surface", () => {
    expect(getTableName(vaults)).toBe("vaults");
    expect(getTableName(connections)).toBe("connections");
    expect(getTableName(sessions)).toBe("sessions");
    expect(getTableName(jobs)).toBe("jobs");
    expect(VAULT_TABLES).toHaveLength(19);
    expect(VAULT_TABLES).toContain("vaults");
    expect(VAULT_TABLES).toContain("users");
  });
});
