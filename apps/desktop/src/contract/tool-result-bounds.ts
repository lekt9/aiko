// tool-result-bounds.ts — hard caps on tool outputs that enter model context.
//
// Why: chat context was a linear full-transcript replay. A single bash dump
// (~9.5MB) was estimated as ~500 tokens (because estimate reused the 2k
// summarizer truncator) and never compacted — then Codegraff 429'd on TPM.
//
// Fix: bound every tool result at the chokepoint (neuronizeTools), again when
// sanitizing/persisting/loading, and estimate tokens from full (post-bound)
// content — never from the summarizer's 2k view.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { userDir } from "../utils/paths";

/** Soft live cap for a single string field inside a tool result (~3k tokens). */
export const TOOL_RESULT_MAX_CHARS = (() => {
  const raw = Number(process.env.AIKO_TOOL_RESULT_MAX_CHARS);
  if (Number.isFinite(raw) && raw >= 2_000) return Math.floor(raw);
  return 12_000;
})();

/**
 * Practical packing budget for auto-compaction. Model cards may advertise 1M
 * windows; TPM rate limits and tool schemas make that a lie in practice.
 */
export const PRACTICAL_CONTEXT_BUDGET_TOKENS = (() => {
  const raw = Number(process.env.AIKO_CONTEXT_BUDGET_TOKENS);
  if (Number.isFinite(raw) && raw >= 16_000) return Math.floor(raw);
  return 100_000;
})();

export function effectiveContextWindow(modelContextWindow: number): number {
  if (!Number.isFinite(modelContextWindow) || modelContextWindow <= 0) {
    return PRACTICAL_CONTEXT_BUDGET_TOKENS;
  }
  return Math.min(modelContextWindow, PRACTICAL_CONTEXT_BUDGET_TOKENS);
}

