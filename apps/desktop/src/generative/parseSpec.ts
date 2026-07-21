import { nestedToFlat, type Spec } from "@json-render/core";
import { sanitizeSpec } from "./sanitizeSpec";

export interface ParsedUiSpec {
  spec: Spec;
  raw: string;
  /** True when JSON parsed but may still be incomplete while streaming. */
  partial?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accept flat {root, elements} or nested root trees. */
export function coerceSpec(value: unknown): Spec | null {
  const record = asRecord(value);
  if (!record) return null;

  // Flat map form (canonical React schema)
  if (typeof record.root === "string" && asRecord(record.elements)) {
    return record as unknown as Spec;
  }

  // Nested tree under root: { root: { type, props, children } }
  const nestedRoot = asRecord(record.root);
  if (nestedRoot && typeof nestedRoot.type === "string") {
    try {
      return nestedToFlat({ root: nestedRoot });
    } catch {
      // fall through
    }
  }

  // Bare element tree without wrapper
  if (typeof record.type === "string") {
    try {
      return nestedToFlat({ root: record });
    } catch {
      return null;
    }
  }

  return null;
}

function tryParseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Best-effort close of truncated streaming JSON objects. */
function tryRepairJson(raw: string): unknown | undefined {
  const direct = tryParseJson(raw);
  if (direct !== undefined) return direct;

  let candidate = raw.trim();
  candidate = candidate.replace(/,\s*([}\]])/g, "$1");
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of candidate) {
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) candidate += '"';
  while (stack.length) candidate += stack.pop();
  candidate = candidate.replace(/,\s*([}\]])/g, "$1");
  return tryParseJson(candidate);
}

const FENCE_RE =
  /```(?:json-render|jsonrender|generative-ui|gen-ui|ui)\s*\n([\s\S]*?)```/gi;

const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)```/gi;

const OPEN_FENCE_RE =
  /```(?:json-render|jsonrender|generative-ui|gen-ui|ui|json)\s*\n([\s\S]*)$/i;

export interface UiExtraction {
  /** Remaining prose with fences removed. */
  text: string;
  specs: ParsedUiSpec[];
}

function isLikelySpecJson(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return false;
  return (
    /"root"\s*:/.test(trimmed) ||
    /"elements"\s*:/.test(trimmed) ||
    /"type"\s*:\s*"(Card|Metric|Grid|Stack|Table|BarChart|Heading|Text|Callout|Badge|Progress)"/.test(
      trimmed,
    )
  );
}

function parseBlock(raw: string, partial = false): ParsedUiSpec | null {
  const value = tryRepairJson(raw);
  if (value === undefined) return null;
  const coerced = coerceSpec(value);
  if (!coerced) return null;
  // Always sanitize — streaming repair can leave undefined items/rows/values.
  const spec = sanitizeSpec(coerced);
  if (!spec) return null;
  return { spec, raw, partial };
}

/**
 * Pull generative UI specs out of assistant text. Supports:
 * - ```json-render ... ```
 * - ```json with root/elements ```
 * - Open fences while streaming (partial repair)
 */
export function extractGenerativeUi(
  text: string,
  options?: { streaming?: boolean },
): UiExtraction {
  if (!text) return { text: "", specs: [] };

  const specs: ParsedUiSpec[] = [];
  let working = text;

  const consumeFence = (re: RegExp, requireSpecShape: boolean) => {
    re.lastIndex = 0;
    working = working.replace(re, (full, body: string) => {
      if (requireSpecShape && !isLikelySpecJson(body)) return full;
      const parsed = parseBlock(body, false);
      if (!parsed) return full;
      specs.push(parsed);
      return "\n";
    });
  };

  consumeFence(FENCE_RE, false);
  consumeFence(JSON_FENCE_RE, true);

  if (options?.streaming) {
    const open = working.match(OPEN_FENCE_RE);
    if (open) {
      const body = open[1] ?? "";
      if (isLikelySpecJson(body) || open[0].includes("json-render")) {
        const parsed = parseBlock(body, true);
        if (parsed) specs.push(parsed);
        working = working.slice(0, open.index);
      }
    }
  }

  const trimmed = working.trim();
  if (specs.length === 0 && isLikelySpecJson(trimmed)) {
    const parsed = parseBlock(trimmed, Boolean(options?.streaming));
    if (parsed) {
      specs.push(parsed);
      working = "";
    }
  }

  return {
    text: working.replace(/\n{3,}/g, "\n\n").trim(),
    specs,
  };
}
