/**
 * Reliability / Observability center — pure assembly of long-task signals.
 *
 * Aggregates busy sessions, stall / end-of-turn stall signals, and recent
 * error-deck entries from App/host state. No log scraping, no secrets.
 */

import {
  collectActivitySessions,
  type ActivitySessionRow,
  type SessionTitleLookup,
} from "./agentActivity";
import type { EndOfTurnReason } from "./endOfTurn";
import { redact } from "./redact";
import type { SessionLiveMap } from "./sessionLiveStore";

export type ReliabilityBusySession = {
  sessionId: string;
  title: string;
  status: ActivitySessionRow["status"];
  liveToolTitle: string | null;
  isCurrent: boolean;
  updatedAt: number;
};

/** Soft / hard stall or end-of-turn stall observed in UI state. */
export type ReliabilityStallKind =
  | "active"
  | "hard_end"
  | "terminal"
  | "end_of_turn";

export type ReliabilityStallSignal = {
  id: string;
  sessionId: string | null;
  title: string | null;
  kind: ReliabilityStallKind;
  stallSeconds: number | null;
  tier: string | null;
  /** Host/end-of-turn reason when known (e.g. stall). */
  reason: string | null;
  at: number;
};

export type ReliabilityErrorEntry = {
  id: string;
  code: string | null;
  /** Deck problem headline (already localized by caller when from deck). */
  problem: string;
  cause: string | null;
  sessionId: string | null;
  title: string | null;
  at: number;
  source: "session" | "local" | "deck";
};

export type ReliabilityCenterView = {
  busy: {
    count: number;
    sessions: ReliabilityBusySession[];
  };
  stalls: {
    count: number;
    signals: ReliabilityStallSignal[];
  };
  errors: {
    count: number;
    entries: ReliabilityErrorEntry[];
  };
  /** True when every card would be empty. */
  empty: boolean;
  hasBusy: boolean;
  hasStalls: boolean;
  hasErrors: boolean;
};

export const DEFAULT_RELIABILITY_MAX_BUSY = 12;
export const DEFAULT_RELIABILITY_MAX_STALLS = 8;
export const DEFAULT_RELIABILITY_MAX_ERRORS = 8;

/** Prepend an item into a capped ring (newest first). Drops exact id matches. */
export function prependReliabilityRing<T extends { id: string }>(
  list: readonly T[],
  item: T,
  max: number,
): T[] {
  const cap = Math.max(0, Math.floor(max));
  if (cap === 0) return [];
  const rest = list.filter((x) => x.id !== item.id);
  return [item, ...rest].slice(0, cap);
}

function busyFromActivity(row: ActivitySessionRow): ReliabilityBusySession {
  return {
    sessionId: row.sessionId,
    title: row.title,
    status: row.status,
    liveToolTitle: row.liveToolTitle,
    isCurrent: row.isCurrent,
    updatedAt: row.updatedAt,
  };
}

/**
 * Collect busy / connecting / permission sessions for the Reliability panel.
 * Reuses Tasks-panel activity rules.
 */
export function collectReliabilityBusySessions(opts: {
  liveMap: SessionLiveMap;
  sessions: SessionTitleLookup[];
  currentSessionId?: string | null;
  untitledLabel?: string;
  max?: number;
}): ReliabilityBusySession[] {
  const max = opts.max ?? DEFAULT_RELIABILITY_MAX_BUSY;
  return collectActivitySessions({
    liveMap: opts.liveMap,
    sessions: opts.sessions,
    currentSessionId: opts.currentSessionId,
    untitledLabel: opts.untitledLabel,
  })
    .map(busyFromActivity)
    .slice(0, Math.max(0, max));
}

function titleFor(
  sessionId: string | null | undefined,
  titleById: Map<string, string>,
  untitled: string,
): string | null {
  if (!sessionId) return null;
  return titleById.get(sessionId) || untitled;
}

/**
 * Stall signals currently visible in liveMap (terminalReason) plus optional
 * active soft-stall prompt. Does not invent history.
 */
