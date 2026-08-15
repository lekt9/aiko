/**
 * Theme preference + resolved light/dark for the document.
 * Preference is durable (`system` | `light` | `dark`); DOM always gets a
 * concrete `data-theme="light|dark"`. Default preference is follow system.
 */

export type Theme = "dark" | "light";
/** User-facing choice including follow-OS. */
export type ThemePreference = "system" | Theme;

export const THEME_STORAGE_KEY = "aiko-app.theme";
/** Fallback when OS scheme cannot be read (tests / SSR). */
export const DEFAULT_RESOLVED_THEME: Theme = "dark";
/** New installs / empty storage → follow system. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

/** @deprecated Use DEFAULT_THEME_PREFERENCE; kept for call sites that mean "fallback resolved". */
export const DEFAULT_THEME: Theme = DEFAULT_RESOLVED_THEME;

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || isTheme(value);
}

/** Parse a stored preference; invalid / empty → system. */
export function parseThemePreference(raw: unknown): ThemePreference {
  if (typeof raw === "string" && isThemePreference(raw)) return raw;
  return DEFAULT_THEME_PREFERENCE;
}

/**
 * Parse a stored value as a concrete theme (legacy).
 * Empty → resolved system theme (or DEFAULT_RESOLVED_THEME without window).
 */
export function parseTheme(raw: unknown): Theme {
  if (typeof raw === "string" && isTheme(raw)) return raw;
  if (raw === "system" || raw == null || raw === "") {
    return getSystemTheme();
  }
  return DEFAULT_RESOLVED_THEME;
}

/** Read OS light/dark. Safe outside the browser. */
export function getSystemTheme(
  matchMedia: ((query: string) => MediaQueryList) | null = typeof window !==
  "undefined"
    ? window.matchMedia.bind(window)
    : null,
): Theme {
  try {
    if (!matchMedia) return DEFAULT_RESOLVED_THEME;
    return matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return DEFAULT_RESOLVED_THEME;
  }
}

/** Map preference → concrete theme applied to the document. */
export function resolveTheme(
  preference: ThemePreference,
  systemTheme: Theme = getSystemTheme(),
): Theme {
  if (preference === "system") return systemTheme;
  return preference;
}

export function toggleTheme(current: Theme): Theme {
  return current === "dark" ? "light" : "dark";
}

/**
 * Quick-toggle from the user menu: always land on an explicit light/dark
 * (leaves "system" mode so the click has an obvious effect).
 */
export function toggleThemePreference(
  _preference: ThemePreference,
  resolved: Theme,
): ThemePreference {
  return toggleTheme(resolved);
}

/** Apply theme to documentElement (data-theme attribute). */
export function applyThemeToDocument(
  theme: Theme,
  root: HTMLElement = document.documentElement,
): void {
  root.setAttribute("data-theme", theme);
}

/**
 * Sync Tauri / macOS native chrome (NSAppearance + vibrancy) with app theme.
 * Without this, light UI still sits on dark Sidebar vibrancy → dirty gray rail + black edges.
 *
 * Pass `null` to **follow the OS** (required for live system switching — locking
 * light/dark freezes `prefers-color-scheme` inside the WebView).
 * No-op outside Tauri.
 */
export async function applyNativeWindowTheme(
  theme: Theme | null,
): Promise<void> {
  try {
    const isTauri =
      typeof window !== "undefined" &&
      ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
    if (!isTauri) return;
    const { setTheme } = await import("@tauri-apps/api/app");
    // Tauri: null/undefined = follow system theme
    await setTheme(theme);
  } catch {
    /* permissions / older runtime — CSS still applies */
  }
}

/**
 * Apply preference end-to-end: unlock/lock native chrome, resolve system if
 * needed, write `data-theme`. When switching **to** system, native is unlocked
 * first so matchMedia reflects the real OS scheme.
 */
export async function applyThemePreference(
  preference: ThemePreference,
  options?: {
    /** Called with the concrete theme after resolve (for React state). */
    onResolved?: (resolved: Theme, system: Theme) => void;
  },
): Promise<Theme> {
  if (preference === "system") {
    // Unlock WebView appearance so prefers-color-scheme tracks the OS.
    await applyNativeWindowTheme(null);
    // matchMedia can lag one frame after native unlock — re-read twice.
    let system = getSystemTheme();
    if (typeof requestAnimationFrame === "function") {
      await new Promise<void>((r) => {
        requestAnimationFrame(() => r());
      });
      system = getSystemTheme();
    }
    applyThemeToDocument(system);
    options?.onResolved?.(system, system);
    return system;
  }
  applyThemeToDocument(preference);
  await applyNativeWindowTheme(preference);
  options?.onResolved?.(preference, getSystemTheme());
  return preference;
}

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read persisted preference (system | light | dark). */
export function loadThemePreference(storage: ThemeStorage): ThemePreference {
  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/** Persist preference (including "system"). */
export function saveThemePreference(
  storage: ThemeStorage,
  preference: ThemePreference,
): void {
  storage.setItem(THEME_STORAGE_KEY, preference);
}

/**
 * Read preference and resolve to concrete theme for first paint.
 * Prefer loadThemePreference + resolveTheme when preference is needed in UI.
 */
export function loadTheme(storage: ThemeStorage): Theme {
  return resolveTheme(loadThemePreference(storage));
}

/** Persist a concrete theme (legacy helper; prefer saveThemePreference). */
export function saveTheme(storage: ThemeStorage, theme: Theme): void {
  storage.setItem(THEME_STORAGE_KEY, theme);
}

/** Full switch: compute next concrete theme, persist as explicit light/dark, apply DOM. */
export function switchTheme(
  current: Theme,
  storage: ThemeStorage,
  root?: HTMLElement,
): Theme {
  const next = toggleTheme(current);
  saveThemePreference(storage, next);
  if (typeof document !== "undefined" || root) {
    applyThemeToDocument(next, root ?? document.documentElement);
  }
  return next;
}

/**
 * Subscribe to OS scheme changes. Returns unsubscribe.
 * No-op when matchMedia is unavailable.
 */
export function subscribeSystemTheme(
  onChange: (systemTheme: Theme) => void,
  matchMedia: ((query: string) => MediaQueryList) | null = typeof window !==
  "undefined"
    ? window.matchMedia.bind(window)
    : null,
): () => void {
  if (!matchMedia) return () => {};
  let mql: MediaQueryList;
  try {
    mql = matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return () => {};
  }
  const handler = () => {
    onChange(mql.matches ? "dark" : "light");
  };
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }
  // Safari < 14
  const legacy = mql as MediaQueryList & {
    addListener?: (cb: () => void) => void;
    removeListener?: (cb: () => void) => void;
  };
  legacy.addListener?.(handler);
  return () => legacy.removeListener?.(handler);
}
