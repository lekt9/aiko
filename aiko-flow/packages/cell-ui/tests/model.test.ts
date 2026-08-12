import { describe, expect, test } from "bun:test";
import { inferCellRender, normalizeCellVisualMembrane } from "../src/model.ts";

describe("Cell visual membrane", () => {
  test("preserves explicit generative UI and infers deterministic defaults", () => {
    const model = normalizeCellVisualMembrane({
      apiVersion: "cell/v0",
      kind: "Cell",
      metadata: { name: "staffing" },
      spec: {
        membrane: {
          inputs: {
            order: {
              schema: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" }, note: { type: "string" } },
              },
            },
          },
          outputs: {
            roster: {
              schema: { type: "array", items: { type: "object", properties: { worker: { type: "string" } } } },
              render: { type: "table", columns: [{ key: "worker", label: "Assigned worker" }] },
            },
          },
        },
      },
    });
    expect(model.name).toBe("staffing");
    expect(model.ports[0]!.render).toEqual({
      type: "form",
      fields: [
        { key: "id", label: "Id", required: true },
        { key: "note", label: "Note", required: false },
      ],
    });
    expect(model.ports[1]!.renderVia).toBe("explicit");
    expect(model.ports[1]!.render).toEqual({ type: "table", columns: [{ key: "worker", label: "Assigned worker" }] });
  });
  test("refuses an empty membrane", () =>
    expect(() => normalizeCellVisualMembrane({ spec: { membrane: {} } })).toThrow("no input or output ports"));
  test("array inference is stable", () =>
    expect(inferCellRender({ type: "array", items: { type: "object", properties: { b: {}, a: {} } } })).toEqual({
      type: "table",
      columns: [
        { key: "b", label: "B" },
        { key: "a", label: "A" },
      ],
    }));
});
