import { expect, test } from "vitest";
import { boardGroups, chartBars, monthDays, presentationError, recordTitle, utcDay } from "../src/lib/database-layouts";
import type { DatabaseColumn, DatabaseRow } from "../src/lib/databases";

const column: DatabaseColumn = { id: "status", name: "Status", type: "enum", options: ["Planned", "Done"] };
const row = (id: string, cell?: DatabaseRow["cells"][string]): DatabaseRow => ({ id, revision: 1, cells: cell ? { status: cell } : {} });
const value = (value: string | number | null): DatabaseRow["cells"][string] => ({ state: "ready", freshness: "fresh", value });

test("boards preserve enum order and never merge literal labels with missing/null/unavailable states", () => {
  const rows = [row("literal", value("Not set")), row("missing"), row("null", value(null)), row("unavailable", { state: "unavailable", freshness: "unknown" }), row("planned", value("Planned"))];
  const groups = boardGroups(rows, column);
  expect(groups.slice(0, 2).map(group => [group.label, group.rows.length])).toEqual([["Planned", 1], ["Done", 0]]);
  expect(groups).toHaveLength(6);
  expect(groups.flatMap(group => group.rows.map(row => row.id)).sort()).toEqual(rows.map(row => row.id).sort());
  expect(new Set(groups.map(group => group.key)).size).toBe(groups.length);
});

test("chart bars preserve exact extremes and represent zero and unavailable values differently", () => {
  const rows = [row("negative", value("-9007199254740993.05")), row("positive", value("9007199254740993.05")), row("zero", value("0")), row("missing"), row("empty", value(null)), row("error", { state: "error", freshness: "unknown" })];
  expect(chartBars(rows, "status")).toEqual({ zero: 50, bars: [
    { start: 0, width: 50, negative: true }, { start: 50, width: 50, negative: false }, { start: 50, width: 0, negative: false }, undefined, undefined, undefined,
  ] });
  expect(chartBars([row("a", value("0.000000000000000000000000000001")), row("b", value("0.000000000000000000000000000002"))], "status").bars.map(bar => bar?.width)).toEqual([50, 100]);
  expect(chartBars([row("zero", value(0))], "status").bars[0]?.width).toBe(0);
  expect(recordTitle(rows[0]!, [{ id: "status", name: "Exact", type: "decimal" }], { layout: "chart" })).toBe("-9007199254740993.05");
});

test("calendar groups by UTC day and constructs leap months with Monday alignment", () => {
  expect(utcDay(row("offset", value("2028-03-01T00:30:00+01:00")), "status")).toBe("2028-02-29");
  expect(utcDay(row("null", value(null)), "status")).toBeUndefined();
  expect(utcDay(row("unavailable", { state: "unavailable", freshness: "unknown" }), "status")).toBeUndefined();
  const days = monthDays("2028-02");
  expect(days[0]).toBeUndefined(); expect(days[1]).toBe("2028-02-01"); expect(days.at(-1)).toBe("2028-02-29");
  expect(monthDays("2026-02").filter(Boolean)).toHaveLength(28);
});

test("incompatible and missing presentation fields are visible instead of silently changing layouts", () => {
  expect(presentationError({ layout: "calendar", dateField: "status" }, [column])).toContain("date field");
  expect(presentationError({ layout: "board" }, [column])).toContain("grouping field");
  expect(presentationError({ layout: "chart", valueField: "hidden" }, [column])).toContain("number field");
  expect(presentationError({ layout: "board", groupField: "status" }, [column])).toBeUndefined();
});
