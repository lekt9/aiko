/**
 * SESSION-EXPORT-PRO — multi-format export honesty (md / txt / json / html).
 *
 * Pure helpers for format labels, soft-empty journal detection, estimated size
 * class, soft-fail reason keys, and filename sanitize. NDJSON streaming export
 * lives elsewhere — do not add it here.
 *
 * No DOM / Tauri side effects. Callers own downloads and toasts.
 */

import {
  formatToolSummaryLine,
  type ExportableMessage,
  type SessionExportFormat,
  type SessionExportOptions,
  sessionExportFilenameFor,
} from "@/lib/sessionExport";

/** Transcript formats this pro module covers (no NDJSON). */
export const SESSION_EXPORT_FORMATS: readonly SessionExportFormat[] = [
  "markdown",
  "plain",
  "json",
  "html",
] as const;

/** Stable soft-fail kinds for text-format export toasts. */
export type SessionExportSoftFailKind =
  | "empty"
  | "no_target"
  | "write_failed"
  | "load_failed"
  | "clipboard"
  | "cancelled"
  | "other";

/** Coarse size buckets for honest pre-export meta (never invents content). */
export type SessionExportSizeClass =
  | "empty"
  | "tiny"
  | "small"
  | "medium"
  | "large"
  | "huge";

/** Byte thresholds for {@link sessionExportSizeClass} (UTF-8 estimate). */
export const SESSION_EXPORT_SIZE_THRESHOLDS = {
  /** exclusive upper bound of empty */
  empty: 0,
  tiny: 2 * 1024,
  small: 32 * 1024,
  medium: 256 * 1024,
  large: 2 * 1024 * 1024,
} as const;

function errText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const code =
      typeof (err as Error & { code?: unknown }).code === "string"
        ? String((err as Error & { code?: string }).code)
        : "";
    return `${code} ${err.message} ${err.name}`.trim();
  }
  if (typeof err === "object") {
    const o = err as { code?: unknown; message?: unknown; reason?: unknown };
    const parts = [o.code, o.message, o.reason]
      .filter((x) => x != null && String(x).trim())
      .map(String);
    if (parts.length) return parts.join(" ");
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function errCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c.trim().toLowerCase();
  }
  return "";
}

function isToolish(m: ExportableMessage): boolean {
  if (m.role === "tool") return true;
  if (
    m.marker === "tool_step" ||
    m.marker === "context_compact" ||
    m.marker === "turn_cancelled"
  ) {
    return true;
  }
  const c = (m.content || "").trim();
  return c.startsWith("tool_step|") || c.startsWith("tool_step");
}

function normalizeRole(
  role: string | undefined,
): "user" | "assistant" | "other" {
  const r = (role || "").trim().toLowerCase();
  if (r === "user" || r === "human" || r === "me" || r === "prompt") {
    return "user";
  }
  if (
    r === "assistant" ||
    r === "ai" ||
    r === "bot" ||
    r === "model" ||
    r === "grok" ||
    r === "agent"
  ) {
    return "assistant";
  }
  return "other";
}

/** Type guard for {@link SessionExportFormat}. */
export function isSessionExportFormat(v: unknown): v is SessionExportFormat {
  return (
    typeof v === "string" &&
    (SESSION_EXPORT_FORMATS as readonly string[]).includes(v)
  );
}

/** File extension including the leading dot (`.md`, `.txt`, …). */
export function sessionExportFormatExt(format: SessionExportFormat): string {
  switch (format) {
    case "markdown":
      return ".md";
    case "plain":
      return ".txt";
    case "json":
      return ".json";
    case "html":
      return ".html";
  }
}

/**
 * i18n key for the session-menu / long action label
 * (`session.exportMd`, `session.exportPlain`, …).
 */
export function sessionExportFormatLabelKey(format: SessionExportFormat): string {
  switch (format) {
    case "markdown":
      return "session.exportMd";
    case "plain":
      return "session.exportPlain";
    case "json":
      return "session.exportJson";
    case "html":
      return "session.exportHtml";
  }
}

/**
 * i18n key for the short format name chip (`Markdown`, `Plain text`, …).
 */
export function sessionExportFormatNameKey(format: SessionExportFormat): string {
  return `session.exportFormat.${format}`;
}

