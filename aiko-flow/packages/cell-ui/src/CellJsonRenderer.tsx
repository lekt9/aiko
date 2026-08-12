/** @jsxImportSource react */
import { JSONUIProvider, Renderer, type ComponentRegistry, type Spec } from "@json-render/react";
import type { CellRenderSpec } from "./model.ts";

export type CellJsonRendererProps = {
  spec: CellRenderSpec;
  value: unknown;
  registry: ComponentRegistry;
  handlers?: Record<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Fail closed before json-render sees an unadmitted component or malformed Cell spec. */
export function validateCellJsonRenderSpec(spec: CellRenderSpec, registry: ComponentRegistry): Spec {
  const root = record(spec);
  const elements = record(root?.elements);
  if (typeof root?.root !== "string" || !elements || !record(elements[root.root])) {
    throw new Error("Invalid Cell json-render spec: root must name an element");
  }
  for (const [id, rawElement] of Object.entries(elements)) {
    const element = record(rawElement);
    if (!element || typeof element.type !== "string") throw new Error(`Invalid Cell json-render element: ${id}`);
    if (!(element.type in registry)) throw new Error(`Unadmitted Cell json-render component: ${element.type}`);
  }
  return spec as unknown as Spec;
}

/** Real json-render bridge. The application supplies its admitted Cell registry. */
export function CellJsonRenderer({ spec, value, registry, handlers }: CellJsonRendererProps) {
  const validated = validateCellJsonRenderSpec(spec, registry);
  const valueRecord = record(value);
  const initialState = { value, data: value, ...(valueRecord ?? {}) };
  return (
    <JSONUIProvider registry={registry} initialState={initialState} handlers={handlers}>
      <Renderer spec={validated} registry={registry} />
    </JSONUIProvider>
  );
}
