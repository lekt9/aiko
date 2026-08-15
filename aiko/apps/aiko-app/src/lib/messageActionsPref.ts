/**
 * Message action button visibility (Appearance).
 * localStorage-only — no Rust AppSettings (avoids prefs schema conflicts).
 * Applied via `data-msg-actions` on `document.documentElement`.
 *
 * - `hover` (default): show on hover / focus-within (existing CSS)
 * - `always`: keep Copy / Export / Regenerate / Edit visible
 */

export type MessageActionsVisibility = "hover" | "always";

export const MESSAGE_ACTIONS_VISIBILITY_STORAGE_KEY =
  "aiko.messageActionsVisibility";
export const DEFAULT_MESSAGE_ACTIONS_VISIBILITY: MessageActionsVisibility =
  "hover";
export const MESSAGE_ACTIONS_VISIBILITY_ATTR = "data-msg-actions";
/** Optional window event after save/apply (detail = preference). */
export const MESSAGE_ACTIONS_VISIBILITY_EVENT =
  "aiko-message-actions-visibility";

export const MESSAGE_ACTIONS_VISIBILITIES: readonly MessageActionsVisibility[] =
  ["hover", "always"] as const;

export interface MessageActionsPrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isMessageActionsVisibility(
  value: unknown,
): value is MessageActionsVisibility {
  return value === "hover" || value === "always";
}

export function parseMessageActionsVisibility(
  raw: unknown,
): MessageActionsVisibility {
  if (typeof raw === "string" && isMessageActionsVisibility(raw)) return raw;
  return DEFAULT_MESSAGE_ACTIONS_VISIBILITY;
}

export function loadMessageActionsVisibility(
  storage: MessageActionsPrefStorage = typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {} },
): MessageActionsVisibility {
  try {
    return parseMessageActionsVisibility(
      storage.getItem(MESSAGE_ACTIONS_VISIBILITY_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_MESSAGE_ACTIONS_VISIBILITY;
  }
}

export function saveMessageActionsVisibility(
  pref: MessageActionsVisibility,
  storage: MessageActionsPrefStorage = typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {} },
): void {
  try {
    storage.setItem(MESSAGE_ACTIONS_VISIBILITY_STORAGE_KEY, pref);
  } catch {
    /* private mode / quota */
  }
}

/** Minimal DOM surface so unit tests need no jsdom. */
export interface MessageActionsPrefRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute?(name: string): void;
}

/**
 * Apply visibility to document via `data-msg-actions`.
 * CSS: `html[data-msg-actions="always"] .lobe-chat-item__actions { … }`.
 * Missing attribute or `"hover"` keeps the default hover/focus-within rules.
 */
export function applyMessageActionsVisibility(
  pref: MessageActionsVisibility,
  root: MessageActionsPrefRoot = typeof document !== "undefined"
    ? document.documentElement
    : { setAttribute: () => {} },
): void {
  root.setAttribute(MESSAGE_ACTIONS_VISIBILITY_ATTR, pref);
}

/** Fire optional change event for listeners (no-op outside browser). */
export function dispatchMessageActionsVisibilityChange(
  pref: MessageActionsVisibility,
): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(MESSAGE_ACTIONS_VISIBILITY_EVENT, { detail: pref }),
    );
  } catch {
    /* ignore */
  }
}

/** Persist + apply (+ optional event) in one step (Settings onChange). */
export function setMessageActionsVisibility(
  pref: MessageActionsVisibility,
  storage?: MessageActionsPrefStorage,
  root?: MessageActionsPrefRoot,
): void {
  saveMessageActionsVisibility(pref, storage);
  applyMessageActionsVisibility(pref, root);
  dispatchMessageActionsVisibilityChange(pref);
}
