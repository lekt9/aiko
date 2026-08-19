export type CellJsonSchema = {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, CellJsonSchema>;
  items?: CellJsonSchema;
  required?: string[];
};

export type CellRenderSpec =
  | { type: "form"; fields: Array<{ key: string; label: string; required: boolean }> }
  | { type: "table"; columns: Array<{ key: string; label: string }> }
  | { type: "list" }
  | { type: "field"; fieldType: string }
  | { type: "raw" }
  | Record<string, unknown>;

export type CellPort = {
  name: string;
  direction: "input" | "output";
  schema: CellJsonSchema;
  render: CellRenderSpec;
  renderVia: "explicit" | "inferred";
  required: boolean;
};

export type CellVisualMembrane = {
  name: string;
  description?: string;
  ports: CellPort[];
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

/**
 * Parse one cell's visual membrane from the ENGINE's `run.py inspect` output.
 *
 * This package used to infer the render spec itself. That was a second
 * implementation of `cell/helpers.py: infer_render` — the one that actually
 * fires — and the two had already drifted: the engine capped table columns at
 * eight and this did not, so one schema rendered two different tables
 * depending on who asked. Inference now lives only in the engine; this parses
 * what the engine decided, including `renderVia` so a reader can tell an
 * authored view from a derived one.
 *
 * Produce the input with: `python3 cell/run.py inspect <cell.yaml>`
 */
export function parseCellMembrane(inspected: unknown): CellVisualMembrane {
  const root = record(inspected);
  const rawPorts = Array.isArray(root.ports) ? root.ports : [];
  const ports: CellPort[] = rawPorts.map((value) => {
    const port = record(value);
    const direction = port.direction === "output" ? "output" : "input";
    if (typeof port.name !== "string" || !port.name) {
      throw new Error("Cell membrane port has no name");
    }
    if (port.render === undefined) {
      // The engine always emits a render spec. Its absence means this is not
      // engine output, and guessing one here would re-create the drift.
      throw new Error(`Cell membrane port ${port.name} has no render spec — pass \`run.py inspect\` output`);
    }
    return {
      name: port.name,
      direction,
      schema: record(port.schema) as CellJsonSchema,
      render: port.render as CellRenderSpec,
      renderVia: port.renderVia === "explicit" ? "explicit" : "inferred",
      required: port.required !== false,
    };
  });
  if (ports.length === 0) throw new Error("Cell visual membrane has no input or output ports");
  return {
    name: typeof root.name === "string" && root.name ? root.name : "Cell",
    ...(typeof root.description === "string" ? { description: root.description } : {}),
    ports,
  };
}
