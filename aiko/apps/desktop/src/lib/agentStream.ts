import type {
  GenerativeUiSpec,
  MessagePart,
  QuestionPartState,
  ToolCallState,
  ToolCallStatus,
  ToolKind,
} from "../app/types";
import {
  isAskUserQuestionTool,
  parseQuestionPayload,
} from "../components/QuestionPicker";
import { extractGenerativeUi } from "../generative/parseSpec";

/** Raw ACP session/update payload shape we care about. */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content?: { text?: string } }
  | { sessionUpdate: "agent_thought_chunk"; content?: { text?: string } }
  | {
      sessionUpdate: "tool_call";
      toolCallId?: string;
      tool_call_id?: string;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
      raw_input?: unknown;
      rawOutput?: unknown;
      raw_output?: unknown;
      content?: unknown;
      locations?: Array<{ path?: string } | string>;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId?: string;
      tool_call_id?: string;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
      raw_input?: unknown;
      rawOutput?: unknown;
      raw_output?: unknown;
      content?: unknown;
      locations?: Array<{ path?: string } | string>;
      fields?: Record<string, unknown>;
    }
  | { sessionUpdate: string; [key: string]: unknown };

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; tool: ToolCallState }
  | { type: "tool_update"; tool: Partial<ToolCallState> & { id: string } }
  | { type: "question"; question: QuestionPartState }
  | { type: "capability"; capability: CapabilityDiagnostic };

export interface CapabilityDiagnostic {
  selectedRoute?: string;
  candidates: Array<{
    capabilityId: string;
    capabilityVersion: string;
    provider: string;
    tool: string;
    action: string;
    status: string;
    score: number;
    reasonCodes: string[];
  }>;
  status: string;
  confidence: number;
  automatic: boolean;
  freshness?: string;
  prerequisites: string[];
  reasonCodes: string[];
  learningStatus: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function normalizeStatus(raw: unknown): ToolCallStatus {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  switch (value) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    case "inprogress":
      return "in_progress";
    default:
      return "in_progress";
  }
}

function normalizeKind(raw: unknown, title = "", detail = ""): ToolKind {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (
    value === "read" ||
    value === "edit" ||
    value === "delete" ||
    value === "move" ||
    value === "search" ||
    value === "execute" ||
    value === "think" ||
    value === "fetch" ||
    value === "other"
  ) {
    return value;
  }
  const hay = `${title} ${detail}`.toLowerCase();
  if (/\b(bash|shell|terminal|command|run_terminal|npm|cargo|exec)\b/.test(hay))
    return "execute";
  if (/\b(read|cat|open_file|read_file)\b/.test(hay)) return "read";
  if (/\b(write|edit|search_replace|patch)\b/.test(hay)) return "edit";
  if (/\b(grep|search|find|rg)\b/.test(hay)) return "search";
  if (/\b(fetch|http|web|curl|url)\b/.test(hay)) return "fetch";
  if (/\b(delete|rm)\b/.test(hay)) return "delete";
  return "other";
}

function contentToText(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        const record = asRecord(item);
        if (!record) return undefined;
        if (typeof record.text === "string") return record.text;
        const nested = asRecord(record.content);
        if (nested && typeof nested.text === "string") return nested.text;
        return undefined;
      })
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  const record = asRecord(content);
  if (record && typeof record.text === "string") return record.text;
  return undefined;
}

function locationsToPaths(
  locations: unknown,
): string[] | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined;
  const paths = locations
    .map((loc) => {
      if (typeof loc === "string") return loc;
      const record = asRecord(loc);
      return typeof record?.path === "string" ? record.path : undefined;
    })
    .filter((path): path is string => Boolean(path));
  return paths.length > 0 ? paths : undefined;
}

function summarizeInput(raw: unknown, title?: string): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const record = asRecord(raw);
  if (!record) {
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  const preferred = [
    "command",
    "cmd",
    "path",
    "target_file",
    "file_path",
    "query",
    "url",
    "prompt",
    "pattern",
    "description",
  ];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (typeof record.description === "string" && record.description.trim()) {
    return record.description.trim();
  }
  try {
    const json = JSON.stringify(record);
    if (json === "{}" || json === "null") return title;
    return json.length > 240 ? `${json.slice(0, 237)}…` : json;
  } catch {
    return title;
  }
}

