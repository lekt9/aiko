/**
 * Per-project composer draft memory (localStorage).
 *
 * One buffer per project (and one for orphan / “其他会话”) so a user can
 * half-type a new-task prompt, switch chats, then restore via new chat.
 * Does not replace session follow-up state — only the new-chat page loads it.
 */

import type { Attachment } from "@/lib/attachments";
import { isDraftEmpty, parseStoredContent } from "@/lib/draftDoc";

export const COMPOSER_PROJECT_DRAFTS_STORAGE_KEY = "aiko.composerProjectDrafts";

/** Key for chats with no project (sidebar “其他会话”). */
export const ORPHAN_PROJECT_DRAFT_KEY = "__orphan__";

export type ComposerProjectDraft = {
  text: string;
  attachments: Attachment[];
  goalMode?: boolean;
  updatedAt: number;
};

/** Minimal storage surface for unit tests without jsdom. */
export interface ComposerProjectDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultStorage(): ComposerProjectDraftStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

/** Map project id → storage key; empty / null → orphan. */
export function projectDraftKey(
  projectId: string | null | undefined,
): string {
  const id = (projectId ?? "").trim();
  return id || ORPHAN_PROJECT_DRAFT_KEY;
}

export function emptyComposerProjectDraft(): ComposerProjectDraft {
  return { text: "", attachments: [], goalMode: false, updatedAt: 0 };
}

export function isComposerProjectDraftEmpty(
  draft: ComposerProjectDraft | null | undefined,
): boolean {
  if (!draft) return true;
  if (draft.attachments?.length) return false;
  return isDraftEmpty(parseStoredContent(draft.text || ""));
}

function normalizeAttachment(raw: unknown): Attachment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const path = typeof o.path === "string" ? o.path.trim() : "";
  if (!path) return null;
  const name =
    typeof o.name === "string" && o.name.trim()
      ? o.name.trim()
      : path.split(/[/\\]/).pop() || path;
  return { path, name, isDir: !!o.isDir };
}

function normalizeDraft(raw: unknown): ComposerProjectDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text : "";
  const attsRaw = Array.isArray(o.attachments) ? o.attachments : [];
  const attachments = attsRaw
    .map(normalizeAttachment)
    .filter((a): a is Attachment => !!a);
  const updatedAt =
    typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt)
      ? o.updatedAt
      : 0;
  const goalMode = o.goalMode === true;
  return { text, attachments, goalMode, updatedAt };
}

/** Load full map (invalid JSON → {}). */
export function loadAllComposerProjectDrafts(
  storage: ComposerProjectDraftStorage = defaultStorage(),
): Record<string, ComposerProjectDraft> {
  try {
    const raw = storage.getItem(COMPOSER_PROJECT_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, ComposerProjectDraft> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const key = (k || "").trim();
      if (!key) continue;
      const d = normalizeDraft(v);
      if (d && !isComposerProjectDraftEmpty(d)) out[key] = d;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadComposerProjectDraft(
  key: string,
  storage: ComposerProjectDraftStorage = defaultStorage(),
): ComposerProjectDraft | null {
  const k = projectDraftKey(key === ORPHAN_PROJECT_DRAFT_KEY ? null : key);
  // Allow callers to pass already-normalized orphan key.
  const map = loadAllComposerProjectDrafts(storage);
  const direct = map[key] ?? map[k] ?? null;
  return direct && !isComposerProjectDraftEmpty(direct) ? direct : null;
}

export function saveComposerProjectDraft(
  key: string,
  draft: {
    text: string;
    attachments?: Attachment[];
    goalMode?: boolean;
  },
  storage: ComposerProjectDraftStorage = defaultStorage(),
): void {
  const k = key.trim() || ORPHAN_PROJECT_DRAFT_KEY;
  const next: ComposerProjectDraft = {
    text: draft.text ?? "",
    attachments: (draft.attachments ?? [])
      .map((a) => normalizeAttachment(a))
      .filter((a): a is Attachment => !!a),
    goalMode: !!draft.goalMode,
    updatedAt: Date.now(),
  };

  try {
    const map = loadAllComposerProjectDrafts(storage);
    if (isComposerProjectDraftEmpty(next)) {
      delete map[k];
    } else {
      map[k] = next;
    }
    // Cap entries so a long-lived profile cannot grow forever.
    const keys = Object.keys(map);
    const MAX = 80;
    if (keys.length > MAX) {
      const sorted = keys
        .map((id) => ({ id, t: map[id]?.updatedAt ?? 0 }))
        .sort((a, b) => a.t - b.t);
      for (let i = 0; i < sorted.length - MAX; i++) {
        delete map[sorted[i]!.id];
      }
    }
    storage.setItem(COMPOSER_PROJECT_DRAFTS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota */
  }
}

export function clearComposerProjectDraft(
  key: string,
  storage: ComposerProjectDraftStorage = defaultStorage(),
): void {
  saveComposerProjectDraft(key, { text: "", attachments: [] }, storage);
}
