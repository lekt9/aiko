import type { Connection, CsvLoginRow } from "@unlock/sdk";
import {
  loginImportKey,
  MAX_CSV_BYTES,
  MAX_IMPORT_ROWS,
  normalizeImportLogin,
} from "./import-policy";

export interface CsvColumn {
  label: string;
  ignored: boolean;
}
export interface CsvTable {
  columns: CsvColumn[];
  rows: { row: number; cells: string[]; malformed: boolean }[];
}
export interface CsvMapping {
  name: number;
  domain: number;
  identity: number;
}
export interface CsvPreviewRow {
  row: number;
  status: "ready" | "duplicate" | "invalid" | "unsupported";
  message: string;
  login?: CsvLoginRow;
}
const headerKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const sensitive = (label: string) =>
  /password|passwd|passphrase|passcode|secret|token|totp|otp|notes?|extra|fields|recovery|card|cvv|pin|privatekey/i.test(
    headerKey(label),
  ) || ["pwd", "pass"].includes(headerKey(label));
const aliases = {
  name: ["name", "title", "itemname", "accountname"],
  domain: ["url", "website", "loginuri", "loginurl", "webaddress", "domain"],
  identity: [
    "username",
    "loginusername",
    "user",
    "email",
    "login",
    "emailaddress",
  ],
};
export function suggestCsvMapping(table: CsvTable): CsvMapping {
  const find = (field: keyof CsvMapping) =>
    table.columns.findIndex(
      (c) => !c.ignored && aliases[field].includes(headerKey(c.label)),
    );
  return {
    name: find("name"),
    domain: find("domain"),
    identity: find("identity"),
  };
}
function delimiter(text: string) {
  const counts = new Map([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (c === "\r" || c === "\n") break;
      if (counts.has(c)) counts.set(c, counts.get(c)! + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}
/** Parse once locally. Known password/notes/token columns are discarded before returning. */
export function parseLoginCsv(source: string): CsvTable {
  if (new TextEncoder().encode(source).length > MAX_CSV_BYTES)
    throw new Error("Choose a CSV no larger than 1 MiB.");
  const text = source.replace(/^\uFEFF/, "");
  const sep = delimiter(text);
  let field = "",
    record: string[] = [],
    quoted = false,
    closed = false,
    recordNumber = 1;
  let columns: CsvColumn[] | undefined;
  const rows: CsvTable["rows"] = [];
  const pushField = () => {
    record.push(field);
    field = "";
    closed = false;
    if (record.length > 100)
      throw new Error("CSV files can contain at most 100 columns.");
  };
  const pushRecord = () => {
    pushField();
    if (record.some((cell) => cell.trim())) {
      if (!columns) {
        columns = record.map((label, index) => ({
          label: label.trim().slice(0, 80) || `Column ${index + 1}`,
          ignored: sensitive(label),
        }));
      } else {
        if (rows.length >= MAX_IMPORT_ROWS)
          throw new Error(
            "Choose a CSV with at most 1,000 login rows. Split larger exports first.",
          );
        rows.push({
          row: recordNumber,
          malformed: record.length !== columns.length,
          cells: columns.map((column, i) =>
            column.ignored ? "" : (record[i] ?? ""),
          ),
        });
      }
    }
    record = [];
    recordNumber++;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === sep) pushField();
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushRecord();
    } else if (c === '"' && field === "" && !closed) quoted = true;
    else {
      if (closed || c === '"')
        throw new Error(
          `CSV row ${recordNumber} has invalid quoting. Export it again as CSV.`,
        );
      field += c;
    }
  }
  if (quoted)
    throw new Error(`CSV row ${recordNumber} has an unclosed quoted field.`);
  if (field || closed || record.length) pushRecord();
  if (!columns || columns.length < 2)
    throw new Error(
      "Include a header row and separate columns with commas, semicolons or tabs.",
    );
  if (!rows.length) throw new Error("This CSV has no login rows.");
  return { columns, rows };
}
export function validCsvMapping(table: CsvTable, mapping: CsvMapping) {
  const values = Object.values(mapping).filter((index) => index >= 0);
  return (
    mapping.domain >= 0 &&
    mapping.identity >= 0 &&
    new Set(values).size === values.length &&
    values.every(
      (index) => table.columns[index] && !table.columns[index].ignored,
    )
  );
}
export function previewCsv(
  table: CsvTable,
  mapping: CsvMapping,
  existing: Connection[],
): CsvPreviewRow[] {
  if (!validCsvMapping(table, mapping)) return [];
  const seen = new Set(
    existing.filter((c) => c.status !== "revoked").map(loginImportKey),
  );
  const typeColumn = table.columns.findIndex((c) =>
    ["type", "itemtype"].includes(headerKey(c.label)),
  );
  return table.rows.map((record) => {
    const base = { row: record.row };
    if (record.malformed)
      return {
        ...base,
        status: "invalid",
        message: "Column count differs from the header.",
      };
    const type = record.cells[typeColumn]?.trim().toLowerCase();
    if (type && !["login", "password", "1"].includes(type))
      return {
        ...base,
        status: "unsupported",
        message: "Not a login. Notes, cards and other item types are skipped.",
      };
    const result = normalizeImportLogin({
      name: record.cells[mapping.name] ?? "",
      domain: record.cells[mapping.domain],
      identity: record.cells[mapping.identity],
    });
    if (result.error)
      return { ...base, status: "invalid", message: result.error };
    const login = { ...result.login!, row: record.row };
    const key = loginImportKey(login);
    if (seen.has(key))
      return {
        ...base,
        login,
        status: "duplicate",
        message: "Same website and username already in the vault or this CSV.",
      };
    seen.add(key);
    return { ...base, login, status: "ready", message: "Ready to import" };
  });
}