export function collectLiveStallSignals(opts: {
  liveMap: SessionLiveMap;
  sessions: SessionTitleLookup[];
  untitledLabel?: string;
  activeStreamStall?: {
    sessionId?: string;
    stallSeconds: number;
    tier?: string;
    sawModelOutput?: boolean;
    sawToolActivity?: boolean;
  } | null;
  nowMs?: number;
}): ReliabilityStallSignal[] {
  const now = opts.nowMs ?? Date.now();
  const untitled = opts.untitledLabel || "Untitled";
  const titleById = new Map<string, string>();
  for (const s of opts.sessions) {
    const t = (s.title || "").trim();
    if (t) titleById.set(s.id, t);
  }

  const out: ReliabilityStallSignal[] = [];
  const seen = new Set<string>();

  const active = opts.activeStreamStall;
  if (active && active.stallSeconds > 0) {
    const sid = active.sessionId ?? null;
    const id = `active:${sid ?? "unknown"}:${active.stallSeconds}`;
    seen.add(id);
    out.push({
      id,
      sessionId: sid,
      title: titleFor(sid, titleById, untitled),
      kind: "active",
      stallSeconds: Math.round(active.stallSeconds),
      tier: active.tier ?? null,
      reason: "stall",
      at: now,
    });
  }

  for (const snap of Object.values(opts.liveMap)) {
    const reason = snap.terminalReason;
    if (!isStallTerminalReason(reason)) continue;
    const id = `terminal:${snap.sessionId}:${reason}:${snap.updatedAt}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      sessionId: snap.sessionId,
      title: titleFor(snap.sessionId, titleById, untitled),
      kind: "terminal",
      stallSeconds: null,
      tier: null,
      reason,
      at: snap.updatedAt || now,
    });
  }

  out.sort((a, b) => b.at - a.at);
  return out;
}

function isStallTerminalReason(
  reason: EndOfTurnReason | null | undefined,
): reason is "stall" {
  return reason === "stall";
}

/**
 * Merge live stall signals with a recent ring (hard_end / prior active).
 * Live wins order first; ring fills remaining slots without id duplicates.
 */
export function mergeStallSignals(
  live: readonly ReliabilityStallSignal[],
  recent: readonly ReliabilityStallSignal[],
  max: number = DEFAULT_RELIABILITY_MAX_STALLS,
): ReliabilityStallSignal[] {
  const cap = Math.max(0, Math.floor(max));
  if (cap === 0) return [];
  const out: ReliabilityStallSignal[] = [];
  const seen = new Set<string>();
  // Soft-dedupe: same session + kind within a short window counts once.
  const softKey = (s: ReliabilityStallSignal) =>
    `${s.kind}|${s.sessionId ?? ""}|${s.reason ?? ""}`;

  for (const s of [...live, ...recent]) {
    if (seen.has(s.id)) continue;
    // Prefer keeping the first (live-first) soft match.
    const sk = softKey(s);
    if ([...out].some((x) => softKey(x) === sk && x.kind === s.kind)) {
      // Allow multiple hard_end over time; skip only identical soft active/terminal dupes.
      if (s.kind === "active" || s.kind === "terminal") continue;
    }
    seen.add(s.id);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Merge current banner-shaped error with a recent ring.
 * Newest first; drop exact id matches; soft-dedupe same code+problem.
 */
export function mergeErrorEntries(
  current: readonly ReliabilityErrorEntry[],
  recent: readonly ReliabilityErrorEntry[],
  max: number = DEFAULT_RELIABILITY_MAX_ERRORS,
): ReliabilityErrorEntry[] {
  const cap = Math.max(0, Math.floor(max));
  if (cap === 0) return [];
  const out: ReliabilityErrorEntry[] = [];
  const seenIds = new Set<string>();
  const soft = new Set<string>();

  for (const e of [...current, ...recent]) {
    if (seenIds.has(e.id)) continue;
    const sk = `${e.code ?? ""}|${e.problem}`;
    if (soft.has(sk)) continue;
    seenIds.add(e.id);
    soft.add(sk);
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

/** Build a ring-friendly error entry from a deck-style banner. */
export function reliabilityErrorFromDeck(opts: {
  code?: string | null;
  problem: string;
  cause?: string | null;
  sessionId?: string | null;
  title?: string | null;
  source?: ReliabilityErrorEntry["source"];
  at?: number;
  /** Stable id for ring replace; default is code+problem (no timestamp). */
  id?: string;
}): ReliabilityErrorEntry {
  const at = opts.at ?? Date.now();
  const code = opts.code ?? null;
  const problem = (opts.problem || "").trim() || "Error";
  return {
    id:
      opts.id ??
      `err:${code ?? "generic"}:${problem.slice(0, 64)}`,
    code,
    problem,
    cause: opts.cause?.trim() || null,
    sessionId: opts.sessionId ?? null,
    title: opts.title ?? null,
    at,
    source: opts.source ?? "deck",
  };
}

/** Build a ring entry when Host emits stream_stall / hard_end. */
export function reliabilityStallFromEvent(opts: {
  kind: ReliabilityStallKind;
  sessionId?: string | null;
  title?: string | null;
  stallSeconds?: number | null;
  tier?: string | null;
  reason?: string | null;
  at?: number;
}): ReliabilityStallSignal {
  const at = opts.at ?? Date.now();
  const sid = opts.sessionId ?? null;
  return {
    id: `evt:${opts.kind}:${sid ?? "unknown"}:${at}`,
    sessionId: sid,
    title: opts.title ?? null,
    kind: opts.kind,
    stallSeconds:
      typeof opts.stallSeconds === "number" && opts.stallSeconds > 0
        ? Math.round(opts.stallSeconds)
        : null,
    tier: opts.tier ?? null,
    reason: opts.reason ?? "stall",
    at,
  };
}

/**
 * Assemble the Reliability center view model from already-shaped inputs.
 * Callers supply busy/stall/error lists (live + rings); this only slices and flags.
 */
export function assembleReliabilityCenter(opts: {
  busySessions?: readonly ReliabilityBusySession[];
  stallSignals?: readonly ReliabilityStallSignal[];
  errorEntries?: readonly ReliabilityErrorEntry[];
  maxBusy?: number;
  maxStalls?: number;
  maxErrors?: number;
}): ReliabilityCenterView {
  const maxBusy = opts.maxBusy ?? DEFAULT_RELIABILITY_MAX_BUSY;
  const maxStalls = opts.maxStalls ?? DEFAULT_RELIABILITY_MAX_STALLS;
  const maxErrors = opts.maxErrors ?? DEFAULT_RELIABILITY_MAX_ERRORS;

  const sessions = (opts.busySessions ?? []).slice(0, Math.max(0, maxBusy));
  const signals = (opts.stallSignals ?? []).slice(0, Math.max(0, maxStalls));
  const entries = (opts.errorEntries ?? []).slice(0, Math.max(0, maxErrors));

  const hasBusy = sessions.length > 0;
  const hasStalls = signals.length > 0;
  const hasErrors = entries.length > 0;

  return {
    busy: { count: sessions.length, sessions: [...sessions] },
    stalls: { count: signals.length, signals: [...signals] },
    errors: { count: entries.length, entries: [...entries] },
    empty: !hasBusy && !hasStalls && !hasErrors,
    hasBusy,
    hasStalls,
    hasErrors,
  };
}

/**
 * One-shot assembly from liveMap + rings + optional active stall / current error.
 * Preferred entry for App and unit tests that want full pipeline coverage.
 */
export function buildReliabilityCenter(opts: {
  liveMap: SessionLiveMap;
  sessions: SessionTitleLookup[];
  currentSessionId?: string | null;
  untitledLabel?: string;
  activeStreamStall?: {
    sessionId?: string;
    stallSeconds: number;
    tier?: string;
    sawModelOutput?: boolean;
    sawToolActivity?: boolean;
  } | null;
  recentStalls?: readonly ReliabilityStallSignal[];
  recentErrors?: readonly ReliabilityErrorEntry[];
  currentErrors?: readonly ReliabilityErrorEntry[];
  maxBusy?: number;
  maxStalls?: number;
  maxErrors?: number;
  nowMs?: number;
}): ReliabilityCenterView {
  const busySessions = collectReliabilityBusySessions({
    liveMap: opts.liveMap,
    sessions: opts.sessions,
    currentSessionId: opts.currentSessionId,
    untitledLabel: opts.untitledLabel,
    max: opts.maxBusy,
  });

  const liveStalls = collectLiveStallSignals({
    liveMap: opts.liveMap,
    sessions: opts.sessions,
    untitledLabel: opts.untitledLabel,
    activeStreamStall: opts.activeStreamStall,
    nowMs: opts.nowMs,
  });

  const stallSignals = mergeStallSignals(
    liveStalls,
    opts.recentStalls ?? [],
    opts.maxStalls ?? DEFAULT_RELIABILITY_MAX_STALLS,
  );

  const errorEntries = mergeErrorEntries(
    opts.currentErrors ?? [],
    opts.recentErrors ?? [],
    opts.maxErrors ?? DEFAULT_RELIABILITY_MAX_ERRORS,
  );

  return assembleReliabilityCenter({
    busySessions,
    stallSignals,
    errorEntries,
    maxBusy: opts.maxBusy,
    maxStalls: opts.maxStalls,
    maxErrors: opts.maxErrors,
  });
}

/* ── Stall timeline history (localStorage ring) ─────────────────────────── */

/**
 * Persisted stall timeline row. Subset of {@link ReliabilityStallSignal}
 * without `tier` — ids/titles/reasons only; never secrets or log bodies.
 */
export type StallHistoryEntry = {
  id: string;
  sessionId: string | null;
  title: string | null;
  kind: ReliabilityStallKind;
  stallSeconds: number | null;
  reason: string | null;
  /** Epoch ms. */
  at: number;
};

export const STALL_HISTORY_STORAGE_KEY = "aiko.stallHistory";
/** Cap for historical stall signals (localStorage ring, newest first). */
export const STALL_HISTORY_MAX = 40;
/** Cap stored title length — no multi-kb blobs. */
export const STALL_HISTORY_TITLE_MAX = 200;
/** Cap stored reason string. */
export const STALL_HISTORY_REASON_MAX = 120;

/** Fired on `window` after record / clear (detail = entries). */
export const STALL_HISTORY_CHANGE_EVENT = "aiko-stall-history-change";

const STALL_KINDS = new Set<ReliabilityStallKind>([
  "active",
  "hard_end",
  "terminal",
  "end_of_turn",
]);

/** Minimal storage surface so unit tests need no jsdom. */
export interface StallHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStallHistoryStorage(): StallHistoryStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  return { getItem: () => null, setItem: () => {} };
}

function notifyStallHistoryChange(entries: StallHistoryEntry[]): void {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    try {
      window.dispatchEvent(
        new CustomEvent(STALL_HISTORY_CHANGE_EVENT, { detail: entries }),
      );
    } catch {
      /* ignore */
    }
  }
}

function capTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\u0000/g, "").trim();
  if (!t) return null;
  return t.slice(0, STALL_HISTORY_TITLE_MAX);
}

function capReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\u0000/g, "").trim();
  if (!t) return null;
  return t.slice(0, STALL_HISTORY_REASON_MAX);
}

function parseAtMs(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Date.parse(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum >= 0) return Math.floor(asNum);
  }
  return fallback;
}

/**
 * Normalize one raw object into a StallHistoryEntry, or null if invalid.
 * Only known fields; drops unknown keys that could carry secrets.
 */
export function parseStallHistoryEntry(raw: unknown): StallHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const kindRaw = typeof o.kind === "string" ? o.kind.trim() : "";
  if (!STALL_KINDS.has(kindRaw as ReliabilityStallKind)) return null;
  const kind = kindRaw as ReliabilityStallKind;

  const at = parseAtMs(o.at, 0);
  const sidRaw = o.sessionId;
  const sessionId =
    typeof sidRaw === "string"
      ? sidRaw.trim() || null
      : sidRaw == null
        ? null
        : null;

  const idRaw = typeof o.id === "string" ? o.id.trim() : "";
  const id =
    idRaw ||
    (kind === "active"
      ? `hist:active:${sessionId ?? "unknown"}`
      : `hist:${kind}:${sessionId ?? "unknown"}:${at || 0}`);

  let stallSeconds: number | null = null;
  if (typeof o.stallSeconds === "number" && Number.isFinite(o.stallSeconds)) {
    const n = Math.round(o.stallSeconds);
    if (n > 0) stallSeconds = n;
  }

  return {
    id,
    sessionId,
    title: capTitle(o.title),
    kind,
    stallSeconds,
    reason: capReason(o.reason) ?? "stall",
    at: at || 0,
  };
}

/**
 * Parse stored JSON into a clean, newest-first list (capped).
 * Tolerates corrupt / partial data.
 */
export function parseStallHistory(
  raw: unknown,
  max: number = STALL_HISTORY_MAX,
): StallHistoryEntry[] {
  let list: unknown[] = [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    return [];
  }

  const out: StallHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const e = parseStallHistoryEntry(item);
    if (!e) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
    if (out.length >= Math.max(0, Math.floor(max))) break;
  }
  return out;
}

export function loadStallHistory(
  storage: StallHistoryStorage = defaultStallHistoryStorage(),
  max: number = STALL_HISTORY_MAX,
): StallHistoryEntry[] {
  try {
    return parseStallHistory(
      storage.getItem(STALL_HISTORY_STORAGE_KEY),
      max,
    );
  } catch {
    /* private mode */
    return [];
  }
}

export function saveStallHistory(
  entries: readonly StallHistoryEntry[],
  storage: StallHistoryStorage = defaultStallHistoryStorage(),
  max: number = STALL_HISTORY_MAX,
): void {
  const clean = parseStallHistory(entries, max);
  try {
    storage.setItem(STALL_HISTORY_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    /* private mode / quota */
  }
}

/**
 * Pure ring push: newest first, max length, replace exact id.
 * Soft-active rows share a stable id so repeated soft stalls update in place.
 */
export function pushStallHistory(
  existing: readonly StallHistoryEntry[],
  entry: StallHistoryEntry,
  max: number = STALL_HISTORY_MAX,
): StallHistoryEntry[] {
  const next = parseStallHistoryEntry(entry);
  if (!next) return parseStallHistory(existing, max);
  return prependReliabilityRing(
    parseStallHistory(existing, max),
    next,
    max,
  );
}

/**
 * Record a stall signal into the localStorage ring.
 * Never stores secrets — only id, sessionId, title, kind, stallSeconds, reason, at.
 * Soft `active` stalls use a stable per-session id so the ring is not flooded.
 */
export function recordStallHistory(
  input: {
    id?: string;
    sessionId?: string | null;
    title?: string | null;
    kind: ReliabilityStallKind;
    stallSeconds?: number | null;
    reason?: string | null;
    at?: number;
  },
  storage: StallHistoryStorage = defaultStallHistoryStorage(),
  max: number = STALL_HISTORY_MAX,
): StallHistoryEntry[] {
  if (!STALL_KINDS.has(input.kind)) {
    return loadStallHistory(storage, max);
  }
  const at =
    typeof input.at === "number" && Number.isFinite(input.at)
      ? Math.floor(input.at)
      : Date.now();
  const sessionId =
    typeof input.sessionId === "string"
      ? input.sessionId.trim() || null
      : input.sessionId ?? null;

  const id =
    (typeof input.id === "string" && input.id.trim()) ||
    (input.kind === "active"
      ? `hist:active:${sessionId ?? "unknown"}`
      : `hist:${input.kind}:${sessionId ?? "unknown"}:${at}`);

  const entry = parseStallHistoryEntry({
    id,
    sessionId,
    title: input.title ?? null,
    kind: input.kind,
    stallSeconds: input.stallSeconds ?? null,
    reason: input.reason ?? "stall",
    at,
  });
  if (!entry) return loadStallHistory(storage, max);

  const next = pushStallHistory(loadStallHistory(storage, max), entry, max);
  saveStallHistory(next, storage, max);
  notifyStallHistoryChange(next);
  return next;
}

/**
 * Record from an existing in-memory reliability stall signal.
 * Strips `tier` and re-ids soft-active rows for stable ring replace.
 */
export function recordStallHistoryFromSignal(
  signal: ReliabilityStallSignal,
  storage: StallHistoryStorage = defaultStallHistoryStorage(),
  max: number = STALL_HISTORY_MAX,
): StallHistoryEntry[] {
  return recordStallHistory(
    {
      // Drop live/event ids; history uses its own stable scheme for active.
      sessionId: signal.sessionId,
      title: signal.title,
      kind: signal.kind,
      stallSeconds: signal.stallSeconds,
      reason: signal.reason,
      at: signal.at,
    },
    storage,
    max,
  );
}

/** Kind chip filter for stall history: `"all"` or a concrete kind. */
export type StallHistoryKindFilter = ReliabilityStallKind | "all";

/**
 * Filter history by free-text query and/or kind chip.
 * Empty / whitespace query matches all (still respects kind filter).
 * Query matches title, reason, kind, or session id (case-insensitive substring).
 * `kind` omitted / `"all"` / null means every kind.
 */
export function filterStallHistory(
  entries: readonly StallHistoryEntry[],
  opts?: {
    query?: string | null;
    kind?: StallHistoryKindFilter | null;
  },
): StallHistoryEntry[] {
  const q = (opts?.query ?? "").trim().toLowerCase();
  const kindFilter =
    opts?.kind && opts.kind !== "all" && STALL_KINDS.has(opts.kind)
      ? opts.kind
      : null;

  if (!q && !kindFilter) return entries.slice();

  return entries.filter((e) => {
    if (kindFilter && e.kind !== kindFilter) return false;
    if (!q) return true;
    const title = (e.title || "").toLowerCase();
    const reason = (e.reason || "").toLowerCase();
    const kind = e.kind.toLowerCase();
    const sessionId = (e.sessionId || "").toLowerCase();
    const secs =
      e.stallSeconds != null ? String(e.stallSeconds) : "";
    return (
      title.includes(q) ||
      reason.includes(q) ||
      kind.includes(q) ||
      sessionId.includes(q) ||
      secs.includes(q)
    );
  });
}

/** True when kind chip or free-text query would narrow the list. */
export function hasActiveStallHistoryFilters(opts?: {
  query?: string | null;
  kind?: StallHistoryKindFilter | null;
}): boolean {
  const q = (opts?.query ?? "").trim();
  if (q) return true;
  const kind = opts?.kind;
  return Boolean(kind && kind !== "all" && STALL_KINDS.has(kind));
}

/**
 * Pure clear-all plan for the stall history ring.
 * Never mutates storage; never includes titles/reasons in logMeta.
 */
export type ClearStallHistoryPlan = {
  ok: true;
  /** Rows that would be removed. */
  count: number;
  /** Distinct session ids present (sorted). No titles. */
  sessionIds: string[];
  /** Per-kind counts among rows being cleared. */
  kindCounts: Partial<Record<ReliabilityStallKind, number>>;
  /** Next list after clear (always empty). */
  next: StallHistoryEntry[];
  /** Safe meta for logs — count only. */
  logMeta: { clearedCount: number } | null;
};

/**
 * Plan wiping the stall history ring (pure).
 * Use {@link applyClearStallHistoryPlan} / {@link clearStallHistory} to commit.
 */
export function planClearStallHistory(
  entries: readonly StallHistoryEntry[] | null | undefined,
): ClearStallHistoryPlan {
  const list = Array.isArray(entries) ? parseStallHistory(entries) : [];
  const kindCounts: Partial<Record<ReliabilityStallKind, number>> = {};
  const sessionSet = new Set<string>();
  for (const e of list) {
    kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
    if (e.sessionId) sessionSet.add(e.sessionId);
  }
  const count = list.length;
  return {
    ok: true,
    count,
    sessionIds: [...sessionSet].sort(),
    kindCounts,
    next: [],
    logMeta: count > 0 ? { clearedCount: count } : null,
  };
}

/**
 * Apply a clear-all plan to storage and notify listeners.
 * Returns the empty list.
 */
export function applyClearStallHistoryPlan(
  plan: ClearStallHistoryPlan,
  storage: StallHistoryStorage = defaultStallHistoryStorage(),
): StallHistoryEntry[] {
  saveStallHistory(plan.next, storage);
  notifyStallHistoryChange([]);
  return [];
}

/**
 * Wipe the local stall timeline (empty list + notify listeners).
 * Returns the empty list. Safe no-op on storage failure.
 */
export function clearStallHistory(
  storage: StallHistoryStorage = defaultStallHistoryStorage(),
): StallHistoryEntry[] {
  const plan = planClearStallHistory(loadStallHistory(storage));
  return applyClearStallHistoryPlan(plan, storage);
}

/* ── Stall history export (redacted JSON download) ──────────────────────── */

/** One row in a stall-history export file (known fields only; no tier/secrets). */
export type StallHistoryExportSignal = {
  id: string;
  sessionId: string | null;
  title: string | null;
  kind: ReliabilityStallKind;
  stallSeconds: number | null;
  reason: string | null;
  at: number;
};

/**
 * Redacted stall history export (download / clipboard).
 * Structured fields only — titles/reasons re-run through {@link redact}.
 */
export type StallHistoryExport = {
  kind: "stall_history";
  generatedAt: string;
  source: "stall_timeline";
  count: number;
  /** Echo of filters used to select rows (never free-form secrets). */
  filter: {
    query: string | null;
    kind: StallHistoryKindFilter;
  };
  signals: StallHistoryExportSignal[];
};

function redactStallField(
  raw: string | null | undefined,
  max: number,
): string | null {
  if (typeof raw !== "string") return null;
  const t = redact(raw).replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.slice(0, Math.max(0, max));
}

/**
 * Build a download-ready redacted export from stall history rows.
 * Prefer filtered rows from {@link filterStallHistory}. Never invents data.
 */
export function buildStallHistoryExport(
  entries: readonly StallHistoryEntry[],
  opts?: {
    nowMs?: number;
    max?: number;
    generatedAt?: string;
    query?: string | null;
    kind?: StallHistoryKindFilter | null;
  },
): StallHistoryExport {
  const max = Math.max(
    0,
    Math.floor(opts?.max ?? STALL_HISTORY_MAX),
  );
  const generatedAt =
    opts?.generatedAt ??
    new Date(opts?.nowMs ?? Date.now()).toISOString();
  const queryRaw = (opts?.query ?? "").trim();
  const kindFilter: StallHistoryKindFilter =
    opts?.kind && opts.kind !== "all" && STALL_KINDS.has(opts.kind)
      ? opts.kind
      : "all";

  const out: StallHistoryExportSignal[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const parsed = parseStallHistoryEntry(e);
    if (!parsed) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);

    out.push({
      id: parsed.id.slice(0, STALL_HISTORY_TITLE_MAX),
      sessionId: parsed.sessionId,
      title: redactStallField(parsed.title, STALL_HISTORY_TITLE_MAX),
      kind: parsed.kind,
      stallSeconds: parsed.stallSeconds,
      reason: redactStallField(parsed.reason, STALL_HISTORY_REASON_MAX) ?? "stall",
      at: parsed.at,
    });
    if (out.length >= max) break;
  }

  return {
    kind: "stall_history",
    generatedAt,
    source: "stall_timeline",
    count: out.length,
    filter: {
      query: queryRaw ? queryRaw.slice(0, STALL_HISTORY_TITLE_MAX) : null,
      kind: kindFilter,
    },
    signals: out,
  };
}

/** Pretty JSON for client download (known fields only). */
export function serializeStallHistoryExport(
  snapshot: StallHistoryExport,
): string {
  return JSON.stringify(snapshot, null, 2);
}

/** Cap for support-bundle stall timeline rows (UI view is smaller; allow a bit more headroom). */
export const STALL_TIMELINE_SNAPSHOT_MAX = 40;
/** Cap title/reason fields so the zip never carries multi-kb blobs. */
export const STALL_TIMELINE_FIELD_MAX = 200;

/** One row in the support-bundle stall timeline (known fields only). */
export type StallTimelineSnapshotSignal = {
  id: string;
  sessionId: string | null;
  title: string | null;
  kind: ReliabilityStallKind;
  stallSeconds: number | null;
  tier: string | null;
  reason: string | null;
  at: number;
};

/**
 * Redacted stall timeline for support zip export.
 * Never includes secrets, log bodies, or free-form diagnostic dumps —
 * only structured stall fields already shown in Reliability center.
 */
export type StallTimelineSnapshot = {
  kind: "stall_timeline";
  generatedAt: string;
  source: "reliability_center";
  count: number;
  signals: StallTimelineSnapshotSignal[];
};

const STALL_TIMELINE_KINDS = new Set<ReliabilityStallKind>([
  "active",
  "hard_end",
  "terminal",
  "end_of_turn",
]);

function capStallField(raw: unknown, max: number = STALL_TIMELINE_FIELD_MAX): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\u0000/g, "").trim();
  if (!t) return null;
  return t.slice(0, Math.max(0, max));
}

/**
 * Build a support-bundle-ready stall timeline from Reliability center signals.
 * Drops unknown kinds / empty ids; caps title/reason/tier; never invents data.
 */
export function buildStallTimelineSnapshot(
  signals: readonly ReliabilityStallSignal[],
  opts?: {
    nowMs?: number;
    max?: number;
    generatedAt?: string;
  },
): StallTimelineSnapshot {
  const max = Math.max(
    0,
    Math.floor(opts?.max ?? STALL_TIMELINE_SNAPSHOT_MAX),
  );
  const generatedAt =
    opts?.generatedAt ??
    new Date(opts?.nowMs ?? Date.now()).toISOString();

  const out: StallTimelineSnapshotSignal[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    if (!s || typeof s !== "object") continue;
    const kind = s.kind;
    if (!STALL_TIMELINE_KINDS.has(kind)) continue;
    const id = typeof s.id === "string" ? s.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const sidRaw = s.sessionId;
    const sessionId =
      typeof sidRaw === "string"
        ? sidRaw.trim() || null
        : sidRaw == null
          ? null
          : null;

    let stallSeconds: number | null = null;
    if (typeof s.stallSeconds === "number" && Number.isFinite(s.stallSeconds)) {
      const n = Math.round(s.stallSeconds);
      if (n > 0) stallSeconds = n;
    }

    const at =
      typeof s.at === "number" && Number.isFinite(s.at) && s.at >= 0
        ? Math.floor(s.at)
        : 0;

    out.push({
      id: id.slice(0, STALL_TIMELINE_FIELD_MAX),
      sessionId,
      title: capStallField(s.title),
      kind,
      stallSeconds,
      tier: capStallField(s.tier, 64),
      reason: capStallField(s.reason, 120) ?? "stall",
      at,
    });
    if (out.length >= max) break;
  }

  return {
    kind: "stall_timeline",
    generatedAt,
    source: "reliability_center",
    count: out.length,
    signals: out,
  };
}

/** JSON string for Host `export_support_bundle` (pretty, known fields only). */
export function serializeStallTimelineSnapshot(
  snapshot: StallTimelineSnapshot,
): string {
  return JSON.stringify(snapshot, null, 2);
}
