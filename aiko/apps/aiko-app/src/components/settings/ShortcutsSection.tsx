/**
 * Settings → shortcuts section (consumes SettingsModel context).
 */
import { useSettingsModel } from "@/providers/SettingsModelContext";
import type { SettingsViewModel } from "./types";

import { ShortcutsSettingsPanel } from "./ShortcutsSettingsPanel";


export function ShortcutsSection() {
  const s = useSettingsModel() as SettingsViewModel & Record<string, any>;
  const {
    onOpenShortcutsHelp,
    t,
  } = s;

  return (
    <>
<div id="settings-anchor-shortcuts">
            <ShortcutsSettingsPanel
              t={t}
              onOpenHelp={onOpenShortcutsHelp}
            />
          </div>
    </>
  );
}
