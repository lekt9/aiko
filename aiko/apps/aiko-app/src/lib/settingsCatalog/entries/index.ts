import type { SettingsEntry } from "../types";
import { ABOUT_ENTRIES } from "./about";
import { ACCOUNT_ENTRIES } from "./account";
import { APPEARANCE_ENTRIES } from "./appearance";
import { ARCHIVED_ENTRIES } from "./archived";
import { EXTENSIONS_ENTRIES } from "./extensions";
import { GENERAL_ENTRIES } from "./general";
import { REMOTE_IM_ENTRIES } from "./remoteIm";
import { RUNTIME_ENTRIES } from "./runtime";
import { SHORTCUTS_ENTRIES } from "./shortcuts";

/** Full registry of searchable settings (UI rows / cards). */
export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  ...GENERAL_ENTRIES,
  ...APPEARANCE_ENTRIES,
  ...ACCOUNT_ENTRIES,
  ...ARCHIVED_ENTRIES,
  ...EXTENSIONS_ENTRIES,
  ...RUNTIME_ENTRIES,
  ...REMOTE_IM_ENTRIES,
  ...SHORTCUTS_ENTRIES,
  ...ABOUT_ENTRIES,
];