export interface BoundResult {
  value: unknown;
  truncated: boolean;
  originalChars: number;
  spillPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyLen(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function spillDir(): string {
  return path.join(userDir(), "tool-spills");
}

function spillFull(text: string, hint?: string): string | undefined {
  try {
    const dir = spillDir();
    mkdirSync(dir, { recursive: true });
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const file = path.join(dir, `${hint ? `${hint}-` : ""}${hash}.txt`);
    writeFileSync(file, text, "utf8");
    return file;
  } catch {
    return undefined;
  }
}

function truncationMarker(originalChars: number, keptChars: number, spillPath?: string): string {
  const dropped = Math.max(0, originalChars - keptChars);
  const spill = spillPath ? ` Full dump: ${spillPath}` : "";
  return `\n\n[... truncated ${dropped.toLocaleString()} chars of ${originalChars.toLocaleString()}; kept ${keptChars.toLocaleString()}.${spill}]`;
}

export function boundString(text: string, maxChars = TOOL_RESULT_MAX_CHARS, spillHint?: string): BoundResult {
  if (text.length <= maxChars) {
    return { value: text, truncated: false, originalChars: text.length };
  }
  const spillPath = spillFull(text, spillHint);
  // Shrink head until head+marker fits maxChars (marker length depends on spill path).
  let headBudget = Math.max(0, maxChars - 220);
  let value = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = text.slice(0, headBudget);
    value = `${head}${truncationMarker(text.length, head.length, spillPath)}`;
    if (value.length <= maxChars) break;
    headBudget = Math.max(0, headBudget - (value.length - maxChars) - 16);
  }
  if (value.length > maxChars) value = value.slice(0, maxChars);
  return {
    value,
    truncated: true,
    originalChars: text.length,
    spillPath,
  };
}

/**
 * Bound a tool execute return value (typically ToolResult-shaped) for model context.
 * Recurses into common string fields: output, error, content, stdout, stderr, text.
 */
export function boundToolValue(value: unknown, maxChars = TOOL_RESULT_MAX_CHARS, spillHint?: string): BoundResult {
  if (typeof value === "string") {
    return boundString(value, maxChars, spillHint);
  }

  if (Array.isArray(value)) {
    let truncated = false;
    let originalChars = 0;
    let spillPath: string | undefined;
    const next = value.map((item, i) => {
      const bound = boundToolValue(item, maxChars, spillHint ? `${spillHint}-${i}` : undefined);
      truncated = truncated || bound.truncated;
      originalChars += bound.originalChars;
      if (bound.spillPath) spillPath = bound.spillPath;
      return bound.value;
    });
    // Whole-array size guard
    const serialized = (() => {
      try {
        return JSON.stringify(next) ?? "";
      } catch {
        return "";
      }
    })();
    if (serialized.length > maxChars * 2) {
      const asText = boundString(serialized, maxChars, spillHint);
      return {
        value: { success: true, output: asText.value, truncated: true },
        truncated: true,
        originalChars: Math.max(originalChars, asText.originalChars),
        spillPath: asText.spillPath ?? spillPath,
      };
    }
    return { value: next, truncated, originalChars, spillPath };
  }

  if (isRecord(value)) {
    // AI SDK wire shapes: { type: "json"|"text"|..., value: ... }
    if (typeof value.type === "string" && "value" in value) {
      const inner = boundToolValue(value.value, maxChars, spillHint);
      if (!inner.truncated) {
        return { value, truncated: false, originalChars: inner.originalChars };
      }
      return {
        value: { ...value, value: inner.value },
        truncated: true,
        originalChars: inner.originalChars,
        spillPath: inner.spillPath,
      };
    }

    const stringKeys = ["output", "error", "content", "stdout", "stderr", "text", "message", "summary"] as const;
    let truncated = false;
    const originalChars = stringifyLen(value);
    let spillPath: string | undefined;
    const next: Record<string, unknown> = { ...value };

    for (const key of stringKeys) {
      if (typeof next[key] === "string") {
        const bound = boundString(next[key] as string, maxChars, spillHint ? `${spillHint}-${key}` : key);
        next[key] = bound.value;
        truncated = truncated || bound.truncated;
        if (bound.spillPath) spillPath = bound.spillPath;
      }
    }

    // Nested result blobs
    if (isRecord(next.result)) {
      const bound = boundToolValue(next.result, maxChars, spillHint ? `${spillHint}-result` : "result");
      next.result = bound.value;
      truncated = truncated || bound.truncated;
      if (bound.spillPath) spillPath = bound.spillPath;
    }

    if (truncated) {
      next.truncated = true;
      if (spillPath) next.spillPath = spillPath;
    }

    // Whole-object guard for weird shapes without string fields
    try {
      const serialized = JSON.stringify(next) ?? "";
      if (serialized.length > maxChars * 3) {
        const asText = boundString(serialized, maxChars, spillHint);
        return {
          value: {
            success: typeof next.success === "boolean" ? next.success : true,
            output: asText.value,
            truncated: true,
            ...(asText.spillPath ? { spillPath: asText.spillPath } : {}),
          },
          truncated: true,
          originalChars: Math.max(originalChars, asText.originalChars),
          spillPath: asText.spillPath ?? spillPath,
        };
      }
    } catch {
      /* ignore */
    }

    return { value: next, truncated, originalChars, spillPath };
  }

  return { value, truncated: false, originalChars: stringifyLen(value) };
}

/** Full char count of a tool-result part's output — NO summarizer truncation. */
export function toolOutputCharCount(output: unknown): number {
  return stringifyLen(output);
}

/**
 * Bound every tool-result part in a ModelMessage list. Assistant/user untouched.
 * Idempotent: already-truncated markers stay within cap.
 */
export function boundModelMessages(messages: ModelMessage[], maxChars = TOOL_RESULT_MAX_CHARS): ModelMessage[] {
  let changed = false;
  const out: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }

    let msgChanged = false;
    const content = message.content.map((part) => {
      if (!part || typeof part !== "object" || (part as { type?: string }).type !== "tool-result") {
        return part;
      }
      const p = part as { type: "tool-result"; toolCallId: string; toolName: string; output: unknown };
      const bound = boundToolValue(p.output, maxChars, p.toolCallId?.slice(0, 12) ?? p.toolName);
      let nextOutput = bound.value;
      // JSON envelopes around a maxed string can still exceed maxChars; flatten.
      if (toolOutputCharCount(nextOutput) > maxChars) {
        const flat = boundString(
          typeof nextOutput === "string"
            ? nextOutput
            : (() => {
                try {
                  return JSON.stringify(nextOutput) ?? String(nextOutput);
                } catch {
                  return String(nextOutput);
                }
              })(),
          maxChars,
          p.toolCallId?.slice(0, 12) ?? p.toolName,
        );
        nextOutput = { type: "text", value: flat.value };
        msgChanged = true;
      } else if (bound.truncated) {
        msgChanged = true;
      } else {
        return part;
      }
      return { ...p, output: nextOutput };
    });

    if (msgChanged) {
      changed = true;
      out.push({ ...message, content } as ModelMessage);
    } else {
      out.push(message);
    }
  }

  return changed ? out : messages;
}
