import { DataError, type Column, type Json, type Expression, type Binding, type ViewDefinition } from "./types.js";

/** Presentation fields must come from the authorized query output, including aggregate aliases. */
export function validateViewPresentation(view: ViewDefinition, columns: readonly Column[]): void {
  if (!["table", "list", "board", "calendar", "chart"].includes(view.layout)) throw new DataError("invalid", "Unknown view layout");
  const field = (key: "titleField" | "groupField" | "dateField" | "valueField", types?: readonly string[]) => {
    const id = view[key];
    if (id === undefined) return;
    const column = columns.find(column => column.id === id);
    if (!column || types && !types.includes(column.type)) throw new DataError("invalid", `View ${key} must name a compatible selected field`);
  };
  field("titleField");
  field("groupField", ["text", "enum", "boolean", "integer", "decimal", "timestamp"]);
  field("dateField", ["timestamp"]);
  field("valueField", ["integer", "decimal"]);
  const required = view.layout === "board" ? "groupField" : view.layout === "calendar" ? "dateField" : view.layout === "chart" ? "valueField" : undefined;
  if (required && view[required] === undefined) throw new DataError("invalid", `The ${view.layout} view requires ${required}`);
}

export function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new DataError("limit", "JSON depth exceeds 32");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new DataError("invalid", "Sparse arrays are not JSON");
    return `[${value.map(v => canonical(v, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) throw new DataError("invalid", "Hidden JSON properties");
    return `{${Object.keys(value).sort().map(key => {
      const d = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in d)) throw new DataError("invalid", "JSON accessors are not allowed");
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new DataError("invalid", "Reserved JSON key");
      return `${JSON.stringify(key)}:${canonical(d.value, depth + 1)}`;
    }).join(",")}}`;
  }
  throw new DataError("invalid", "Expected finite plain JSON");
}
export function clone<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
/** RFC 6901 selector. Missing paths stay distinct from explicit JSON null. */
export function selectJsonPointer(body: unknown, pointer: string): Json | undefined {
  if (typeof pointer !== "string" || pointer.length > 2048 || pointer !== "" && !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) throw new DataError("invalid", "Invalid response selector");
  let value = body;
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part) || Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(part)) return undefined;
    value = (value as Record<string, Json>)[part];
  }
  return value === undefined ? undefined : clone(value) as Json;
}
/** Update an explicitly mapped payload path; arrays require an existing index. */
export function setJsonPointer(body: Json, pointer: string, value: Json): Json {
  selectJsonPointer(undefined, pointer);
  if (pointer === "") return clone(value);
  const parts = pointer.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.some(part => ["__proto__", "prototype", "constructor"].includes(part))) throw new DataError("invalid", "Reserved mapping path");
  const result = clone(body); let current: Json = result;
  for (let i = 0; i < parts.length; i++) {
    if (current === null || typeof current !== "object") throw new DataError("invalid", "Mapping path crosses a scalar value");
    const part = parts[i]!;
    if (Array.isArray(current) && (!/^(0|[1-9][0-9]*)$/.test(part) || Number(part) >= current.length)) throw new DataError("invalid", "Mapping requires an existing array index");
    const object = current as Record<string, Json>;
    if (i === parts.length - 1) object[part] = clone(value);
    else { if (!Object.hasOwn(object, part)) object[part] = {}; current = object[part]!; }
  }
  return result;
}
export function identifier(value: unknown, name = "ID"): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw new DataError("invalid", `Invalid ${name}`);
}
export function label(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new DataError("invalid", "Expected a nonempty label of at most 512 characters");
}
export function integer(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new DataError("invalid", `Expected integer in ${min}..${max}`);
}
/** Canonical decimal strings preserve precision through SQLite/JSON and arithmetic. */
export function decimal(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^-?\d+(\.\d+)?$/.test(value)) throw new DataError("invalid", "Expected a decimal string");
  let [whole, fraction = ""] = value.split(".");
  const negative = whole!.startsWith("-");
  whole = whole!.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  fraction = fraction.replace(/0+$/, "");
  const result = whole + (fraction ? `.${fraction}` : "");
  return negative && result !== "0" ? `-${result}` : result;
}
function parts(value: string): [bigint, number] { const n = decimal(value); return [BigInt(n.replace(".", "")), n.includes(".") ? n.length - n.indexOf(".") - 1 : 0]; }
function format(value: bigint, scale: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = (value < 0 ? -value : value).toString().padStart(scale + 1, "0");
  return decimal(sign + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits));
}
export function decimalMath(op: "add" | "subtract" | "multiply" | "divide" | "compare", a: string, b: string): string | number {
  const [x, xs] = parts(a), [y, ys] = parts(b), scale = Math.max(xs, ys);
  const left = x * 10n ** BigInt(scale - xs), right = y * 10n ** BigInt(scale - ys);
  if (op === "compare") return left === right ? 0 : left < right ? -1 : 1;
  if (op === "multiply") return format(x * y, xs + ys);
  if (op === "divide") {
    if (!right) throw new DataError("invalid", "Division by zero");
    // Exact terminating decimals only; callers must choose a rounding policy for other divisions.
    let numerator = left, denominator = right, places = 0;
    while (numerator % denominator && places < 64) { numerator *= 10n; places++; }
    if (numerator % denominator) throw new DataError("invalid", "Nonterminating decimal division requires explicit rounding");
    return format(numerator / denominator, places);
  }
  return format(op === "add" ? left + right : left - right, scale);
}
export function fieldValue(column: Column, value: Json): Json {
  if (value === null) {
    if (!column.nullable) throw new DataError("invalid", `${column.id} does not allow null`);
    return null;
  }
  switch (column.type) {
    case "text": if (typeof value !== "string" || value.length > 65536) break; return value;
    case "boolean": if (typeof value !== "boolean") break; return value;
    case "integer": if (!Number.isSafeInteger(value)) break; return value;
    case "decimal": return decimal(value);
    case "timestamp": if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) break; return new Date(value).toISOString();
    case "enum": if (typeof value !== "string" || !column.options?.includes(value)) break; return value;
    case "json": if (canonical(value).length > 65536) throw new DataError("limit", "JSON field exceeds 64 KiB"); return clone(value);
    case "attachment": if (typeof value !== "string") break; identifier(value, "attachment reference"); return value;
    case "relation": {
      const many = column.relation?.cardinality === "many-to-many";
      if (many && Array.isArray(value) && value.length <= 256 && value.every(v => typeof v === "string")) {
        value.forEach(v => identifier(v, "row reference"));
        return [...new Set(value as string[])];
      }
      if (!many && typeof value === "string") { identifier(value, "row reference"); return value; }
      break;
    }
  }
  throw new DataError("invalid", `Invalid ${column.type} value for ${column.id}`);
}
export function dependencies(binding: Binding | undefined): string[] {
  if (!binding) return [];
  if (binding.kind === "entity") return binding.subjectField ? [binding.subjectField] : [];
  if (binding.kind === "lookup") return [binding.relation];
  if (binding.kind === "request") return Object.values(binding.inputs).flatMap(v => "rowField" in v ? [v.rowField] : []);
  if (binding.kind === "formula") {
    const fields: string[] = [];
    const visit = (e: Expression, depth: number) => {
      if (depth > 16) throw new DataError("limit", "Formula depth exceeds 16");
      if ("field" in e) fields.push(e.field);
      else if ("op" in e) { if (!Array.isArray(e.args) || e.args.length > 16) throw new DataError("invalid", "Invalid formula arguments"); e.args.forEach(a => visit(a, depth + 1)); }
    };
    visit(binding.expression, 0); return [...new Set(fields)];
  }
  return [];
}
export function validateColumns(columns: Column[]): Column[] {
  if (!Array.isArray(columns) || !columns.length || columns.length > 128) throw new DataError("invalid", "Tables need 1..128 columns");
  const result = clone(columns), seen = new Set<string>();
  for (const c of result) {
    identifier(c.id, "column ID"); label(c.name);
    if (c.id.includes(".") || seen.has(c.id)) throw new DataError("invalid", "Column IDs must be unique and contain no dots");
    seen.add(c.id);
    if (!["text", "boolean", "integer", "decimal", "timestamp", "enum", "json", "relation", "attachment"].includes(c.type)) throw new DataError("invalid", "Unknown field type");
    if (c.type === "enum" && (!Array.isArray(c.options) || !c.options.length || c.options.length > 256 || c.options.some(v => typeof v !== "string"))) throw new DataError("invalid", "Enum options required");
    if (c.type === "relation") {
      if (!c.relation || !["one-to-one", "many-to-one", "many-to-many"].includes(c.relation.cardinality)) throw new DataError("invalid", "Relation target and cardinality required");
      identifier(c.relation.tableId);
    }
    if (c.authority && !["table", "entity", "external", "domain"].includes(c.authority)) throw new DataError("invalid", "Unknown field authority");
    if (c.binding && !["literal", "entity", "request", "lookup", "formula"].includes(c.binding.kind)) throw new DataError("invalid", "Unknown binding kind");
    if (c.binding?.kind === "request") {
      identifier(c.binding.sourceId); label(c.binding.contractDigest);
      if (!c.binding.select || typeof c.binding.select.jsonPointer !== "string" || typeof c.binding.select.stepId !== "string") throw new DataError("invalid", "Request selector required");
      integer(c.binding.refresh?.maxAgeSeconds, 0, 31_536_000);
      if (!["on-demand", "on-open", "scheduled"].includes(c.binding.refresh.mode)) throw new DataError("invalid", "Unknown refresh mode");
    }
    if (c.binding?.kind === "request" || c.binding?.kind === "entity") {
      if (!["reference-only", "materialized", "snapshot"].includes(c.binding.retention)) throw new DataError("invalid", "Retention policy required");
    }
    if (c.binding?.kind === "entity") {
      const b = c.binding;
      if (b.subject !== undefined) label(b.subject);
      if (b.subjectField !== undefined) identifier(b.subjectField);
      if (b.subject !== undefined && b.subjectField !== undefined) throw new DataError("invalid", "Choose a fixed subject or a subject field");
      if (b.observationId !== undefined && !/^obs_[a-f0-9]{64}$/.test(b.observationId)) throw new DataError("invalid", "Invalid entity observation reference");
      selectJsonPointer(undefined, b.path);
    }
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new DataError("invalid", "Cyclic field dependencies");
    if (done.has(id)) return;
    const column = result.find(c => c.id === id);
    if (!column) throw new DataError("invalid", `Unknown dependency ${id}`);
    visiting.add(id); dependencies(column.binding).forEach(visit); visiting.delete(id); done.add(id);
  };
  result.forEach(c => visit(c.id)); return result;
}
