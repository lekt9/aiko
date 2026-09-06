import { z } from "zod";
import type { Connection, CsvImportResult, Workspace } from "@unlock/sdk";
import {
  loginImportKey,
  MAX_IMPORT_ROWS,
  MAX_VAULT_LOGINS,
  normalizeImportLogin,
} from "../lib/import-policy";
const schema = z
  .object({
    rows: z
      .array(
        z
          .object({
            row: z.number().int().min(2).max(100_000),
            name: z.string().max(500),
            domain: z.string().max(2048),
            identity: z.string().max(500),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_IMPORT_ROWS)
      .refine((rows) => new Set(rows.map((r) => r.row)).size === rows.length),
  })
  .strict();
export class CsvImportCapacityError extends Error {}

/** Validate and plan the whole batch before publishing it; existing items are never overwritten. */
export function importCsvLogins(
  state: Workspace,
  body: unknown,
): CsvImportResult {
  const input = schema.parse(body);
  const seen = new Set(
    state.connections.filter((c) => c.status !== "revoked").map(loginImportKey),
  );
  const pending: Connection[] = [];
  const result: CsvImportResult = {
    imported: 0,
    duplicates: 0,
    invalid: 0,
    rows: [],
  };
  const now = new Date().toISOString();
  for (const row of input.rows) {
    const valid = normalizeImportLogin(row);
    if (valid.error) {
      result.invalid++;
      result.rows.push({
        row: row.row,
        status: "invalid",
        message: valid.error,
      });
      continue;
    }
    const login = valid.login!;
    const key = loginImportKey(login);
    if (seen.has(key)) {
      result.duplicates++;
      result.rows.push({
        row: row.row,
        status: "duplicate",
        message:
          "Website and username already saved. Existing login unchanged.",
      });
      continue;
    }
    seen.add(key);
    const id = crypto.randomUUID();
    pending.push({
      id,
      ...login,
      kind: "password",
      sourceId: "import",
      sourceLabel: "CSV import",
      sourceMode: "snapshot",
      status: "challenge",
      revision: 1,
      verifiedAt: now,
      expiresAt: now,
      maintenance: false,
      recipe: "CSV demo metadata only — no password imported",
      createdAt: now,
      passwordUnavailable: true,
    });
    result.imported++;
    result.rows.push({
      row: row.row,
      status: "imported",
      message: "Demo login imported. Password omitted.",
      connectionId: id,
    });
  }
  if (state.connections.length + pending.length > MAX_VAULT_LOGINS)
    throw new CsvImportCapacityError();
  state.connections.push(...pending);
  return result;
}
