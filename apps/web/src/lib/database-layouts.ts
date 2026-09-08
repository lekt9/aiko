import type { DatabaseArtifactResult, DatabaseColumn, DatabaseRow } from "./databases";

export type DatabasePresentation = Pick<DatabaseArtifactResult["view"], "layout" | "titleField" | "groupField" | "dateField" | "valueField">;
export const layoutNames = { table: "Table", list: "List", board: "Board", calendar: "Calendar", chart: "Chart" } as const;
export const groupTypes = new Set(["text", "enum", "boolean", "integer", "decimal", "timestamp"]);
export function cellText(cell: DatabaseRow["cells"][string] | undefined): string {
  if (!cell || cell.state === "missing") return "Not set";
  if (cell.state === "unavailable") return "Unavailable";
  if (cell.state === "error") return "Error";
  if (cell.value === null) return "Empty";
  return typeof cell.value === "object" ? JSON.stringify(cell.value) : String(cell.value);
}
export function recordTitle(row: DatabaseRow, columns: DatabaseColumn[], presentation: DatabasePresentation): string {
  const title = presentation.titleField ?? columns.find(column => column.type === "text")?.id ?? columns[0]?.id;
  return title ? cellText(row.cells[title]) : row.id;
}
export function presentationError(presentation: DatabasePresentation, columns: DatabaseColumn[]): string | undefined {
  if (!Object.hasOwn(layoutNames, presentation.layout)) return "This layout is unavailable.";
  if (presentation.titleField && !columns.some(column => column.id === presentation.titleField)) return "Choose a record title from the visible fields.";
  if (presentation.layout === "board" && !columns.some(column => column.id === presentation.groupField && groupTypes.has(column.type))) return "Choose a grouping field for the board.";
  if (presentation.layout === "calendar" && !columns.some(column => column.id === presentation.dateField && column.type === "timestamp")) return "Choose a date field for the calendar.";
  if (presentation.layout === "chart" && !columns.some(column => column.id === presentation.valueField && ["integer", "decimal"].includes(column.type))) return "Choose a number field for the chart.";
}
export function boardGroups(rows: DatabaseRow[], column: DatabaseColumn) {
  const groups = new Map<string, { key: string; label: string; rows: DatabaseRow[] }>();
  const keyOf = (cell: DatabaseRow["cells"][string] | undefined) => cell?.state === "ready" ? JSON.stringify(["value", cell.value]) : JSON.stringify(["state", cell?.state ?? "missing"]);
  for (const option of column.options ?? []) {
    const key = JSON.stringify(["value", option]); groups.set(key, { key, label: option, rows: [] });
  }
  for (const row of rows) {
    const cell = row.cells[column.id], key = keyOf(cell);
    const group = groups.get(key) ?? { key, label: cellText(cell), rows: [] };
    group.rows.push(row); groups.set(key, group);
  }
  return [...groups.values()];
}
export function utcDay(row: DatabaseRow, field: string): string | undefined {
  const cell = row.cells[field];
  if (cell?.state !== "ready" || typeof cell.value !== "string" || !Number.isFinite(Date.parse(cell.value))) return;
  return new Date(cell.value).toISOString().slice(0, 10);
}
export function monthDays(month: string): (string | undefined)[] {
  const start = new Date(`${month}-01T00:00:00Z`);
  const next = new Date(start); next.setUTCMonth(next.getUTCMonth() + 1);
  const count = Math.round((next.getTime() - start.getTime()) / 86_400_000);
  return [...Array<undefined>((start.getUTCDay() + 6) % 7).fill(undefined), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
}

/** Scale with exact integers; only the bounded visual percentage uses floating point. */
export function chartBars(rows: DatabaseRow[], field: string) {
  const parts = rows.map(row => {
    const cell = row.cells[field], value = cell?.value;
    const text = cell?.state === "ready" && (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : "";
    if (text.length > 128 || !/^-?\d+(\.\d+)?$/.test(text)) return undefined;
    return { coefficient: BigInt(text.replace(".", "")), scale: text.includes(".") ? text.length - text.indexOf(".") - 1 : 0 };
  });
  const scale = parts.reduce((max, part) => Math.max(max, part?.scale ?? 0), 0);
  const values = parts.map(part => part === undefined ? undefined : part.coefficient * 10n ** BigInt(scale - part.scale));
  let min = 0n, max = 0n;
  for (const value of values) if (value !== undefined) { if (value < min) min = value; if (value > max) max = value; }
  const span = max - min || 1n;
  const percent = (value: bigint) => Number((value - min) * 10_000n / span) / 100;
  const zero = percent(0n);
  return { zero, bars: values.map(value => value === undefined ? undefined : { start: Math.min(zero, percent(value)), width: Math.abs(percent(value) - zero), negative: value < 0n }) };
}
