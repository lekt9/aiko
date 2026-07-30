import type { Spec } from "@json-render/react";

/**
 * Guard a json-render spec so the registry never sees undefined arrays /
 * non-string list items during streaming repair. Returns null if the spec
 * is not safe to mount (missing root/elements or empty elements).
 */
export function sanitizeSpec(input: unknown): Spec | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (typeof record.root !== "string" || !record.root) return null;
  if (!record.elements || typeof record.elements !== "object") return null;

  const elementsIn = record.elements as Record<string, unknown>;
  const elementsOut: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(elementsIn)) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as Record<string, unknown>;
    // Skip incomplete elements that only have a type but no props yet mid-stream
    // if they're clearly unfinished containers without type — keep typed ones.
    const type = typeof el.type === "string" ? el.type : "Text";
    const propsIn =
      el.props && typeof el.props === "object"
        ? (el.props as Record<string, unknown>)
        : {};
    const props = sanitizeProps(type, propsIn);
    const children = Array.isArray(el.children)
      ? el.children.filter((c): c is string => typeof c === "string")
      : [];
    elementsOut[key] = {
      ...el,
      type,
      props,
      children,
    };
  }

  // Drop child pointers to elements not present yet (streaming) — prevents
  // empty slots and layout thrash as keys appear out of order.
  for (const key of Object.keys(elementsOut)) {
    const el = elementsOut[key] as { children?: string[] };
    if (!Array.isArray(el.children)) continue;
    el.children = el.children.filter((c) => c in elementsOut);
  }

  if (Object.keys(elementsOut).length === 0) return null;
  // Root must exist after sanitization
  if (!elementsOut[record.root as string]) {
    // Fall back to first element
    const first = Object.keys(elementsOut)[0];
    return {
      root: first,
      elements: elementsOut,
      ...(record.state && typeof record.state === "object"
        ? { state: record.state }
        : {}),
    } as Spec;
  }

  return {
    root: record.root,
    elements: elementsOut,
    ...(record.state && typeof record.state === "object"
      ? { state: record.state }
      : {}),
  } as Spec;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => {
    if (typeof v === "string") return v;
    if (v == null) return "";
    try {
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    } catch {
      return "";
    }
  });
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  });
}

function asStringMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => asStringArray(row));
}

function sanitizeProps(
  type: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case "List":
      return {
        ...props,
        items: asStringArray(props.items),
        ordered: Boolean(props.ordered),
      };
    case "Table":
      return {
        ...props,
        columns: asStringArray(props.columns),
        rows: asStringMatrix(props.rows),
        caption: typeof props.caption === "string" ? props.caption : null,
      };
    case "BarChart": {
      const labels = asStringArray(props.labels);
      let values = asNumberArray(props.values);
      if (values.length < labels.length) {
        values = [...values, ...Array(labels.length - values.length).fill(0)];
      }
      return {
        ...props,
        labels,
        values,
        title: typeof props.title === "string" ? props.title : null,
        unit: typeof props.unit === "string" ? props.unit : null,
      };
    }
    case "Metric":
      return {
        ...props,
        label: String(props.label ?? ""),
        value: String(props.value ?? "—"),
        delta: props.delta == null ? null : String(props.delta),
        trend:
          props.trend === "up" || props.trend === "down" || props.trend === "flat"
            ? props.trend
            : null,
        hint: props.hint == null ? null : String(props.hint),
      };
    case "Progress": {
      const value = Number(props.value);
      const max = Number(props.max);
      return {
        ...props,
        label: props.label == null ? null : String(props.label),
        value: Number.isFinite(value) ? value : 0,
        max: Number.isFinite(max) && max > 0 ? max : 100,
      };
    }
    case "Tabs": {
      const tabs = Array.isArray(props.tabs)
        ? props.tabs
            .map((t) => {
              if (!t || typeof t !== "object") return null;
              const rec = t as Record<string, unknown>;
              if (typeof rec.id !== "string" || typeof rec.label !== "string")
                return null;
              return { id: rec.id, label: rec.label };
            })
            .filter(Boolean)
        : [];
      return {
        ...props,
        tabs,
        activeId:
          typeof props.activeId === "string"
            ? props.activeId
            : (tabs[0] as { id?: string } | undefined)?.id ?? null,
      };
    }
    case "Text":
    case "Heading":
    case "Code":
    case "Callout":
    case "Button":
    case "Badge":
      return {
        ...props,
        // Coerce common string props so .length / display never explode
        text: props.text == null ? props.text : String(props.text),
        content: props.content == null ? props.content : String(props.content),
        label: props.label == null ? props.label : String(props.label),
        title: props.title == null ? props.title : String(props.title),
      };
    default:
      return props;
  }
}

/** True if this looks mountable without throwing on required collections. */
export function isSpecMountable(spec: Spec | null | undefined): boolean {
  if (!spec || typeof spec !== "object") return false;
  const s = spec as { root?: unknown; elements?: unknown };
  if (typeof s.root !== "string" || !s.elements || typeof s.elements !== "object")
    return false;
  return Object.keys(s.elements as object).length > 0;
}