function toolIdFrom(update: Record<string, unknown>): string | undefined {
  return pickString(
    update.toolCallId,
    update.tool_call_id,
    asRecord(update.fields)?.toolCallId,
  );
}

/** Parse one ACP `update` object into a stream event. */
export function parseSessionUpdate(value: unknown): StreamEvent | undefined {
  const update = asRecord(value);
  if (!update) return undefined;
  const kind = update.sessionUpdate;
  if (typeof kind !== "string") return undefined;

  if (kind === "capability_plan") {
    return {
      type: "capability",
      capability: {
        selectedRoute: pickString(update.selectedRoute, update.selected_route),
        candidates: Array.isArray(update.candidates)
          ? update.candidates.flatMap((value) => {
              const candidate = asRecord(value);
              const capabilityId =
                candidate &&
                pickString(candidate.capability_id, candidate.capabilityId);
              const capabilityVersion =
                candidate &&
                pickString(
                  candidate.capability_version,
                  candidate.capabilityVersion,
                );
              if (!candidate || !capabilityId || !capabilityVersion) return [];
              const rawReasons = candidate.reason_codes ?? candidate.reasonCodes;
              return [
                {
                  capabilityId,
                  capabilityVersion,
                  provider: pickString(candidate.provider) ?? "unknown",
                  tool: pickString(candidate.tool) ?? "unknown",
                  action: pickString(candidate.action) ?? "unknown",
                  status: pickString(candidate.status) ?? "unverified",
                  score: typeof candidate.score === "number" ? candidate.score : 0,
                  reasonCodes: Array.isArray(rawReasons)
                    ? rawReasons.filter(
                        (item): item is string => typeof item === "string",
                      )
                    : [],
                },
              ];
            })
          : [],
        status: pickString(update.status) ?? "fallback",
        confidence:
          typeof update.confidence === "number" ? update.confidence : 0,
        automatic: update.automatic === true,
        freshness: pickString(update.freshness),
        prerequisites: Array.isArray(update.prerequisites)
          ? update.prerequisites.filter((item): item is string => typeof item === "string")
          : [],
        reasonCodes: Array.isArray(update.reasonCodes ?? update.reason_codes)
          ? ((update.reasonCodes ?? update.reason_codes) as unknown[]).filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        learningStatus:
          pickString(update.learningStatus, update.learning_status) ?? "unavailable",
      },
    };
  }

  if (kind === "agent_message_chunk") {
    const content = asRecord(update.content);
    const text = content && typeof content.text === "string" ? content.text : "";
    return text.length > 0 ? { type: "text", text } : undefined;
  }

  if (kind === "agent_thought_chunk") {
    const content = asRecord(update.content);
    const text = content && typeof content.text === "string" ? content.text : "";
    return text.length > 0 ? { type: "thought", text } : undefined;
  }

  if (kind === "tool_call") {
    const id = toolIdFrom(update) ?? `tool-${Date.now()}`;
    const title = pickString(update.title) ?? "Tool";
    const rawInput = update.rawInput ?? update.raw_input;
    const rawOutput = update.rawOutput ?? update.raw_output;
    const detail = summarizeInput(rawInput, title);
    const status = normalizeStatus(update.status);
    const toolKind = normalizeKind(update.kind, title, detail ?? "");

    // Promote AskUserQuestion tools into interactive question UI, not raw JSON.
    if (
      isAskUserQuestionTool({ title, rawInput, kind: toolKind }) ||
      toolKind === "other" && /ask/i.test(title)
    ) {
      const questions = parseQuestionPayload(rawInput);
      if (questions) {
        return {
          type: "question",
          question: {
            id: `q-${id}`,
            toolCallId: id,
            questions,
            title: title.replace(/^Ask:\s*/i, "") || "Choose an option",
            answered: status === "completed" || status === "cancelled",
          },
        };
      }
    }

    return {
      type: "tool",
      tool: {
        id,
        title,
        kind: toolKind,
        status,
        detail,
        rawInput,
        rawOutput,
        contentText: contentToText(update.content),
        locations: locationsToPaths(update.locations),
      },
    };
  }

  if (kind === "tool_call_update") {
    const fields = asRecord(update.fields) ?? {};
    const id = toolIdFrom(update) ?? toolIdFrom(fields);
    if (!id) return undefined;
    const title = pickString(update.title, fields.title);
    const rawInput = update.rawInput ?? update.raw_input ?? fields.rawInput ?? fields.raw_input;
    const rawOutput =
      update.rawOutput ?? update.raw_output ?? fields.rawOutput ?? fields.raw_output;
    const statusRaw = update.status ?? fields.status;
    const kindRaw = update.kind ?? fields.kind;
    const detail = summarizeInput(rawInput, title);
    const patch: StreamEvent = {
      type: "tool_update",
      tool: {
        id,
        ...(title ? { title } : {}),
        ...(statusRaw != null ? { status: normalizeStatus(statusRaw) } : {}),
        ...(kindRaw != null
          ? { kind: normalizeKind(kindRaw, title ?? "", detail ?? "") }
          : {}),
        ...(detail ? { detail } : {}),
        ...(rawInput !== undefined ? { rawInput } : {}),
        ...(rawOutput !== undefined ? { rawOutput } : {}),
        ...(update.content !== undefined || fields.content !== undefined
          ? {
              contentText: contentToText(update.content ?? fields.content),
            }
          : {}),
        ...(update.locations !== undefined || fields.locations !== undefined
          ? {
              locations: locationsToPaths(
                update.locations ?? fields.locations,
              ),
            }
          : {}),
      },
    };
    return patch;
  }

  return undefined;
}

