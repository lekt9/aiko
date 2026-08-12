/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentRegistry } from "@json-render/react";
import { CellJsonRenderer, validateCellJsonRenderSpec } from "../src/CellJsonRenderer.tsx";
import { CellPortView } from "../src/CellPortView.tsx";

const tablePort = {
  name: "roster",
  direction: "output" as const,
  schema: { type: "array" },
  render: { type: "table", columns: [{ key: "worker", label: "Worker" }] },
  renderVia: "explicit" as const,
  required: true,
};
const registry: ComponentRegistry = {
  Card: ({ element }) => (
    <article data-testid="json-card">{String((element.props as { title?: string }).title)}</article>
  ),
};
const jsonSpec = {
  root: "root",
  elements: { root: { type: "Card", props: { title: "Generated roster" }, children: [] } },
};

describe("CellPortView", () => {
  test("renders explicit table data", () => {
    const html = renderToStaticMarkup(<CellPortView port={tablePort} value={[{ worker: "Ada" }]} />);
    expect(html).toContain("Ada");
    expect(html).toContain('data-render-via="explicit"');
  });
  test("does not turn pending or failure into empty success", () => {
    expect(renderToStaticMarkup(<CellPortView port={tablePort} value={undefined} pending />)).toContain(
      "Waiting for durable output",
    );
    expect(renderToStaticMarkup(<CellPortView port={tablePort} value={undefined} error="producer failed" />)).toContain(
      "producer failed",
    );
  });
  test("refuses to raw-render a generative spec without an admitted registry", () => {
    const port = { ...tablePort, render: jsonSpec };
    expect(renderToStaticMarkup(<CellPortView port={port} value={{}} />)).toContain(
      "requires an admitted json-render registry",
    );
  });
  test("renders a real json-render spec through an admitted registry", () => {
    const RenderSpec = ({ spec, value }: { spec: typeof jsonSpec; value: unknown }) => (
      <CellJsonRenderer spec={spec} value={value} registry={registry} />
    );
    const html = renderToStaticMarkup(
      <CellPortView port={{ ...tablePort, render: jsonSpec }} value={{ worker: "Ada" }} RenderSpec={RenderSpec} />,
    );
    expect(html).toContain("Generated roster");
    expect(html).toContain('data-testid="json-card"');
  });
  test("refuses unknown json-render component types", () =>
    expect(() =>
      validateCellJsonRenderSpec({ root: "x", elements: { x: { type: "Unknown", props: {} } } }, registry),
    ).toThrow("Unadmitted"));
});
