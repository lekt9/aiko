/** Canonical UI message catalog. Keys must stay stable; add all locales together. */

import { en, type MessageKey } from "./en";
import { zh } from "./zh";
import { zhTW } from "./zh-TW";

export type Locale = "zh" | "zh-TW" | "en";

export type { MessageKey };

export { en };

export const messages: Record<Locale, Record<MessageKey, string>> = {
  en: en as Record<MessageKey, string>,
  zh,
  "zh-TW": zhTW,
};

export function isLocale(v: string): v is Locale {
  return v === "zh" || v === "zh-TW" || v === "en";
}
