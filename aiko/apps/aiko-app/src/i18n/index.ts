/**
 * App i18n helpers. All user-visible copy must go through `t()`.
 * See docs/llm-wiki/i18n.md for agent maintenance rules.
 */

import {
  isLocale,
  messages,
  type Locale,
  type MessageKey,
} from "./messages";

export type { Locale, MessageKey };
export { isLocale, messages };

/** User preference: explicit catalog locale or follow OS / browser language. */
export type LocalePreference = "system" | Locale;

export type Vars = Record<string, string | number | undefined | null>;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? "" : String(v);
  });
}

/** Translate a key for the given locale. Missing keys fall back to English then the key. */
export function t(locale: Locale, key: MessageKey, vars?: Vars): string {
  const table = messages[locale] ?? messages.en;
  const raw = table[key] ?? messages.en[key] ?? String(key);
  return interpolate(raw, vars);
}

export function createT(locale: Locale) {
  return (key: MessageKey, vars?: Vars) => t(locale, key, vars);
}

/**
 * Best-effort normalization of a raw locale id to a canonical {@link Locale}.
 * Accepts common case/alias variants (e.g. "zh-tw", "zh_Hant", "EN-US") so a
 * hand-edited settings value still resolves. Returns `null` when the id is not
 * a recognizable variant, leaving the fallback to the caller. Mirrors the
 * case-insensitive parsing on the Rust side (see tray_i18n.rs `Locale::parse`).
 */
function normalizeLocale(raw: string): Locale | null {
  const v = raw.trim().toLowerCase().replace(/_/g, "-");
  if (v === "zh-tw" || v === "zh-hant") {
    return "zh-TW";
  }
  if (v === "zh" || v === "zh-cn" || v === "zh-hans") {
    return "zh";
  }
  if (v === "en" || v === "en-us" || v === "en-gb") {
    return "en";
  }
  return null;
}

/**
 * Map a BCP-47 / OS language tag (e.g. `navigator.language`) to a catalog
 * {@link Locale}. Pure — no `navigator` access. Unknown or empty tags → `en`.
 *
 * Rules:
 * - Chinese + Traditional script/region (`Hant`, `TW`, `HK`, `MO`) → `zh-TW`
 * - Other Chinese (`zh`, `zh-CN`, `zh-Hans`, `zh-SG`, …) → `zh`
 * - English (`en`, `en-US`, …) → `en`
 * - Everything else → product default `en`
 */
export function resolveLocaleFromSystem(
  langTag: string | null | undefined,
): Locale {
  if (langTag == null) return "en";
  const v = String(langTag).trim().toLowerCase().replace(/_/g, "-");
  if (!v) return "en";

  // Strip encoding suffix from POSIX tags: "zh_CN.UTF-8" → already "_"→"-",
  // still may have ".utf-8".
  const bare = v.split(".")[0] ?? v;
  const primary = bare.split("-")[0] ?? bare;

  if (primary === "zh") {
    // Script subtag or region for Traditional Chinese.
    const parts = bare.split("-");
    if (
      parts.includes("hant") ||
      parts.includes("tw") ||
      parts.includes("hk") ||
      parts.includes("mo")
    ) {
      return "zh-TW";
    }
    return "zh";
  }

  if (primary === "en") return "en";

  return normalizeLocale(bare) ?? "en";
}

export function isLocalePreference(v: unknown): v is LocalePreference {
  return v === "system" || (typeof v === "string" && isLocale(v));
}

/**
 * Parse a durable settings value into a {@link LocalePreference}.
 * Accepts `system`, canonical locales, and common aliases. Invalid → `en`.
 */
export function parseLocalePreference(
  raw: string | null | undefined,
): LocalePreference {
  if (raw == null) return "en";
  const trimmed = String(raw).trim();
  if (!trimmed) return "en";
  if (trimmed.toLowerCase() === "system") return "system";
  if (isLocale(trimmed)) return trimmed;
  return normalizeLocale(trimmed) ?? "en";
}

/**
 * Resolve a user preference to a concrete catalog locale.
 * When preference is `system`, maps `systemLangTag` (or `navigator.language`
 * when available) via {@link resolveLocaleFromSystem}.
 */
export function resolveLocalePreference(
  preference: LocalePreference,
  systemLangTag?: string | null,
): Locale {
  if (preference !== "system") return preference;
  const tag =
    systemLangTag !== undefined
      ? systemLangTag
      : typeof navigator !== "undefined"
        ? navigator.language
        : null;
  return resolveLocaleFromSystem(tag);
}

/**
 * Resolve a stored settings locale string to a concrete catalog locale.
 * `"system"` follows OS / browser language; explicit ids stay as-is.
 */
export function resolveLocale(raw: string | undefined | null): Locale {
  if (!raw) return "en";
  if (raw.trim().toLowerCase() === "system") {
    return resolveLocalePreference("system");
  }
  if (isLocale(raw)) return raw;
  return normalizeLocale(raw) ?? "en";
}