/**
 * Default include-thoughts / include-tool-summary for a format when the
 * caller does not pass options. Matches existing App / sessionExport defaults.
 */
export function defaultSessionExportOptions(
  format: SessionExportFormat,
): Required<SessionExportOptions> {
  switch (format) {
    case "json":
      // Clean re-import: tools + thoughts off unless opted in.
      return { includeThoughts: false, includeToolSummary: false };
    case "markdown":
    case "plain":
    case "html":
      return { includeThoughts: true, includeToolSummary: true };
  }
}

/**
 * Whether the local journal has any content that would appear in a
 * text-format export under the given options.
 *
 * Soft-empty covers: no messages, only blank shells, tool-only journals when
 * tools are omitted, and JSON paths with no user/assistant body text.
 * Never invents content from title / meta alone.
 */
export function isSessionExportJournalEmpty(
  messages: ExportableMessage[] | null | undefined,
  opts?: {
    format?: SessionExportFormat;
    options?: SessionExportOptions | null;
  },
): boolean {
  if (!messages || messages.length === 0) return true;

  const format = opts?.format ?? "markdown";
  const defaults = defaultSessionExportOptions(format);
  const o = opts?.options ?? {};
  // Explicit option wins; otherwise format defaults (json opt-in tools/thoughts).
  const includeThoughts =
    o.includeThoughts !== undefined
      ? !!o.includeThoughts
      : defaults.includeThoughts;
  const includeToolSummary =
    o.includeToolSummary !== undefined
      ? !!o.includeToolSummary
      : defaults.includeToolSummary;

  for (const m of messages) {
    if (isToolish(m)) {
      if (!includeToolSummary) continue;
      // JSON surfaces tools as assistant `[tool] …` only when opted in.
      const line = formatToolSummaryLine((m.content || "").trim(), m.marker);
      if (line) return false;
      continue;
    }

    const body = (m.content || "").trim();
    const thought = (m.thought || "").trim();

    if (format === "json") {
      const role = normalizeRole(m.role);
      if (role === "other") continue;
      if (body) return false;
      // JSON export skips empty content even when thought is present.
      continue;
    }

    if (body) return false;
    if (includeThoughts && thought) return false;
  }

  return true;
}

/**
 * Approximate UTF-8 byte length of a string (for size class only).
 * Prefer `TextEncoder` when available; fall back to code-unit length.
 */
export function estimateUtf8ByteLength(text: string | null | undefined): number {
  if (text == null || text === "") return 0;
  if (typeof TextEncoder !== "undefined") {
    try {
      return new TextEncoder().encode(text).length;
    } catch {
      /* fall through */
    }
  }
  // Rough multi-byte-aware fallback without TextEncoder.
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 0x7f) n += 1;
    else if (c <= 0x7ff) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // surrogate pair → 4 bytes
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

/**
 * Map a byte length to a coarse size class.
 * Negative / non-finite → empty (never invent "large").
 */
export function sessionExportSizeClass(
  byteLength: number | null | undefined,
): SessionExportSizeClass {
  const n = Number(byteLength);
  if (!Number.isFinite(n) || n <= SESSION_EXPORT_SIZE_THRESHOLDS.empty) {
    return "empty";
  }
  if (n < SESSION_EXPORT_SIZE_THRESHOLDS.tiny) return "tiny";
  if (n < SESSION_EXPORT_SIZE_THRESHOLDS.small) return "small";
  if (n < SESSION_EXPORT_SIZE_THRESHOLDS.medium) return "medium";
  if (n < SESSION_EXPORT_SIZE_THRESHOLDS.large) return "large";
  return "huge";
}

/** i18n key for a size-class chip (`session.exportSize.tiny`, …). */
export function sessionExportSizeClassLabelKey(
  cls: SessionExportSizeClass,
): string {
  return `session.exportSize.${cls}`;
}

/**
 * Estimate size class from an already-rendered export body.
 * Does not parse the journal — use when content is already in hand.
 */
export function estimateSessionExportSizeClass(
  body: string | null | undefined,
): {
  byteLength: number;
  sizeClass: SessionExportSizeClass;
  empty: boolean;
} {
  const byteLength = estimateUtf8ByteLength(body);
  const sizeClass = sessionExportSizeClass(byteLength);
  return {
    byteLength,
    sizeClass,
    empty: sizeClass === "empty",
  };
}