export function agentChunkFromEvent(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const update = record.update ?? record;
  const event = parseSessionUpdate(update);
  return event?.type === "text" ? event.text : undefined;
}

export function streamEventFromParams(value: unknown): StreamEvent | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return parseSessionUpdate(record.update ?? record);
}

// ---------------------------------------------------------------------------
// Leaked tool-call XML / invoke markup in agent text → structured parts
// ---------------------------------------------------------------------------

/**
 * Patterns the model sometimes dumps into message text instead of structured
 * tool calls. Covers Grok-style XML and a few close variants.
 */
const TOOL_BLOCK_RE =
  /<(?:tool_call|function_call|xai:tool_call)\b[^>]*>[\s\S]*?<\/(?:tool_call|function_call|xai:tool_call)>/gi;

const INVOKE_BLOCK_RE =
  /invoke\s+([a-zA-Z0-9_./:-]+)\s+with\s+([\s\S]*?)(?=(?:\n\s*invoke\s+[a-zA-Z0-9_./:-]+\s+with\s+)|\n{2,}|$)/gi;

const OPEN_TOOL_TAIL_RE =
  /<(?:tool_call|function_call|xai:tool_call|function\s*=|parameter\s*=)[\s\S]*$/i;

const RENDER_COMPONENT_RE =
  /display\s+render_[a-z0-9_]+\s+with\s+[\s\S]*?(?=\n(?:display\s+render_|invoke\s+)|$)/gi;

function parseXmlToolBlock(block: string, index: number): ToolCallState {
  const nameMatch =
    block.match(/<function\s*=\s*([^\s>]+)/i) ||
    block.match(/<tool_name>\s*([^<]+)\s*<\/tool_name>/i) ||
    block.match(/name\s*=\s*["']?([a-zA-Z0-9_./:-]+)/i);
  const name = nameMatch?.[1]?.trim() ?? "tool";

  const params: Record<string, string> = {};
  const paramRe =
    /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(block)) !== null) {
    params[match[1].trim()] = match[2].trim();
  }
  // Attribute-style: <parameter name="command">...</parameter>
  const attrParamRe =
    /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  while ((match = attrParamRe.exec(block)) !== null) {
    params[match[1].trim()] = match[2].trim();
  }

  const detail =
    params.command ??
    params.cmd ??
    params.path ??
    params.target_file ??
    params.query ??
    params.url ??
    params.description ??
    Object.values(params)[0];

  return {
    id: `leaked-${index}-${name}`,
    title: name,
    kind: normalizeKind(undefined, name, detail ?? ""),
    status: "in_progress",
    detail,
    rawInput: Object.keys(params).length > 0 ? params : block,
  };
}

