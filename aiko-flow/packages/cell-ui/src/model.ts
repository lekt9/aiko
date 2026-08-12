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

function label(key: string): string {
  return key.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function inferCellRender(schema: CellJsonSchema): CellRenderSpec {
  if (schema.type === "array") {
    const columns = Object.keys(schema.items?.properties ?? {}).map((key) => ({ key, label: label(key) }));
    return columns.length > 0 ? { type: "table", columns } : { type: "list" };
  }
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required ?? []);
    return {
      type: "form",
      fields: Object.keys(schema.properties ?? {}).map((key) => ({
        key,
        label: label(key),
        required: required.has(key),
      })),
    };
  }
  if (["string", "number", "integer", "boolean"].includes(schema.type ?? "")) {
    return { type: "field", fieldType: schema.type! };
  }
  return { type: "raw" };
}

function normalizeSchema(value: unknown): CellJsonSchema {
  if (typeof value === "string") return { type: value };
  return record(value) as CellJsonSchema;
}

export function normalizeCellVisualMembrane(spec: unknown): CellVisualMembrane {
  const root = record(spec);
  const metadata = record(root.metadata);
  const membrane = record(record(root.spec).membrane);
  const ports: CellPort[] = [];
  for (const direction of ["input", "output"] as const) {
    const declarations = record(membrane[`${direction}s`]);
    for (const [name, rawDeclaration] of Object.entries(declarations)) {
      const declaration = record(rawDeclaration);
      const schema = normalizeSchema(declaration.schema ?? rawDeclaration);
      const explicit = declaration.render;
      ports.push({
        name,
        direction,
        schema,
        render: explicit !== undefined ? (explicit as CellRenderSpec) : inferCellRender(schema),
        renderVia: explicit !== undefined ? "explicit" : "inferred",
        required: declaration.required !== false,
      });
    }
  }
  if (ports.length === 0) throw new Error("Cell visual membrane has no input or output ports");
  return {
    name: typeof metadata.name === "string" && metadata.name ? metadata.name : "Cell",
    ...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
    ports,
  };
}