/**
 * Classify a thrown value / host error into a stable soft-fail kind.
 * Prefer explicit `code` over free-form text. Never invents success.
 */
export function classifySessionExportError(
  err: unknown,
): SessionExportSoftFailKind {
  if (err == null || err === "") return "other";

  const code = errCode(err);
  if (code === "empty" || code === "empty_journal" || code === "empty-session") {
    return "empty";
  }
  if (code === "no_target" || code === "no-target" || code === "no_session") {
    return "no_target";
  }
  if (
    code === "write_failed" ||
    code === "write-failed" ||
    code === "save_failed" ||
    code === "save-failed"
  ) {
    return "write_failed";
  }
  if (
    code === "load_failed" ||
    code === "load-failed" ||
    code === "messages_failed"
  ) {
    return "load_failed";
  }
  if (code === "clipboard" || code === "clipboard_failed") return "clipboard";
  if (code === "cancelled" || code === "cancel" || code === "user_cancelled") {
    return "cancelled";
  }

  const s = errText(err).toLowerCase();
  if (!s.trim()) return "other";

  if (
    /\bcancel(led)?\b/.test(s) ||
    s.includes("user cancelled") ||
    s.includes("user canceled") ||
    s.includes("dismissed")
  ) {
    return "cancelled";
  }

  const msgOnly =
    err instanceof Error ? (err.message || "").trim().toLowerCase() : "";
  if (
    msgOnly === "empty" ||
    s.trim() === "empty" ||
    s.trim() === "error: empty" ||
    s.trim() === "empty error" ||
    /^empty(\s+error)?$/i.test(s.trim()) ||
    s.includes("nothing to export") ||
    s.includes("empty journal") ||
    s.includes("empty session") ||
    s.includes("no content to export")
  ) {
    return "empty";
  }

  if (
    s.includes("no target") ||
    s.includes("no_target") ||
    s.includes("no session") ||
    s.includes("no conversation")
  ) {
    return "no_target";
  }

  if (
    s.includes("clipboard") ||
    s.includes("write text") ||
    s.includes("copy failed")
  ) {
    return "clipboard";
  }

  if (
    s.includes("session not found") ||
    s.includes("load messages") ||
    s.includes("failed to load") ||
    s.includes("sessionmessages")
  ) {
    return "load_failed";
  }

  if (
    s.includes("write failed") ||
    s.includes("save failed") ||
    s.includes("could not save") ||
    s.includes("disk full") ||
    s.includes("enospc") ||
    s.includes("eacces") ||
    s.includes("permission denied")
  ) {
    return "write_failed";
  }

  return "other";
}

/** i18n message key for a classified soft-fail (never invent success). */
export function sessionExportSoftFailMessageKey(
  kind: SessionExportSoftFailKind,
): string {
  switch (kind) {
    case "empty":
      return "session.exportEmpty";
    case "no_target":
      return "session.exportNoTarget";
    case "write_failed":
      return "session.exportWriteFail";
    case "load_failed":
      return "session.exportLoadFail";
    case "clipboard":
      return "session.exportClipboardFail";
    case "cancelled":
      return "session.exportCancelled";
    case "other":
    default:
      return "session.exportFail";
  }
}

/** Cancelled native dialogs should not toast as a failure. */
export function sessionExportSoftFailSilent(
  kind: SessionExportSoftFailKind,
): boolean {
  return kind === "cancelled";
}

/**
 * Resolve user-facing soft-fail copy from a thrown value.
 * Returns message key + whether to stay silent (cancelled).
 */
export function resolveSessionExportSoftFail(err: unknown): {
  kind: SessionExportSoftFailKind;
  messageKey: string;
  silent: boolean;
  /** Short technical detail for debug suffix (empty when not useful). */
  detail: string;
} {
  const kind = classifySessionExportError(err);
  const messageKey = sessionExportSoftFailMessageKey(kind);
  const silent = sessionExportSoftFailSilent(kind);
  const raw = errText(err).trim();
  let detail = "";
  if (
    kind === "other" &&
    raw &&
    !/^error:\s*$/i.test(raw) &&
    raw.length < 200
  ) {
    detail = raw.replace(/^Error:\s*/i, "").trim();
  }
  return { kind, messageKey, silent, detail };
}