function parseInvokeBlock(
  name: string,
  argsBody: string,
  index: number,
): ToolCallState {
  const params: Record<string, string> = {};
  // `key is value` pairs; values may be quoted or run to next key/end
  const argRe =
    /([a-zA-Z0-9_]+)\s+is\s+((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[\s\S]*?)(?=\s+[a-zA-Z0-9_]+\s+is\s+|$))/g;
  let match: RegExpExecArray | null;
  while ((match = argRe.exec(argsBody)) !== null) {
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    params[match[1]] = value;
  }
  const detail =
    params.command ??
    params.cmd ??
    params.path ??
    params.target_file ??
    params.query ??
    params.description ??
    argsBody.trim();

  return {
    id: `invoke-${index}-${name}`,
    title: name,
    kind: normalizeKind(undefined, name, detail),
    status: "in_progress",
    detail: detail || undefined,
    rawInput: Object.keys(params).length > 0 ? params : argsBody.trim(),
  };
}

/**
 * Turn agent text that may contain leaked tool/function XML and generative UI
 * fences into ordered message parts. Incomplete trailing markup (still
 * streaming) is dropped from the visible text so wire soup never hits the chat.
 */
export function splitAgentText(
  text: string,
  options?: { streaming?: boolean },
): MessagePart[] {
  if (!text) return [];

  // 1) Generative UI fences first (json-render / ui / dashboard specs)
  const ui = extractGenerativeUi(text, { streaming: options?.streaming });
  let working = ui.text
    .replace(RENDER_COMPONENT_RE, "")
    .replace(/\r\n/g, "\n");

  if (options?.streaming) {
    const openIdx = working.search(OPEN_TOOL_TAIL_RE);
    if (openIdx >= 0) {
      const head = working.slice(0, openIdx);
      const closed = [...head.matchAll(TOOL_BLOCK_RE)];
      if (closed.length === 0) {
        working = head;
      }
    }
  }

  const parts: MessagePart[] = [];
  let cursor = 0;
  let toolIndex = 0;

  type Hit = { start: number; end: number; tool: ToolCallState };
  const hits: Hit[] = [];

  for (const match of working.matchAll(TOOL_BLOCK_RE)) {
    if (match.index == null) continue;
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      tool: parseXmlToolBlock(match[0], toolIndex++),
    });
  }

  INVOKE_BLOCK_RE.lastIndex = 0;
  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = INVOKE_BLOCK_RE.exec(working)) !== null) {
    if (invokeMatch.index == null) continue;
    const start = invokeMatch.index;
    const end = start + invokeMatch[0].length;
    const overlaps = hits.some((hit) => start < hit.end && end > hit.start);
    if (overlaps) continue;
    hits.push({
      start,
      end,
      tool: parseInvokeBlock(invokeMatch[1], invokeMatch[2], toolIndex++),
    });
  }

  hits.sort((a, b) => a.start - b.start);

  for (const hit of hits) {
    if (hit.start > cursor) {
      const slice = working.slice(cursor, hit.start);
      const cleaned = cleanProse(slice);
      if (cleaned) parts.push({ type: "text", text: cleaned });
    }
    const tool = hit.tool;
    if (isAskUserQuestionTool(tool)) {
      const questions = parseQuestionPayload(tool.rawInput);
      if (questions) {
        parts.push({
          type: "question",
          question: {
            id: `q-${tool.id}`,
            toolCallId: tool.id,
            questions,
            title: tool.title.replace(/^Ask:\s*/i, "") || "Choose an option",
            answered:
              tool.status === "completed" || tool.status === "cancelled",
          },
        });
        cursor = hit.end;
        continue;
      }
    }
    parts.push({ type: "tool", tool });
    cursor = hit.end;
  }

  let tail = working.slice(cursor);
  if (options?.streaming) {
    const openIdx = tail.search(OPEN_TOOL_TAIL_RE);
    if (openIdx >= 0) tail = tail.slice(0, openIdx);
  }
  const cleanedTail = cleanProse(tail);
  if (cleanedTail) parts.push({ type: "text", text: cleanedTail });

  // Append generative UI surfaces after prose/tools.
  // Stable ids: root key only (never hash growing raw body — remount thrash).
  // Prefer later partials that only grow structure for the same fence index.
  ui.specs.forEach((parsed, index) => {
    const root =
      parsed.spec &&
      typeof parsed.spec === "object" &&
      "root" in parsed.spec
        ? String((parsed.spec as { root?: unknown }).root ?? index)
        : String(index);
    parts.push({
      type: "ui",
      // One slot per fence order — same key across stream ticks.
      id: `ui-fence-${index}`,
      spec: parsed.spec as GenerativeUiSpec,
      partial: parsed.partial,
    });
    void root;
  });

  return parts;
}

