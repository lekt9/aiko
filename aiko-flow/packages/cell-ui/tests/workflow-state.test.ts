import { describe, expect, test } from "bun:test";
import { resolveCellPortState } from "../src/CellWorkflowUi.tsx";
const port = {
  name: "roster",
  direction: "output" as const,
  schema: { type: "array" },
  render: { type: "list" },
  renderVia: "inferred" as const,
  required: true,
};
describe("durable Cell port state", () => {
  test("missing run identity stays pending rather than empty success", () =>
    expect(
      resolveCellPortState({ port, nodeId: "produce", hasFallback: false, output: { loading: false } }),
    ).toMatchObject({ pending: true, error: null }));
  test("required unmapped port fails closed", () =>
    expect(resolveCellPortState({ port, runId: "r", hasFallback: false, output: { loading: false } }).error).toContain(
      "no node mapping",
    ));
  test("optional unmapped port may be empty", () =>
    expect(
      resolveCellPortState({
        port: { ...port, required: false },
        runId: "r",
        hasFallback: false,
        output: { loading: false },
      }),
    ).toMatchObject({ pending: false, error: null }));
  test("retains produced data during background refetch", () =>
    expect(
      resolveCellPortState({
        port,
        runId: "r",
        nodeId: "produce",
        hasFallback: false,
        output: { loading: true, data: { status: "produced", row: { roster: ["Ada"] } } },
      }),
    ).toMatchObject({ pending: false, value: ["Ada"] }));
  test("failed producer is explicit", () =>
    expect(
      resolveCellPortState({
        port,
        runId: "r",
        nodeId: "produce",
        hasFallback: false,
        output: { loading: false, data: { status: "failed" } },
      }).error,
    ).toContain("failed"));
});