/**
 * Sanitize a free-form session title into a filesystem-safe slug fragment.
 * Strips path separators, control chars, reserved punctuation; collapses
 * whitespace to `-`; clamps length. Empty → `"session"`.
 */
export function sanitizeSessionExportSlug(
  title: string | null | undefined,
  maxLen = 48,
): string {
  const cap = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : 48;
  let s = typeof title === "string" ? title : "";
  // Normalize Unicode + strip C0 / C1 controls and DEL.
  s = s.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  // Path / URL separators and Windows-reserved characters.
  s = s.replace(/[\\/:*?"<>|]+/g, "-");
  s = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, cap)
    .replace(/^-+|-+$/g, "");
  // Windows reserved device names (basename only).
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) {
    s = `session-${s}`;
  }
  return s || "session";
}

/**
 * Safe download basename (no extension) from title + optional session id.
 * Aligns with historical `grok-{slug}-{id8}` naming.
 */
export function sanitizeSessionExportBasename(
  title: string | null | undefined,
  sessionId?: string | null,
  maxSlugLen = 48,
): string {
  const slug = sanitizeSessionExportSlug(title, maxSlugLen);
  const id = (sessionId || "").trim().slice(0, 8);
  return id ? `aiko-${slug}-${id}` : `aiko-${slug}`;
}

/**
 * Safe download filename for a format after slug sanitize.
 * Prefer this over raw titles when building download attributes.
 */
export function sessionExportSafeFilename(
  format: SessionExportFormat,
  title: string | null | undefined,
  sessionId?: string | null,
): string {
  // sessionExportFilenameFor already slugifies; re-run through sanitize so
  // path separators / control chars never leak even if the core helper changes.
  const safeTitle = sanitizeSessionExportSlug(title);
  return sessionExportFilenameFor(format, safeTitle, sessionId);
}

/**
 * Whether text-format export actions may run.
 * `journalEmpty === true` disables; `null`/`undefined` means unknown (allow
 * attempt — load path will soft-fail empty). Busy alone does not invent content.
 */
export function canSessionExportActions(input: {
  hasTarget: boolean;
  /** true = known empty journal; false = has content; null/undefined = unknown */
  journalEmpty?: boolean | null;
  busy?: boolean;
}): boolean {
  if (!input.hasTarget) return false;
  if (input.journalEmpty === true) return false;
  if (input.busy) return false;
  return true;
}

export type SessionExportFormatRow = {
  format: SessionExportFormat;
  labelKey: string;
  nameKey: string;
  ext: string;
  disabled: boolean;
  /** i18n key explaining why the row is disabled (null when enabled). */
  disabledReasonKey: string | null;
};

/**
 * Build honest format-picker / submenu rows for md/txt/json/html.
 * Empty journal → all transcript formats disabled with empty reason.
 * Missing target → disabled with no-target reason.
 */
export function buildSessionExportFormatRows(input?: {
  hasTarget?: boolean;
  journalEmpty?: boolean | null;
  busy?: boolean;
}): SessionExportFormatRow[] {
  const hasTarget = input?.hasTarget !== false;
  const journalEmpty = input?.journalEmpty === true;
  const busy = input?.busy === true;

  return SESSION_EXPORT_FORMATS.map((format) => {
    let disabled = false;
    let disabledReasonKey: string | null = null;
    if (!hasTarget) {
      disabled = true;
      disabledReasonKey = "session.exportNoTarget";
    } else if (journalEmpty) {
      disabled = true;
      disabledReasonKey = "session.exportEmpty";
    } else if (busy) {
      disabled = true;
      disabledReasonKey = "session.exportMdWorking";
    }
    return {
      format,
      labelKey: sessionExportFormatLabelKey(format),
      nameKey: sessionExportFormatNameKey(format),
      ext: sessionExportFormatExt(format),
      disabled,
      disabledReasonKey,
    };
  });
}

/**
 * Human-readable byte label for estimated export size (meta chip).
 * Returns null for empty / invalid so UI never shows “0 B” as success.
 */
export function formatSessionExportBytes(
  n: number | null | undefined,
): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${Math.floor(n)} B`;
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
