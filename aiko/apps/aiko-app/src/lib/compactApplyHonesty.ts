/**
 * Compact apply-path + preset honesty.
 *
 * Product truth:
 * - Manual `/compact` is a slash turn on a live agent (`next_turn`).
 * - Compaction mode/detail are spawn flags (CLI ≥ 0.2.117). Changing them
 *   soft-respawns a live agent so the next turn reloads flags; idle prefs
 *   wait for the next spawn (`idle`).
 * - Older / unknown CLI versions do not get flags (`unsupported` — env
 *   soft-fail only). `/compact` may still run with agent defaults.
 * - Intensity presets (light / standard / aggressive) seed **keep-note
 *   templates** only — CLI has no intensity flag.
 * - Token savings are reported only when both before and after are known
 *   finite numbers. Never invent savings from estimates alone.
 *
 * Pure helpers — no I/O. UI translates returned message keys via `t()`.
 */

import {
  DEFAULT_COMPACT_PRESET,
  isCompactPresetId,
  type CompactPresetId,
} from "./contextUsage";
import {
  compactionDetailApplies,
  normalizeCompactionDetail,
  normalizeCompactionMode,
  type CompactionDetailId,
  type CompactionModeId,
} from "./compactionMode";

/** How compact / compaction mode take effect. */
export type CompactApplyEffect =
  | "next_turn"
  | "soft_respawn"
  | "unsupported"
  | "idle";

/** Banner payload: i18n key + interpolation vars (caller runs `t()`). */
export type CompactHonestyBanner = {
  messageKey: string;
  vars: Record<string, string>;
};

/**
 * Session states that mean a live ACP agent process is attached
 * (can receive `/compact` / is subject to soft-respawn).
 */
const LIVE_AGENT_STATES = new Set([
  "ready",
  "streaming",
  "awaiting_permission",
]);

/**
 * True when the session snapshot state indicates a live agent process.
 * Pure: accepts free-form state strings from SessionState / live map.
 */
export function sessionHasLiveAgent(
  state: string | null | undefined,
): boolean {
  if (state == null) return false;
  return LIVE_AGENT_STATES.has(String(state).trim().toLowerCase());
}

/**
 * Resolve when compact / compaction mode apply.
 *
 * Matrix:
 * | hasLiveAgent | cliSupportsFlags | forSettingsChange | effect        |
 * | false        | *                | *                 | idle          |
 * | true         | false            | *                 | unsupported   |
 * | true         | true             | true              | soft_respawn  |
 * | true         | true             | false / omitted   | next_turn     |
 *
 * - `idle`: no live agent — mode prefs wait for next spawn; `/compact` needs connect
 * - `unsupported`: live agent but CLI lacks compaction flags (old/unknown version)
 * - `soft_respawn`: mode/detail *change* soft-respawns the live agent
 * - `next_turn`: `/compact` runs as an agent turn with current spawn mode
 */
export function resolveCompactApplyEffect(input: {
  hasLiveAgent: boolean;
  cliSupportsFlags: boolean;
  /** When true, answer “when does a mode/detail *change* apply?” */
  forSettingsChange?: boolean;
}): CompactApplyEffect {
  if (!input.hasLiveAgent) return "idle";
  if (!input.cliSupportsFlags) return "unsupported";
  if (input.forSettingsChange) return "soft_respawn";
  return "next_turn";
}

/** Stable i18n key for a compact apply effect (dialog footer). */
export function compactApplyEffectMessageKey(
  effect: CompactApplyEffect,
): string {
  switch (effect) {
    case "next_turn":
      return "slash.compactApply.nextTurn";
    case "soft_respawn":
      return "slash.compactApply.softRespawn";
    case "unsupported":
      return "slash.compactApply.unsupported";
    case "idle":
      return "slash.compactApply.idle";
  }
}

/** Stable i18n key for settings mode/detail apply honesty. */
export function compactSettingsApplyMessageKey(
  effect: CompactApplyEffect,
): string {
  switch (effect) {
    case "soft_respawn":
      return "settings.compactionApply.softRespawn";
    case "idle":
      return "settings.compactionApply.nextSpawn";
    case "unsupported":
      return "settings.compactionApply.unsupported";
    case "next_turn":
      // Settings change never maps here; fall back to next-spawn copy.
      return "settings.compactionApply.nextSpawn";
  }
}

/**
 * Map a compact intensity preset to its keep-note template i18n key.
 * Unknown / empty → standard. Does not invent CLI intensity flags.
 */
