/** Password manager CSV export → staged connector logins.
 * Parsing happens entirely on this device: password, note and token columns are
 * discarded by the parser before anything is read, and only names, websites and
 * usernames are ever sent. Aiko never stores the exported passwords. */
import { parseLoginCsv, suggestCsvMapping, type CsvTable } from "./csv-import";
import { websiteDomain, type ConnectorConnection } from "./connectors";

export const MAX_STAGED_IMPORT_ROWS = 500;

export type ImportRow = { name?: string; website: string; username?: string };
export type LoginImportPreview = {
  row: number;
  status: "ready" | "duplicate" | "invalid";
  message: string;
  login?: ImportRow;
};

const clean = (value: string) => value.trim().replace(/\p{C}/gu, "");

export function previewConnectorCsv(
  table: CsvTable,
  columns: { name: number; domain: number; identity: number },
  connections: ConnectorConnection[],
): LoginImportPreview[] {
  if (columns.domain < 0)
    return [{ row: 1, status: "invalid", message: "Map the website column to continue." }];
  const staged = new Set(
    connections
      .filter((c) => c.provider === "browser" && c.status !== "disconnected")
      .map((c) => c.connectorId.replace(/^browser:/, "").toLowerCase()),
  );
  const seen = new Set<string>();
  const previews: LoginImportPreview[] = [];
  for (const record of table.rows) {
    const base = { row: record.row };
    if (record.malformed) {
      previews.push({ ...base, status: "invalid", message: "Column count differs from the header." });
      continue;
    }
    const website = websiteDomain(record.cells[columns.domain] ?? "");
    if (!website) {
      previews.push({ ...base, status: "invalid", message: "Enter the website address, like github.com." });
      continue;
    }
    const username = columns.identity >= 0 ? clean(record.cells[columns.identity] ?? "") : "";
    if (columns.identity >= 0 && !username) {
      previews.push({ ...base, status: "invalid", message: "This row has no username." });
      continue;
    }
    const name = columns.name >= 0 ? clean(record.cells[columns.name] ?? "") : "";
    const login: ImportRow = { website, ...(name ? { name } : {}), ...(username ? { username } : {}) };
    if (seen.has(website) || staged.has(website)) {
      previews.push({
        ...base,
        login,
        status: "duplicate",
        message: "This app is already connected or staged.",
      });
      seen.add(website);
      continue;
    }
    seen.add(website);
    previews.push({ ...base, login, status: "ready", message: "Ready to import" });
  }
  if (previews.filter((p) => p.status === "ready").length > MAX_STAGED_IMPORT_ROWS)
    return previews.map((p) =>
      p.status === "ready"
        ? { ...p, status: "invalid" as const, message: `Import at most ${MAX_STAGED_IMPORT_ROWS} logins at a time.` }
        : p,
    );
  return previews;
}

export function csvMappingFor(table: CsvTable) {
  return suggestCsvMapping(table);
}

export function rowsFromPreviews(previews: LoginImportPreview[]): ImportRow[] {
  return previews.filter((p) => p.status === "ready" && p.login).map((p) => p.login!);
}