function cleanProse(text: string): string {
  return text
    .replace(/<\/?(?:function|parameter|tool_call|function_call|xai:tool_call)[^>]*>/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Merge structured ACP tools into message parts (by id). */
export function upsertToolPart(
  parts: MessagePart[],
  tool: ToolCallState,
): MessagePart[] {
  const next = parts.slice();
  const index = next.findIndex(
    (part) => part.type === "tool" && part.tool.id === tool.id,
  );
  if (index >= 0) {
    const existing = next[index];
    if (existing.type !== "tool") return next;
    next[index] = {
      type: "tool",
      tool: { ...existing.tool, ...tool },
    };
    return next;
  }
  next.push({ type: "tool", tool });
  return next;
}

export function applyToolUpdate(
  parts: MessagePart[],
  patch: Partial<ToolCallState> & { id: string },
): MessagePart[] {
  const index = parts.findIndex(
    (part) => part.type === "tool" && part.tool.id === patch.id,
  );
  if (index < 0) {
    return upsertToolPart(parts, {
      id: patch.id,
      title: patch.title ?? "Tool",
      kind: patch.kind ?? "other",
      status: patch.status ?? "in_progress",
      detail: patch.detail,
      rawInput: patch.rawInput,
      rawOutput: patch.rawOutput,
      contentText: patch.contentText,
      locations: patch.locations,
    });
  }
  const existing = parts[index];
  if (existing.type !== "tool") return parts;
  const next = parts.slice();
  next[index] = {
    type: "tool",
    tool: {
      ...existing.tool,
      ...patch,
      title: patch.title ?? existing.tool.title,
      kind: patch.kind ?? existing.tool.kind,
      status: patch.status ?? existing.tool.status,
    },
  };
  return next;
}

export function partsToPlainText(parts: MessagePart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "ui") {
        return part.partial ? "[Building interactive UI…]" : "[Interactive UI]";
      }
      if (part.type === "question") {
        return part.question.answered
          ? `[Answered: ${part.question.title ?? "question"}]`
          : `[Question: ${part.question.title ?? "choose an option"}]`;
      }
      const status = part.tool.status;
      const detail = part.tool.detail ? `: ${part.tool.detail}` : "";
      return `[${part.tool.title}${detail} — ${status}]`;
    })
    .join("\n\n")
    .trim();
}

/** Upsert a question part into the message parts list. */
export function upsertQuestionPart(
  parts: MessagePart[],
  question: QuestionPartState,
): MessagePart[] {
  const next = parts.slice();
  const index = next.findIndex(
    (part) =>
      part.type === "question" &&
      (part.question.id === question.id ||
        part.question.toolCallId === question.toolCallId),
  );
  if (index >= 0) {
    const existing = next[index];
    if (existing.type !== "question") return next;
    // Preserve reverse-request id / prior answers when a later tool_call
    // patch omits them.
    next[index] = {
      type: "question",
      question: {
        ...existing.question,
        ...question,
        requestId: question.requestId ?? existing.question.requestId,
        selected: question.selected ?? existing.question.selected,
        answered: question.answered ?? existing.question.answered,
        title: question.title || existing.question.title,
        mode: question.mode ?? existing.question.mode,
        questions:
          question.questions.length > 0
            ? question.questions
            : existing.question.questions,
      },
    };
    return next;
  }
  // Prefer questions over a tool card with the same toolCallId
  const toolIdx = next.findIndex(
    (part) => part.type === "tool" && part.tool.id === question.toolCallId,
  );
  if (toolIdx >= 0) {
    next[toolIdx] = { type: "question", question };
    return next;
  }
  next.push({ type: "question", question });
  return next;
}