export function buildCompactPresetNote(preset: unknown): {
  preset: CompactPresetId;
  messageKey:
    | "slash.compactPresetNote.light"
    | "slash.compactPresetNote.standard"
    | "slash.compactPresetNote.aggressive";
} {
  const id: CompactPresetId = isCompactPresetId(preset)
    ? preset
    : DEFAULT_COMPACT_PRESET;
  if (id === "light") {
    return { preset: id, messageKey: "slash.compactPresetNote.light" };
  }
  if (id === "aggressive") {
    return { preset: id, messageKey: "slash.compactPresetNote.aggressive" };
  }
  return { preset: "standard", messageKey: "slash.compactPresetNote.standard" };
}

function finiteToken(n: number | null | undefined): number | null {
  if (n == null) return null;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.floor(n);
}

/** Dialog honesty payload for mode/detail + optional known token pair. */
export type CompactDialogHonesty = {
  mode: CompactionModeId;
  detail: CompactionDetailId;
  /** Detail only affects segments mode. */
  detailApplies: boolean;
  tokensBefore: number | null;
  tokensAfter: number | null;
  /**
   * `before - after` only when both sides are known finite numbers.
   * Never invented from estimates alone. May be negative (honest growth).
   */
  tokensSaved: number | null;
  hasKnownSavings: boolean;
  modeLabelKey: string;
  detailLabelKey: string | null;
  /** Savings line key — known pair vs unknown. */
  savingsMessageKey: string;
  savingsVars: Record<string, string>;
};

/**
 * Resolve compact dialog honesty for the selected mode/detail and optional
 * known token counts. Never invents token savings without both numbers.
 */
export function resolveCompactDialogHonesty(input: {
  mode: unknown;
  detail: unknown;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
}): CompactDialogHonesty {
  const mode = normalizeCompactionMode(input.mode);
  const detail = normalizeCompactionDetail(input.detail);
  const detailApplies = compactionDetailApplies(mode);
  const tokensBefore = finiteToken(input.tokensBefore);
  const tokensAfter = finiteToken(input.tokensAfter);

  let tokensSaved: number | null = null;
  if (tokensBefore != null && tokensAfter != null) {
    tokensSaved = tokensBefore - tokensAfter;
  }
  const hasKnownSavings = tokensSaved != null;

  const modeLabelKey =
    mode === "transcript"
      ? "settings.compactionMode.transcript"
      : mode === "segments"
        ? "settings.compactionMode.segments"
        : "settings.compactionMode.summary";

  let detailLabelKey: string | null = null;
  if (detailApplies) {
    detailLabelKey =
      detail === "none"
        ? "settings.compactionDetail.none"
        : detail === "minimal"
          ? "settings.compactionDetail.minimal"
          : detail === "balanced"
            ? "settings.compactionDetail.balanced"
            : "settings.compactionDetail.verbose";
  }

  const savingsVars: Record<string, string> = {};
  if (hasKnownSavings && tokensBefore != null && tokensAfter != null) {
    savingsVars.before = String(tokensBefore);
    savingsVars.after = String(tokensAfter);
    savingsVars.saved = String(tokensSaved);
  }

  return {
    mode,
    detail,
    detailApplies,
    tokensBefore,
    tokensAfter,
    tokensSaved,
    hasKnownSavings,
    modeLabelKey,
    detailLabelKey,
    savingsMessageKey: hasKnownSavings
      ? "slash.compactApply.savingsKnown"
      : "slash.compactApply.savingsUnknown",
    savingsVars,
  };
}

/**
 * Footer honesty lines for the compact dialog (apply path + mode + savings).
 * Pure — caller translates keys. `cliSupportsFlags` should come from
 * {@link cliSupportsCompactionFlags} (unknown version → false).
 */
export function buildCompactDialogFooter(input: {
  hasLiveAgent: boolean;
  cliSupportsFlags: boolean;
  mode: unknown;
  detail: unknown;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
}): {
  apply: CompactHonestyBanner;
  mode: CompactHonestyBanner;
  savings: CompactHonestyBanner;
  dialog: CompactDialogHonesty;
} {
  const effect = resolveCompactApplyEffect({
    hasLiveAgent: input.hasLiveAgent,
    cliSupportsFlags: input.cliSupportsFlags,
  });
  const dialog = resolveCompactDialogHonesty({
    mode: input.mode,
    detail: input.detail,
    tokensBefore: input.tokensBefore,
    tokensAfter: input.tokensAfter,
  });

  const modeVars: Record<string, string> = { mode: dialog.mode };
  if (dialog.detailApplies) {
    modeVars.detail = dialog.detail;
  }

  return {
    apply: {
      messageKey: compactApplyEffectMessageKey(effect),
      vars: {},
    },
    mode: {
      messageKey: dialog.detailApplies
        ? "slash.compactApply.modeDetail"
        : "slash.compactApply.modeOnly",
      vars: modeVars,
    },
    savings: {
      messageKey: dialog.savingsMessageKey,
      vars: dialog.savingsVars,
    },
    dialog,
  };
}
