import type { SettingsEntry } from "../types";

/** Settings catalog entries — about section. */
export const ABOUT_ENTRIES: readonly SettingsEntry[] = [
  // ── about ──
  {
    id: "about.app",
    section: "about",
    anchorId: "settings-anchor-about",
    labelKey: "settings.aboutApp",
    keywords: ["about", "version", "update"],
  },
  {
    id: "about.tutorial",
    section: "about",
    anchorId: "settings-anchor-tutorial",
    labelKey: "tutorial.replay",
    descKeys: ["tutorial.replayDesc", "tutorial.menu"],
    keywords: [
      "tutorial",
      "product tour",
      "onboarding",
      "walkthrough",
      "help",
      "guide",
    ],
  },
  {
    id: "about.developerMode",
    section: "about",
    anchorId: "settings-anchor-developerMode",
    labelKey: "settings.developerMode",
    descKeys: ["settings.developerModeDesc"],
    keywords: [
      "developer",
      "dev mode",
      "debug",
      "simulate update",
      "开发模式",
      "开发者",
    ],
  },
  {
    id: "about.updateSim",
    section: "about",
    anchorId: "settings-anchor-updateSim",
    labelKey: "settings.updateSim",
    descKeys: ["settings.updateSimDesc"],
    keywords: [
      "simulate update",
      "fake update",
      "update badge",
      "sidebar update",
      "模拟更新",
    ],
  },
];
