/**
 * User preference for default line-wrap on chat markdown code blocks.
 * Per-block toggle still works independently; this only sets the initial state.
 */

export const CODE_WRAP_PREF_KEY = "aiko.codeWrapDefault";

/** Dispatched on `window` after a successful save (detail = new pref). */
export const CODE_WRAP_PREF_EVENT = "aiko:codeWrapPref";

/** `true` = wrap lines by default; `false` = horizontal scroll (no wrap). */
export type CodeWrapPref = boolean;

export function loadCodeWrapPref(
  storage: Storage = localStorage,
): CodeWrapPref {
  try {
    const v = storage.getItem(CODE_WRAP_PREF_KEY);
    if (v === "1" || v === "true" || v === "wrap") return true;
    if (v === "0" || v === "false" || v === "scroll") return false;
  } catch {
    /* private mode */
  }
  // Default: no wrap (current CodeBlock behavior).
  return false;
}

export function saveCodeWrapPref(
  pref: CodeWrapPref,
  storage: Storage = localStorage,
): void {
  try {
    storage.setItem(CODE_WRAP_PREF_KEY, pref ? "wrap" : "scroll");
  } catch {
    /* ignore */
  }
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(CODE_WRAP_PREF_EVENT, { detail: pref }),
      );
    }
  } catch {
    /* ignore */
  }
}
