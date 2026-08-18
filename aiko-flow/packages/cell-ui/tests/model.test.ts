import { describe, expect, test } from "bun:test";
import { parseCellMembrane } from "../src/model.ts";

/**
 * Inference lives in the engine (`cell/helpers.py: infer_render`), so these
 * tests parse `run.py inspect` output rather than re-deriving a render spec.
 * A second inference here is exactly the drift this package removed.
 */
const inspected = {
  name: "staffing",
  description: "assign gangs",
  cell: "/cells/staffing.cell.yaml",
  isLeaf: true,
  ports: [
    {
      name: "request",
      direction: "input",
      schema: { type: "object", properties: { shift_date: {} }, required: ["shift_date"] },
      render: { type: "form", fields: [{ key: "shift_date", label: "Shift Date", required: true }] },
      renderVia: "inferred",
      required: true,
    },
    {
      name: "roster",
      direction: "output",
      schema: { type: "array" },
      render: { type: "table", columns: [{ key: "crane", label: "Crane" }] },
      renderVia: "explicit",
      required: true,
    },
  ],
};

describe("Cell visual membrane", () => {
  test("parses engine output and keeps render provenance", () => {
    const model = parseCellMembrane(inspected);
    expect(model.name).toBe("staffing");
    expect(model.description).toBe("assign gangs");
    expect(model.ports).toHaveLength(2);

    const [request, roster] = model.ports;
    expect(request.direction).toBe("input");
    expect(request.render).toEqual({
      type: "form",
      fields: [{ key: "shift_date", label: "Shift Date", required: true }],
    });
    // The engine says whether a view was authored or derived; the UI reports
    // that rather than guessing.
    expect(request.renderVia).toBe("inferred");
    expect(roster.renderVia).toBe("explicit");
    expect(roster.direction).toBe("output");
  });

  test("refuses a membrane with no ports", () => {
    expect(() => parseCellMembrane({ name: "empty", ports: [] })).toThrow(/no input or output ports/);
  });

  test("refuses a port with no render spec instead of inferring one", () => {
    expect(() =>
      parseCellMembrane({ name: "x", ports: [{ name: "p", direction: "input", schema: {} }] }),
    ).toThrow(/no render spec/);
  });
});
