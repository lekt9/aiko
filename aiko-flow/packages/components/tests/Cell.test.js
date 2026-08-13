import { describe, expect, test } from "bun:test";
import React from "react";
import { Cell } from "../src/components/Cell.js";

describe("Cell", () => {
  test("forwards output target as persistence schema, not Cell result schema", () => {
    const output = { table: "handoff", schema: { parse: (value) => value } };
    const element = Cell({ id: "wire", cell: "wire.cell.yaml", output, outputPort: "handoff" });
    expect(element.props.output).toBe(output);
    expect(element.props.outputSchema).toBeUndefined();
    expect(element.props.children).toBeFunction();
  });
});
